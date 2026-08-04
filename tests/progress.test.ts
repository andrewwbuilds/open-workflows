import { describe, expect, it } from "vitest"
import { WorkflowProgress, type ProgressUpdate } from "../src/progress.js"

function collectingProgress(plannedPhases?: string[]): {
  progress: WorkflowProgress
  updates: ProgressUpdate[]
} {
  const updates: ProgressUpdate[] = []
  const progress = new WorkflowProgress({
    name: "test-wf",
    plannedPhases,
    throttleMs: 0,
    sink: (update) => updates.push(update),
  })
  return { progress, updates }
}

function lastRoadmap(updates: ProgressUpdate[]): string {
  const last = updates[updates.length - 1]
  return (last?.metadata?.roadmap as string) ?? ""
}

describe("WorkflowProgress", () => {
  it("renders planned phases as pending until reached", () => {
    const { progress, updates } = collectingProgress(["Scan", "Fix", "Verify"])
    progress.phase("Scan")
    const roadmap = lastRoadmap(updates)
    expect(roadmap).toContain("[>] Scan")
    expect(roadmap).toContain("[ ] Fix")
    expect(roadmap).toContain("[ ] Verify")
  })

  it("tracks running agents under their phase and shows labels", () => {
    const { progress, updates } = collectingProgress(["Scan"])
    progress.phase("Scan")
    progress.agentStart({ id: 1, label: "scan: src/a.ts", phase: "Scan" })
    let roadmap = lastRoadmap(updates)
    expect(roadmap).toContain("[>] Scan - 1 running")
    expect(roadmap).toContain("* scan: src/a.ts")
    progress.agentEnd({ id: 1, label: "scan: src/a.ts", phase: "Scan", ok: true })
    roadmap = lastRoadmap(updates)
    expect(roadmap).toContain("[>] Scan - 1 done")
    expect(roadmap).not.toContain("* scan: src/a.ts")
  })

  it("marks earlier phases done when a later phase starts", () => {
    const { progress, updates } = collectingProgress(["Scan", "Fix"])
    progress.phase("Scan")
    progress.agentStart({ id: 1, label: "a", phase: "Scan" })
    progress.agentEnd({ id: 1, label: "a", phase: "Scan", ok: true })
    progress.phase("Fix")
    const roadmap = lastRoadmap(updates)
    expect(roadmap).toContain("[x] Scan - 1 done")
    expect(roadmap).toContain("[>] Fix")
  })

  it("counts failures separately", () => {
    const { progress, updates } = collectingProgress()
    progress.phase("Work")
    progress.agentStart({ id: 1, label: "a" })
    progress.agentEnd({ id: 1, label: "a", ok: false })
    expect(lastRoadmap(updates)).toContain("1 failed")
  })

  it("assigns phaseless agents to the active phase, falling back to Agents", () => {
    const { progress, updates } = collectingProgress()
    progress.agentStart({ id: 1, label: "orphan" })
    expect(lastRoadmap(updates)).toContain("[>] Agents - 1 running")
  })

  it("creates ad-hoc phases for events naming unknown phases", () => {
    const { progress, updates } = collectingProgress(["Scan"])
    progress.agentStart({ id: 1, label: "x", phase: "Surprise" })
    expect(lastRoadmap(updates)).toContain("[>] Surprise - 1 running")
  })

  it("keeps only the last five logs", () => {
    const { progress, updates } = collectingProgress()
    for (let index = 1; index <= 7; index += 1) {
      progress.log(`line ${index}`)
    }
    const roadmap = lastRoadmap(updates)
    expect(roadmap).not.toContain("line 2")
    expect(roadmap).toContain("line 3")
    expect(roadmap).toContain("line 7")
  })

  it("renders a live title with phase position and counts", () => {
    const { progress, updates } = collectingProgress(["Scan", "Fix"])
    progress.phase("Fix")
    progress.agentStart({ id: 1, label: "a", phase: "Fix" })
    const title = updates[updates.length - 1]?.title ?? ""
    expect(title).toContain("test-wf")
    expect(title).toContain("Fix")
    expect(title).toContain("2/2")
    expect(title).toContain("1 running")
  })

  it("finish() closes idle phases and stamps the status", () => {
    const { progress, updates } = collectingProgress(["Scan"])
    progress.phase("Scan")
    progress.agentStart({ id: 1, label: "a", phase: "Scan" })
    progress.agentEnd({ id: 1, label: "a", phase: "Scan", ok: true })
    progress.finish("completed")
    const last = updates[updates.length - 1]
    expect(last?.title).toContain("completed")
    expect((last?.metadata?.roadmap as string)).toContain("[x] Scan")
    expect(last?.metadata?.status).toBe("completed")
  })

  it("exposes structured phase state in metadata", () => {
    const { progress, updates } = collectingProgress(["Scan"])
    progress.phase("Scan")
    progress.agentStart({ id: 1, label: "a", phase: "Scan" })
    const phases = updates[updates.length - 1]?.metadata?.phases as Array<Record<string, unknown>>
    expect(phases).toEqual([
      { title: "Scan", status: "active", completed: 0, running: 1, failed: 0 },
    ])
  })

  it("throttles sink calls when throttleMs is set", async () => {
    const updates: ProgressUpdate[] = []
    const progress = new WorkflowProgress({
      name: "throttled",
      throttleMs: 50,
      sink: (update) => updates.push(update),
    })
    progress.phase("A")
    progress.log("one")
    progress.log("two")
    progress.log("three")
    const immediate = updates.length
    expect(immediate).toBeLessThan(4)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(updates.length).toBeGreaterThan(immediate)
    expect(lastRoadmap(updates)).toContain("three")
  })
})
