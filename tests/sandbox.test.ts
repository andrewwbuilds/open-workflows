import { describe, expect, it } from "vitest"
import { runWorkflowScript, WorkflowScriptError } from "../src/script/engine.js"
import type {
  RunChildSessionInput,
  RunChildSessionResult,
  SessionRunner,
} from "../src/runtime/types.js"

function scriptedRunner(
  respond: (input: RunChildSessionInput, runIndex: number) => string | Partial<RunChildSessionResult>,
): SessionRunner & { runs: RunChildSessionInput[] } {
  const runs: RunChildSessionInput[] = []
  let counter = 0
  return {
    runs,
    async createChildSession() {
      counter += 1
      return { sessionID: `s-${counter}` }
    },
    async runChildSession(input) {
      const index = runs.length
      runs.push(input)
      const response = respond(input, index)
      const base: RunChildSessionResult = { text: "", sessionID: input.sessionID }
      if (typeof response === "string") return { ...base, text: response }
      return { ...base, ...response }
    },
    async deleteSession() {},
  }
}

function withMeta(body: string): string {
  return `export const meta = { name: 'sandbox-test', description: 'sandbox test' }\n${body}`
}

/** Run a script body and return its value, with a runner that always succeeds. */
async function evaluate(body: string, args?: unknown): Promise<unknown> {
  const result = await runWorkflowScript({
    script: withMeta(body),
    args,
    runner: scriptedRunner(() => "ok"),
    defaultAgent: "general",
  })
  return result.value
}

describe("workflow sandbox: ambient globals are absent", () => {
  // `typeof` rather than a bare reference: a bare reference throws
  // ReferenceError either way and would prove nothing about the realm.
  const blocked = [
    "process",
    "require",
    "module",
    "exports",
    "fetch",
    "Buffer",
    "setTimeout",
    "setInterval",
    "setImmediate",
    "clearTimeout",
    "queueMicrotask",
    "structuredClone",
    "TextEncoder",
    "TextDecoder",
    "crypto",
    "performance",
    "AbortController",
    "URL",
    "__dirname",
    "__filename",
  ]

  it.each(blocked)("does not expose %s", async (name) => {
    expect(await evaluate(`return typeof ${name}`)).toBe("undefined")
  })

  it("does not expose process on globalThis either", async () => {
    expect(await evaluate("return typeof globalThis.process")).toBe("undefined")
    expect(await evaluate('return Object.getOwnPropertyNames(globalThis).includes("process")')).toBe(
      false,
    )
  })

  it("drops the host bridge after bootstrap", async () => {
    expect(await evaluate("return typeof globalThis.__host__")).toBe("undefined")
    expect(
      await evaluate('return Object.getOwnPropertyNames(globalThis).filter((n) => n.includes("host"))'),
    ).toEqual([])
  })
})

describe("workflow sandbox: constructor-chain escapes are closed", () => {
  // Each of these reaches the host realm's Function constructor if any host
  // object, function, promise or error is reachable from script code. They are
  // the regression guard for the bridge's primitives-only discipline.
  const escapes: Array<[string, string]> = [
    ["Function", 'Function("return process.platform")()'],
    ["object literal", '({}).constructor.constructor("return process.platform")()'],
    ["array literal", '[].constructor.constructor("return process.platform")()'],
    ["Error instance", '(new Error()).constructor.constructor("return process.platform")()'],
    [
      // The AsyncFunction constructor yields a promise, so the rejection has
      // to be awaited for the escape attempt to surface.
      "async function prototype",
      'await Object.getPrototypeOf(async function () {}).constructor("return process.platform")()',
    ],
    [
      "globalThis prototype",
      'Object.getPrototypeOf(globalThis).constructor.constructor("return process.platform")()',
    ],
    ["injected agent function", 'agent.constructor.constructor("return process.platform")()'],
    ["injected parallel function", 'parallel.constructor.constructor("return process.platform")()'],
    ["injected budget object", 'budget.constructor.constructor("return process.platform")()'],
    [
      "pending agent promise",
      'agent("x").constructor.constructor("return process.platform")()',
    ],
    [
      "resolved agent value",
      '(await agent("x")).constructor.constructor("return process.platform")()',
    ],
  ]

  it.each(escapes)("blocks the %s chain", async (_name, expression) => {
    const value = await evaluate(
      `try { return String(${expression}) } catch (error) { return "THREW: " + error.message }`,
    )
    expect(value).toBe("THREW: process is not defined")
  })

  it("blocks the chain through args", async () => {
    const value = await evaluate(
      'try { return String(args.constructor.constructor("return process.platform")()) }' +
        ' catch (error) { return "THREW: " + error.message }',
      { a: 1 },
    )
    expect(value).toBe("THREW: process is not defined")
  })

  it("blocks the chain through an error caught from a failing agent call", async () => {
    const result = await runWorkflowScript({
      // The lifetime cap makes the host's agent() reject with a real host Error.
      script: withMeta(
        [
          "try {",
          "  await agent('one')",
          "  await agent('two')",
          "  return 'no error'",
          "} catch (error) {",
          "  try { return String(error.constructor.constructor('return process.platform')()) }",
          "  catch (inner) { return 'THREW: ' + inner.message }",
          "}",
        ].join("\n"),
      ),
      runner: scriptedRunner(() => "ok"),
      defaultAgent: "general",
      maxAgents: 1,
    })
    expect(result.value).toBe("THREW: process is not defined")
  })

  it("gives script-visible values sandbox-realm prototypes", async () => {
    expect(await evaluate('return Object.getPrototypeOf(await agent("x")) === Object.prototype')).toBe(
      false,
    )
    expect(await evaluate("return Object.getPrototypeOf(args) === Object.prototype", { a: 1 })).toBe(
      true,
    )
  })

  it("eval runs in the sandbox realm", async () => {
    expect(await evaluate('return eval("typeof process")')).toBe("undefined")
  })
})

describe("workflow sandbox: module loading is unavailable", () => {
  it("rejects dynamic import of a node builtin", async () => {
    const value = await evaluate(
      "try { await import('node:fs'); return 'LOADED' } catch (error) { return error.message }",
    )
    expect(value).not.toBe("LOADED")
    expect(String(value)).toMatch(/dynamic import/i)
  })

  it("rejects dynamic import of a data URL", async () => {
    const value = await evaluate(
      "try { await import('data:text/javascript,export default 1'); return 'LOADED' }" +
        " catch (error) { return error.message }",
    )
    expect(value).not.toBe("LOADED")
    expect(String(value)).toMatch(/dynamic import/i)
  })
})

describe("workflow sandbox: ordinary JavaScript still works", () => {
  it("supports the built-ins scripts actually use", async () => {
    const value = await evaluate(
      [
        "class Tagged extends Array {}",
        "function* counter() { yield 1; yield 2 }",
        "const parsed = JSON.parse('{\"n\": 2}')",
        "const set = new Set([1, 1, 2])",
        "const map = new Map([['k', 'v']])",
        "let typeErrorCaught = false",
        "try { null.x } catch (error) { typeErrorCaught = error instanceof TypeError }",
        "return {",
        "  json: JSON.stringify({ a: [1, 2] }),",
        "  spread: [...set, ...counter()],",
        "  map: map.get('k'),",
        "  from: Array.from('ab').join('-'),",
        "  sorted: [3, 1, 2].sort((a, b) => a - b),",
        "  entries: Object.entries({ x: 1 }),",
        "  regex: /a(b)c/.exec('abc')[1],",
        "  template: `n=${parsed.n}`,",
        "  padded: 'x'.padStart(3, '.'),",
        "  parsedFloat: Number.parseFloat('1.5'),",
        "  all: await Promise.all([1, Promise.resolve(2)]),",
        "  subclass: new Tagged() instanceof Array,",
        "  typeErrorCaught,",
        "  optional: ({ a: { b: 7 } }).a?.b ?? 0,",
        "}",
      ].join("\n"),
    )
    expect(value).toEqual({
      json: '{"a":[1,2]}',
      spread: [1, 2, 1, 2],
      map: "v",
      from: "a-b",
      sorted: [1, 2, 3],
      entries: [["x", 1]],
      regex: "b",
      template: "n=2",
      padded: "..x",
      parsedFloat: 1.5,
      all: [1, 2],
      subclass: true,
      typeErrorCaught: true,
      optional: 7,
    })
  })

  it("adopts return values that JSON cannot carry", async () => {
    const value = (await evaluate(
      "return { inf: Infinity, nan: NaN, when: new Date(0), set: new Set([1]) }",
    )) as { inf: number; nan: number; when: Date; set: Set<number> }
    expect(value.inf).toBe(Infinity)
    expect(Number.isNaN(value.nan)).toBe(true)
    expect(value.when).toBeInstanceOf(Date)
    expect(value.when.getTime()).toBe(0)
    expect(value.set).toBeInstanceOf(Set)
    // Adopted into the host realm, so plain object checks apply.
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
  })
})

describe("workflow sandbox: error surfacing", () => {
  it("reports a script's own Error message despite the realm boundary", async () => {
    const failure = await runWorkflowScript({
      script: withMeta("throw new Error('boom')"),
      runner: scriptedRunner(() => "ok"),
      defaultAgent: "general",
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkflowScriptError)
    expect((failure as WorkflowScriptError).message).toBe("boom")
  })

  it("reports a syntax error in the script body", async () => {
    const failure = await runWorkflowScript({
      script: withMeta("return {{{"),
      runner: scriptedRunner(() => "ok"),
      defaultAgent: "general",
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkflowScriptError)
    expect((failure as WorkflowScriptError).message).toMatch(/unexpected|token|expected/i)
  })

  it("surfaces a throwing log handler as a sandbox-realm error, not a host one", async () => {
    const value = await runWorkflowScript({
      script: withMeta(
        [
          "try { log('x'); return 'no error' }",
          "catch (error) {",
          "  try { return String(error.constructor.constructor('return process.platform')()) }",
          "  catch (inner) { return 'THREW: ' + inner.message }",
          "}",
        ].join("\n"),
      ),
      runner: scriptedRunner(() => "ok"),
      defaultAgent: "general",
      events: {
        onLog: () => {
          throw new Error("handler exploded")
        },
      },
    })
    expect(value.value).toBe("THREW: process is not defined")
  })
})

describe("workflow sandbox: determinism shadows survive the move", () => {
  it("keeps Date and Math shadows in the sandbox realm", async () => {
    expect(await evaluate("return new Date(0) instanceof Date")).toBe(true)
    expect(await evaluate("return new Date(0).toISOString()")).toBe("1970-01-01T00:00:00.000Z")
    expect(await evaluate("return Date.parse('1970-01-01T00:00:00.000Z')")).toBe(0)
    expect(await evaluate("return Math.max(1, 9)")).toBe(9)
  })

  const nondeterministic: Array<[string, string, RegExp]> = [
    ["Date.now()", "return Date.now()", /Date\.now\(\)/],
    ["argless new Date()", "return new Date()", /new Date\(\) without arguments/],
    ["Date() as a function", "return Date()", /Date\(\) called as a function/],
    ["Math.random()", "return Math.random()", /Math\.random\(\)/],
  ]

  it.each(nondeterministic)("rejects %s", async (_name, body, pattern) => {
    await expect(
      runWorkflowScript({
        script: withMeta(body),
        runner: scriptedRunner(() => "ok"),
        defaultAgent: "general",
      }),
    ).rejects.toThrow(pattern)
  })

  // Shadowing the Date global left the real constructor one hop away through
  // any Date instance's prototype, so each of these returned wall-clock time.
  const dateEscapes: Array<[string, string, RegExp]> = [
    ["instance constructor", "return new Date(0).constructor.now()", /Date\.now\(\)/],
    ["prototype constructor", "return Date.prototype.constructor.now()", /Date\.now\(\)/],
    [
      "own property descriptor",
      'return Object.getOwnPropertyDescriptor(Date, "now").value()',
      /Date\.now\(\)/,
    ],
    [
      "construct via the instance constructor",
      "return new (new Date(0).constructor)()",
      /new Date\(\) without arguments/,
    ],
    [
      "reflect construct",
      "return Reflect.construct(new Date(0).constructor, [])",
      /new Date\(\) without arguments/,
    ],
    [
      "prototype of an instance",
      "return Object.getPrototypeOf(new Date(0)).constructor.now()",
      /Date\.now\(\)/,
    ],
    ["codegen", 'return Function("return Date.now()")()', /Date\.now\(\)/],
  ]

  it.each(dateEscapes)("closes the %s escape", async (_name, body, pattern) => {
    await expect(
      runWorkflowScript({
        script: withMeta(body),
        runner: scriptedRunner(() => "ok"),
        defaultAgent: "general",
      }),
    ).rejects.toThrow(pattern)
  })

  it("keeps instanceof and the untouched Date statics working after the patch", async () => {
    expect(
      await evaluate(
        [
          "const d = new Date(0)",
          "return {",
          "  isDate: d instanceof Date,",
          "  ctorIsShadow: d.constructor === Date,",
          "  parse: Date.parse('1970-01-01T00:00:00.000Z'),",
          "  utc: Date.UTC(1970, 0, 1),",
          "  iso: d.toISOString(),",
          "}",
        ].join("\n"),
      ),
    ).toEqual({
      isDate: true,
      ctorIsShadow: true,
      parse: 0,
      utc: 0,
      iso: "1970-01-01T00:00:00.000Z",
    })
  })

  it("blocks Math.random through the codegen path too", async () => {
    await expect(
      runWorkflowScript({
        script: withMeta('return Function("return Math.random()")()'),
        runner: scriptedRunner(() => "ok"),
        defaultAgent: "general",
      }),
    ).rejects.toThrow(/Math\.random\(\)/)
  })
})

describe("workflow sandbox: console is routed into the workflow log", () => {
  it("emits console output as log lines instead of writing to the terminal", async () => {
    const logs: string[] = []
    await runWorkflowScript({
      script: withMeta("console.log('hello', 42)\nconsole.warn('careful')\nreturn 1"),
      runner: scriptedRunner(() => "ok"),
      defaultAgent: "general",
      events: { onLog: (entry) => logs.push(entry) },
    })
    expect(logs).toEqual(["hello 42", "careful"])
  })
})

describe("parallel() argument validation", () => {
  it("rejects promises and values instead of resolving them all to null", async () => {
    // parallel([agent('a')]) - a promise rather than a thunk - used to produce
    // [null], which reads exactly like an agent that failed.
    const failure = await runWorkflowScript({
      script: withMeta("return await parallel([1, 2])"),
      runner: scriptedRunner(() => "ok"),
      defaultAgent: "general",
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(WorkflowScriptError)
    expect((failure as Error).message).toMatch(/item 0 is number/)
  })

  it("names the first offending index", async () => {
    const failure = await runWorkflowScript({
      script: withMeta("return await parallel([() => 1, 'nope'])"),
      runner: scriptedRunner(() => "ok"),
      defaultAgent: "general",
    }).catch((error: unknown) => error)
    expect((failure as Error).message).toMatch(/item 1 is string/)
  })
})

describe("workflow sandbox: performance", () => {
  it("creates sandboxes cheaply enough to be irrelevant next to an agent call", async () => {
    const started = Date.now()
    for (let index = 0; index < 50; index += 1) {
      await evaluate("return 1")
    }
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
