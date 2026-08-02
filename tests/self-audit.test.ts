import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(".")

interface Issue {
  severity: "high" | "medium" | "low"
  file: string
  message: string
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

describe("self-audit", () => {
  const files = walk(ROOT)
  const issues: Issue[] = []

  for (const file of files) {
    if (!file.endsWith(".ts") || file.includes("tests/") || file.includes("dist/")) continue
    const text = readFileSync(file, "utf8")
    const rel = file.replace(ROOT + "/", "")

    if (text.includes("Promise.race") && text.includes("inFlight")) {
      issues.push({ severity: "low", file: rel, message: "Promise.race over a mutating array is a fragile pattern." })
    }

    if (text.includes("TODO") || text.includes("FIXME") || text.includes("XXX")) {
      issues.push({ severity: "low", file: rel, message: "Leftover TODO/FIXME/XXX marker." })
    }

    if (text.match(/console\.log/) && !rel.startsWith("scripts/") && !rel.includes("install-assets")) {
      issues.push({ severity: "medium", file: rel, message: "console.log outside scripts — should use client.app.log or be removed." })
    }
  }

  it("flags only the expected issues", () => {
    expect(issues).toEqual([])
  })

  it("every src file imports from correct relative paths", () => {
    for (const file of files) {
      if (!file.endsWith(".ts")) continue
      if (file.includes("node_modules") || file.includes("dist") || file.includes("tests")) continue
      const text = readFileSync(file, "utf8")
      const bad = text.match(/from ["']\.\.\/types(?!\.js)["']/)
      expect.soft(bad, `${file} should import from ../types.js`).toBeNull()
    }
  })
})