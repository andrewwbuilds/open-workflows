import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
  main?: string
  exports?: Record<string, { types?: string; import?: string }>
  dependencies?: Record<string, string>
  files?: string[]
  engines?: Record<string, string>
  scripts?: Record<string, string>
}

/**
 * OpenCode resolves a plugin's entrypoint by checking `exports["./server"]`
 * first and falling back to `package.json.main`. A package that declares an
 * `exports` map with neither is skipped at load time with only a warning, so
 * these assertions guard against a silent "plugin never loads" regression.
 */
describe("OpenCode plugin entrypoint resolution", () => {
  it("exposes a ./server subpath export", () => {
    expect(pkg.exports?.["./server"]?.import).toBe("./dist/server.js")
    expect(pkg.exports?.["./server"]?.types).toBe("./dist/server.d.ts")
  })

  it("declares main as the fallback entrypoint for older loaders", () => {
    expect(pkg.main).toBe("./dist/server.js")
  })

  /**
   * OpenCode's TUI loader resolves `exports["./tui"]` and has NO `main`
   * fallback, so dropping this subpath silently removes the subagent viewer
   * while leaving the tools working - the failure mode is a missing command,
   * not a load error.
   */
  it("exposes a ./tui subpath export for the subagent viewer", () => {
    expect(pkg.exports?.["./tui"]?.import).toBe("./dist/tui.js")
    expect(pkg.exports?.["./tui"]?.types).toBe("./dist/tui.d.ts")
  })

  it("keeps the library subpath separate from the server entry", () => {
    expect(pkg.exports?.["."]?.import).toBe("./dist/index.js")
  })

  it("declares a supported opencode engine range", () => {
    expect(pkg.engines?.opencode).toBeTruthy()
  })
})

describe("server entry module shape", () => {
  it("default-exports a v2 PluginModule with id and server", async () => {
    const mod = await import("../src/server.js")
    expect(mod.default).toBeTypeOf("object")
    expect(mod.default.id).toBe("open-workflows")
    expect(mod.default.server).toBeTypeOf("function")
  })

  it("exports nothing but the default", async () => {
    // OpenCode's legacy loader invokes every exported *function* of a plugin
    // entry as a plugin factory. Extra exports here would make it call library
    // helpers (runWorkflow, createDynamicWorkflowTool, ...) as plugins.
    const mod = await import("../src/server.js")
    expect(Object.keys(mod)).toEqual(["default"])
  })
})

describe("runtime dependencies", () => {
  it("declares every package imported at runtime by src/", () => {
    // zod resolved only via hoisting from @opencode-ai/plugin before this was
    // declared, which breaks under a different hoisting layout.
    expect(pkg.dependencies?.zod).toBeTruthy()
    expect(pkg.dependencies?.["@opencode-ai/plugin"]).toBeTruthy()
  })

  it("builds before packing so dist/ is never published stale or missing", () => {
    // dist/ is gitignored, so a pack from a clean checkout without this ships
    // a package whose exports point at files that do not exist.
    expect(pkg.scripts?.prepack).toContain("build")
  })

  it("ships the asset directories the config hook reads", () => {
    expect(pkg.files).toContain("agents")
    expect(pkg.files).toContain("commands")
    expect(pkg.files).toContain("dist")
  })
})
