export interface ProgressUpdate {
  title?: string
  metadata?: Record<string, unknown>
}

export type ProgressSink = (update: ProgressUpdate) => void

export interface WorkflowProgressInput {
  name: string
  /** Phase titles known up front (meta.phases); rendered as pending until reached. */
  plannedPhases?: string[]
  sink: ProgressSink
  /** Minimum ms between sink calls; a trailing flush always lands. */
  throttleMs?: number
}

type PhaseStatus = "pending" | "active" | "done"

interface PhaseState {
  title: string
  status: PhaseStatus
  running: Map<number, string>
  completed: number
  failed: number
}

interface AgentEvent {
  id: number
  label: string
  phase?: string
}

const DEFAULT_THROTTLE_MS = 250
const MAX_LOGS = 5
const FALLBACK_PHASE = "Agents"

/**
 * Tracks phases and agents for a running workflow and streams a rendered
 * roadmap (Claude Code-style progress tree) through a sink - in OpenCode the
 * sink is ToolContext.metadata, which the TUI re-renders live.
 */
export class WorkflowProgress {
  private readonly name: string
  private readonly sink: ProgressSink
  private readonly throttleMs: number
  private readonly phases: PhaseState[] = []
  private readonly logs: string[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastFlush = 0
  private dirty = false
  private finished: string | undefined
  private current: PhaseState | undefined
  private closed = false

  constructor(input: WorkflowProgressInput) {
    this.name = input.name
    this.sink = input.sink
    this.throttleMs = input.throttleMs ?? DEFAULT_THROTTLE_MS
    for (const title of input.plannedPhases ?? []) {
      this.ensurePhase(title)
    }
  }

  phase(title: string): void {
    const entered = this.ensurePhase(title)
    for (const phase of this.phases) {
      if (phase === entered) break
      if (phase.status !== "pending" && phase.running.size === 0) {
        phase.status = "done"
      }
    }
    entered.status = "active"
    this.current = entered
    this.schedule()
  }

  agentStart(event: AgentEvent): void {
    const phase = this.ensurePhase(event.phase ?? this.activePhaseTitle())
    if (phase.status === "pending") phase.status = "active"
    if (!this.current) this.current = phase
    phase.running.set(event.id, event.label)
    this.schedule()
  }

  agentEnd(event: AgentEvent & { ok: boolean }): void {
    const phase = this.ensurePhase(event.phase ?? this.activePhaseTitle())
    phase.running.delete(event.id)
    if (event.ok) phase.completed += 1
    else phase.failed += 1
    // A drained phase that the workflow has already moved past is finished;
    // without this it would stay "active" (and shown as current) forever.
    if (phase.status === "active" && phase.running.size === 0 && this.current && this.current !== phase) {
      phase.status = "done"
    }
    this.schedule()
  }

  log(message: string): void {
    this.logs.push(message)
    if (this.logs.length > MAX_LOGS) this.logs.shift()
    this.schedule()
  }

  finish(status: string): void {
    if (this.closed) return
    this.finished = status
    for (const phase of this.phases) {
      if (phase.status === "active" && phase.running.size === 0) {
        phase.status = "done"
      }
    }
    this.flush()
    // Straggler events (orphaned agents ending after a script failure) must
    // not re-invoke the sink once the tool call has returned.
    this.closed = true
  }

  renderRoadmap(): string {
    const lines: string[] = []
    for (const phase of this.phases) {
      const marker = phase.status === "done" ? "[x]" : phase.status === "active" ? "[>]" : "[ ]"
      const counts: string[] = []
      if (phase.completed > 0) counts.push(`${phase.completed} done`)
      if (phase.running.size > 0) counts.push(`${phase.running.size} running`)
      if (phase.failed > 0) counts.push(`${phase.failed} failed`)
      lines.push(`${marker} ${phase.title}${counts.length > 0 ? ` - ${counts.join(", ")}` : ""}`)
      for (const label of phase.running.values()) {
        lines.push(`      * ${label}`)
      }
    }
    for (const log of this.logs) {
      lines.push(`  log: ${log}`)
    }
    if (this.finished) {
      lines.push(`  => ${this.finished}`)
    }
    return lines.join("\n")
  }

  renderTitle(): string {
    if (this.finished) {
      return `Workflow ${this.name}: ${this.finished}`
    }
    const active = this.phases.find((phase) => phase.status === "active")
    if (!active) return `Workflow ${this.name}`
    const position = this.phases.indexOf(active) + 1
    const stats = `${active.completed} done` + (active.running.size > 0 ? `, ${active.running.size} running` : "")
    return `Workflow ${this.name} > ${active.title} (${position}/${this.phases.length}: ${stats})`
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.dirty = false
    this.lastFlush = Date.now()
    this.sink({
      title: this.renderTitle(),
      metadata: {
        roadmap: this.renderRoadmap(),
        phases: this.phases.map((phase) => ({
          title: phase.title,
          status: phase.status,
          completed: phase.completed,
          running: phase.running.size,
          failed: phase.failed,
        })),
        logs: [...this.logs],
        ...(this.finished ? { status: this.finished } : {}),
      },
    })
  }

  private ensurePhase(title: string): PhaseState {
    const existing = this.phases.find((phase) => phase.title === title)
    if (existing) return existing
    const created: PhaseState = {
      title,
      status: "pending",
      running: new Map(),
      completed: 0,
      failed: 0,
    }
    this.phases.push(created)
    return created
  }

  private activePhaseTitle(): string {
    for (let index = this.phases.length - 1; index >= 0; index -= 1) {
      const phase = this.phases[index]
      if (phase && phase.status === "active") return phase.title
    }
    return FALLBACK_PHASE
  }

  private schedule(): void {
    if (this.closed) return
    if (this.throttleMs <= 0) {
      this.flush()
      return
    }
    const elapsed = Date.now() - this.lastFlush
    if (elapsed >= this.throttleMs) {
      this.flush()
      return
    }
    this.dirty = true
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        if (this.dirty) this.flush()
      }, this.throttleMs - elapsed)
    }
  }
}
