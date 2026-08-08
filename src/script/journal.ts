import { createHash, randomBytes } from "node:crypto"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { WorkflowMeta } from "./meta.js"

/** Line 0 of a run journal: identity of the run the entries belong to. */
export interface JournalHeader {
  runId: string
  scriptHash: string
  /**
   * sha256 of the run's `args`, recorded for diagnostics. It does NOT gate
   * resume: args reach a child session only through the prompt or the hashed
   * call options, so an arg change that matters already surfaces as a hash
   * miss. A mismatch only means the run logs a note and expects fewer cache
   * hits, matching Claude Code, which keys its cache on script + args and
   * treats a mismatch as a lower hit rate rather than a failure.
   */
  argsHash?: string
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

/** Stable hash of a run's `args`; key order never changes the digest. */
export function hashArgs(args: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(args)) ?? "undefined").digest("hex")
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value !== "object" || value === null) return value
  const record = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) sorted[key] = canonicalize(record[key])
  return sorted
}

/**
 * Identity of an agent() call for resume replay: sha256 over the prompt and
 * the behaviorally significant call options. Options with no effect on the
 * result are stripped so changing them cannot bust the replay cache: `label`
 * (cosmetic), and `isolation` unless it is "worktree". `effort` is NOT
 * stripped - it selects the model variant, i.e. the reasoning budget, so
 * changing it genuinely changes the request. Keys are sorted so option order
 * never matters.
 *
 * The isolation rule now only ever sees "worktree" or undefined, since agent()
 * rejects anything else. It is kept for journals written before that rejection
 * existed: a user who deletes a now-rejected `isolation: "remote"` and resumes
 * still hash-matches the old journal and replays the whole prefix.
 *
 * THE STRIP-LIST IS LOAD-BEARING beyond cache hit rate. Resume no longer
 * refuses a journal written for different args, and the reason that is safe is
 * that everything determining a child session's behavior is hashed here: an
 * arg can only reach a subagent through the prompt or one of these options, so
 * an arg change that matters cannot hash-match. Stripping a NEW option that
 * does affect the result, or adding another route from args to the subagent,
 * would silently break that argument. `agentType` is hashed RAW, before the
 * Claude Code alias table in agent-alias.ts rewrites it, so an existing journal
 * keeps replaying and a later edit to that table cannot bust it.
 */
export function hashAgentCall(prompt: string, opts: Record<string, unknown>): string {
  const rest: Record<string, unknown> = {}
  for (const key of Object.keys(opts).sort()) {
    if (key === "label") continue
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
  const directory = dirname(path)
  await mkdir(directory, { recursive: true })
  // Journals live inside the user's repo so a resume works from the same
  // checkout. Self-ignore the directory so an agent with edit access never
  // stages them and they never show up in git status.
  await writeFile(join(directory, ".gitignore"), "*\n", { encoding: "utf8", flag: "wx" }).catch(() => {})
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

export interface LoadedJournal {
  header: JournalHeader | undefined
  entries: JournalEntry[]
}

/**
 * Load a prior run's journal for replay, in seq order, together with its
 * header. Malformed lines are skipped so a journal truncated by a crash still
 * yields its intact prefix.
 */
export async function loadJournal(
  workingDirectory: string,
  runId: string,
): Promise<LoadedJournal> {
  const path = journalPath(workingDirectory, runId)
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    throw new Error(`No journal found for run "${runId}" (looked at ${path}).`)
  }
  const lines = raw.split("\n")
  const entries: JournalEntry[] = []
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim()
    if (!line) continue
    const parsed = parseLine(line)
    if (typeof parsed !== "object" || parsed === null) continue
    const entry = parsed as JournalEntry
    if (typeof entry.seq !== "number" || typeof entry.hash !== "string") continue
    entries.push(entry)
  }
  entries.sort((a, b) => a.seq - b.seq)
  const header = parseLine(lines[0]?.trim() ?? "") as JournalHeader | undefined
  return { header: header ?? undefined, entries }
}

/** Entries only, for callers that do not need the header. */
export async function loadJournalEntries(
  workingDirectory: string,
  runId: string,
): Promise<JournalEntry[]> {
  return (await loadJournal(workingDirectory, runId)).entries
}

function parseLine(line: string): unknown {
  if (!line) return undefined
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/**
 * Replay cursor over a loaded journal.
 *
 * Matching is by call HASH, not by seq. seq is assigned when agent() is
 * invoked, so under parallel()/pipeline() it follows real completion timing:
 * keying on it made an unedited script re-run agents on resume purely because
 * two concurrent lanes finished in a different order, breaking Claude Code's
 * "same script + same args = 100% cache hit" guarantee. Duplicate identical
 * calls still replay in journal order, because entries with the same hash are
 * consumed oldest-first.
 *
 * The prefix rule survives: a call whose hash is absent from the unconsumed
 * entries is new or edited, and switches the run permanently to live mode, so
 * everything after the first changed call runs live.
 */
export interface ReplayState {
  take(hash: string): { result: unknown } | undefined
}

export function createReplayState(entries: JournalEntry[]): ReplayState {
  const byHash = new Map<string, JournalEntry[]>()
  for (const entry of entries) {
    const bucket = byHash.get(entry.hash)
    if (bucket) bucket.push(entry)
    else byHash.set(entry.hash, [entry])
  }
  let live = false
  return {
    take(hash) {
      if (live) return undefined
      const bucket = byHash.get(hash)
      const entry = bucket?.shift()
      if (!entry) {
        live = true
        return undefined
      }
      return { result: entry.result }
    },
  }
}
