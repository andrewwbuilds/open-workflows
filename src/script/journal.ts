import { createHash, randomBytes } from "node:crypto"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { WorkflowMeta } from "./meta.js"

/** Line 0 of a run journal: identity of the run the entries belong to. */
export interface JournalHeader {
  runId: string
  scriptHash: string
  meta: WorkflowMeta
}

/** One journaled agent() call; `result` is exactly what the script received. */
export interface JournalEntry {
  seq: number
  hash: string
  label: string
  phase?: string
  result: unknown
}

const RUN_ID_PATTERN = /^wf_[A-Za-z0-9]+$/

/** Generate a run id outside the script sandbox: "wf_" + random hex suffix. */
export function generateRunId(): string {
  return `wf_${randomBytes(8).toString("hex")}`
}

export function journalPath(workingDirectory: string, runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Invalid run id "${runId}". Expected "wf_" followed by an alphanumeric suffix.`)
  }
  return join(workingDirectory, ".opencode", "workflow-runs", `${runId}.jsonl`)
}

export function hashScript(script: string): string {
  return createHash("sha256").update(script).digest("hex")
}

/**
 * Identity of an agent() call for resume replay: sha256 over the prompt and
 * the behaviorally significant call options. Options with no effect on the
 * result are stripped so changing them cannot bust the replay cache: `label`
 * (cosmetic), `effort` (accepted but ignored), and `isolation` unless it is
 * "worktree" (the only value that changes behavior). Keys are sorted so
 * option order never matters.
 */
export function hashAgentCall(prompt: string, opts: Record<string, unknown>): string {
  const rest: Record<string, unknown> = {}
  for (const key of Object.keys(opts).sort()) {
    if (key === "label" || key === "effort") continue
    if (key === "isolation" && opts[key] !== "worktree") continue
    if (opts[key] === undefined) continue
    rest[key] = opts[key]
  }
  return createHash("sha256").update(JSON.stringify({ prompt, opts: rest })).digest("hex")
}

/**
 * Append-only writer for a run journal. Writes are chained so lines never
 * interleave; call flush() to wait for everything queued so far.
 */
export interface JournalWriter {
  append(entry: JournalEntry): void
  flush(): Promise<void>
}

/** Create the journal file (and its directories) with the header as line 0. */
export async function createJournalWriter(
  workingDirectory: string,
  header: JournalHeader,
): Promise<JournalWriter> {
  const path = journalPath(workingDirectory, header.runId)
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, JSON.stringify(header) + "\n", "utf8")
  let chain: Promise<void> = Promise.resolve()
  return {
    append(entry) {
      // A failed append must not poison the chain or fail the run: the journal
      // is a recovery aid, so later entries still get their chance to land.
      chain = chain
        .then(() => appendFile(path, JSON.stringify(entry) + "\n", "utf8"))
        .catch(() => {})
    },
    flush() {
      return chain
    },
  }
}

/**
 * Load a prior run's journal for replay, indexed by seq. Malformed lines are
 * skipped so a journal truncated by a crash still yields its intact prefix.
 */
export async function loadJournalEntries(
  workingDirectory: string,
  runId: string,
): Promise<Map<number, JournalEntry>> {
  const path = journalPath(workingDirectory, runId)
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    throw new Error(`No journal found for run "${runId}" (looked at ${path}).`)
  }
  const entries = new Map<number, JournalEntry>()
  const lines = raw.split("\n")
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim()
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof parsed !== "object" || parsed === null) continue
    const entry = parsed as JournalEntry
    if (typeof entry.seq !== "number" || typeof entry.hash !== "string") continue
    entries.set(entry.seq, entry)
  }
  return entries
}

/**
 * Replay cursor over a loaded journal: agent() calls consume entries by
 * (seq, hash) as long as the prefix is unchanged; the first mismatch (or any
 * seq beyond the journal) switches the run permanently to live mode.
 */
export interface ReplayState {
  take(seq: number, hash: string): { result: unknown } | undefined
}

export function createReplayState(entries: Map<number, JournalEntry>): ReplayState {
  let live = false
  return {
    take(seq, hash) {
      if (live) return undefined
      const entry = entries.get(seq)
      if (!entry || entry.hash !== hash) {
        live = true
        return undefined
      }
      return { result: entry.result }
    },
  }
}
