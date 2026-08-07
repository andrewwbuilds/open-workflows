import vm from "node:vm"

/**
 * Host functions the sandbox bootstrap calls on the script's behalf.
 *
 * Every value crossing this boundary in either direction is a primitive. That
 * is the load-bearing rule of the whole sandbox: a host object or function
 * handed to script code exposes the host realm's `Function` constructor via
 * `value.constructor.constructor`, which reaches `process` and defeats the
 * isolation entirely. Structured values travel as JSON strings instead.
 */
export interface WorkflowHostBridge {
  /** Cap for parallel()/pipeline() item counts. */
  maxItems: number
  /** JSON of the workflow's args, or undefined when none were passed. */
  argsJSON: string | undefined
  aborted(): boolean
  /** JSON `{ total, spent, remaining }`; `remaining: null` stands for Infinity. */
  budgetJSON(): string
  log(text: string): void
  /** `null` for a non-string title, which the host rejects as it always has. */
  phase(title: string | null): void
  /**
   * `name` is "agent" or "workflow"; `argsJSON` is a JSON array of call args.
   * Always resolves - never rejects - to JSON `{ ok: true, value }` or
   * `{ ok: false, error: { message, abort, usage, limit } }`, so a host Error
   * object can never surface inside a script's `catch`.
   */
  callAsync(name: string, argsJSON: string): Promise<string>
}

export interface WorkflowSandboxOptions {
  /**
   * Ceiling on synchronous script execution, i.e. everything up to the first
   * `await`. It bounds `while (true) {}` but not an async spin loop.
   */
  syncTimeoutMs?: number
}

const DEFAULT_SYNC_TIMEOUT_MS = 10_000

/**
 * Runs inside the sandbox realm and builds every global the script sees. It is
 * a source string rather than a host function because the workflow globals must
 * be created from the sandbox's own intrinsics - exposing the host's `Date`
 * proxy, for instance, would itself hand over `Date.constructor`.
 */
const BOOTSTRAP = String.raw`(() => {
  "use strict"
  const host = globalThis.__host__
  // Dropped immediately so script code cannot reach the bridge; the bootstrap
  // keeps it alive in this closure.
  delete globalThis.__host__

  // Re-materialise anything a host function throws as a realm-local Error, so
  // a script's catch block never receives a host object.
  const call = (fn) => {
    try {
      return fn()
    } catch (error) {
      throw new Error(errorText(error))
    }
  }

  const errorText = (error) =>
    error && typeof error.message === "string" ? error.message : String(error)

  const callAsync = (name) => async (...callArgs) => {
    let json
    try {
      json = await host.callAsync(name, JSON.stringify(callArgs))
    } catch (error) {
      throw new Error(errorText(error))
    }
    const settled = JSON.parse(json)
    if (settled.ok) return settled.value
    const error = new Error(settled.error.message)
    // Flags rather than classes: the host's error classes live in another realm,
    // so instanceof cannot cross. parallel()/pipeline() branch on these.
    if (settled.error.abort) {
      error.name = "WorkflowAbortError"
      error.workflowAbort = true
    }
    if (settled.error.usage) {
      error.name = "WorkflowUsageError"
      error.workflowUsage = true
    }
    if (settled.error.limit) {
      error.name = "WorkflowLimitError"
      error.workflowLimit = true
    }
    throw error
  }

  // Cancellation, script-usage errors and breached run limits must terminate
  // the workflow; ordinary failures degrade to a null item.
  const isFatal = (error) =>
    Boolean(
      error && (error.workflowAbort || error.workflowUsage || error.workflowLimit),
    ) || call(() => host.aborted())

  const nondeterministic = (what, hint) => {
    throw new Error(
      what +
        " is not available inside workflow scripts: results must be deterministic so resume replay works. " +
        hint,
    )
  }

  const RealDate = Date

  const deterministicDate = new Proxy(RealDate, {
    construct(target, argArray, newTarget) {
      if (argArray.length === 0) {
        nondeterministic(
          "new Date() without arguments",
          "Pass the timestamp in via args (e.g. new Date(args.now)).",
        )
      }
      return Reflect.construct(target, argArray, newTarget)
    },
    apply() {
      nondeterministic(
        "Date() called as a function",
        "Pass the timestamp in via args (e.g. args.now).",
      )
    },
  })

  // Shadowing the Date global is not enough on its own: every Date instance
  // reaches the raw constructor through its prototype, so
  // new Date(0).constructor.now(), Date.prototype.constructor.now() and
  // Object.getOwnPropertyDescriptor(Date, "now").value() all used to return
  // real wall-clock time. Patching the intrinsic itself closes all of them at
  // once, and is safe because this realm owns its own Date - the host's is a
  // different object entirely. Date.prototype is left untouched apart from its
  // constructor property, so "x instanceof Date" still holds.
  Object.defineProperty(RealDate, "now", {
    value: () => nondeterministic("Date.now()", "Pass the timestamp in via args (e.g. args.now)."),
    writable: false,
    enumerable: false,
    configurable: false,
  })
  Object.defineProperty(RealDate.prototype, "constructor", {
    value: deterministicDate,
    writable: true,
    enumerable: false,
    configurable: true,
  })

  Object.defineProperty(Math, "random", {
    value: () =>
      nondeterministic(
        "Math.random()",
        "Pass random values or a seed in via args (e.g. args.seed).",
      ),
    writable: false,
    enumerable: false,
    configurable: false,
  })

  const maxItems = host.maxItems

  const parallel = async (thunks) => {
    if (!Array.isArray(thunks)) {
      throw new Error("parallel() requires an array of zero-argument functions.")
    }
    if (thunks.length > maxItems) {
      throw new Error(
        "parallel() accepts at most " + maxItems + " items, got " + thunks.length + ".",
      )
    }
    // Without this, parallel([agent("a"), agent("b")]) - promises instead of
    // thunks - resolves to [null, null], because calling a non-function throws
    // inside the per-item catch and degrades like any ordinary failure.
    const badIndex = thunks.findIndex((thunk) => typeof thunk !== "function")
    if (badIndex >= 0) {
      throw new Error(
        "parallel() requires zero-argument functions; item " +
          badIndex +
          " is " +
          typeof thunks[badIndex] +
          ". Wrap each call in an arrow function, e.g. () => agent('...').",
      )
    }
    return Promise.all(
      thunks.map((thunk) =>
        Promise.resolve()
          .then(() => thunk())
          .catch((error) => {
            if (isFatal(error)) throw error
            return null
          }),
      ),
    )
  }

  const pipeline = async (items, ...stages) => {
    if (!Array.isArray(items)) {
      throw new Error("pipeline() requires an array of items as its first argument.")
    }
    if (items.length > maxItems) {
      throw new Error(
        "pipeline() accepts at most " + maxItems + " items, got " + items.length + ".",
      )
    }
    return Promise.all(
      items.map(async (item, index) => {
        let value = item
        for (const stage of stages) {
          try {
            value = await stage(value, item, index)
          } catch (error) {
            if (isFatal(error)) throw error
            return null
          }
        }
        return value
      }),
    )
  }

  const readBudget = () => JSON.parse(call(() => host.budgetJSON()))

  const budget = {
    get total() {
      return readBudget().total
    },
    spent: () => readBudget().spent,
    remaining: () => {
      const value = readBudget().remaining
      // JSON has no Infinity; the host sends null for an unlimited budget.
      return value === null ? Infinity : value
    },
  }

  const emit = (message) => {
    const text = String(message)
    call(() => host.log(text))
  }

  // node:vm gives every context a console wired to the host's stdout. It is
  // not an escape vector (its methods are this realm's functions), but it is
  // an undocumented global whose output bypasses the workflow's own log stream
  // and lands in the user's terminal. Replace it with a shim that funnels into
  // log(), so console output from a model-authored script does the obvious
  // thing instead of vanishing.
  const consoleShim = {}
  for (const method of ["log", "info", "warn", "error", "debug", "trace", "dir"]) {
    consoleShim[method] = (...parts) => emit(parts.map((part) => String(part)).join(" "))
  }

  Object.assign(globalThis, {
    agent: callAsync("agent"),
    workflow: callAsync("workflow"),
    parallel,
    pipeline,
    phase: (title) => {
      call(() => host.phase(typeof title === "string" ? title : null))
    },
    log: emit,
    args: host.argsJSON === undefined ? undefined : JSON.parse(host.argsJSON),
    budget,
    Date: deterministicDate,
    console: consoleShim,
  })
})()`

/**
 * Compile and run a workflow body in a fresh sandbox realm.
 *
 * The realm starts from a null-prototype object, so it has none of the host's
 * ambient globals: no `process`, `require`, `fetch`, timers, `Buffer`, and no
 * dynamic `import()`. Only the workflow globals the bootstrap installs and the
 * standard ECMAScript built-ins are reachable.
 *
 * This is a guardrail against a misbehaving or model-authored script, not a
 * security boundary - node:vm is explicitly not one.
 */
export function runInWorkflowSandbox(
  body: string,
  host: WorkflowHostBridge,
  options: WorkflowSandboxOptions = {},
): Promise<unknown> {
  const context = vm.createContext(Object.create(null) as object, {
    name: "workflow-script",
    codeGeneration: { strings: true, wasm: false },
  }) as Record<string, unknown>
  context.__host__ = host
  vm.runInContext(BOOTSTRAP, context, { filename: "workflow-sandbox.js" })
  // The body is wrapped in an async IIFE so top-level `return` and `await`
  // behave exactly as they did under the previous AsyncFunction compilation.
  const script = new vm.Script(`(async () => {\n${body}\n})()`, { filename: "workflow-script.js" })
  const result = script.runInContext(context, {
    timeout: options.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS,
  }) as unknown
  return Promise.resolve(result)
}

/**
 * Re-materialise a script's return value in the host realm. structuredClone
 * carries what JSON cannot - Infinity, NaN, Date, Map, Set - and yields
 * host-realm prototypes so callers can treat the value as ordinary data.
 * Values it cannot clone (functions, symbols) are passed through untouched.
 */
export function adoptFromSandbox(value: unknown): unknown {
  try {
    return structuredClone(value)
  } catch {
    return value
  }
}
