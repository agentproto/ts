/**
 * `ask_codebase` proven against a hand-rolled FAKE `ICodeBrainProvider` —
 * no live backend, no external engine. This is the whole point of the pure
 * contract package: the tool and its body are exercised end-to-end before
 * any real backend exists. Each mode must route to the right contract method
 * and shape its output correctly.
 */

import { describe, it, expect } from "vitest"
import { validateInput, validateOutput, validateContext } from "@agentproto/tool"
import { askCodebaseTool } from "../tools/ask-codebase.tool.js"
import { askCodebaseBuiltin } from "../provider/bodies/ask-codebase.body.js"
import type {
  CallEdge,
  GraphQuery,
  GraphResult,
  ICodeBrainProvider,
  SymbolDef,
} from "../types.js"

/** Records every call so the tests can assert routing, not just output. */
interface Calls {
  defineSymbol: string[]
  callers: string[]
  callees: string[]
  graphQuery: GraphQuery[]
}

function makeFakeProvider(overrides: Partial<ICodeBrainProvider> = {}): {
  provider: ICodeBrainProvider
  calls: Calls
} {
  const calls: Calls = { defineSymbol: [], callers: [], callees: [], graphQuery: [] }

  const sampleDef: SymbolDef = {
    symbol: "foo",
    kind: "function",
    file: "src/foo.ts",
    span: { startLine: 10, endLine: 20 },
    signature: "function foo(x: number): number",
    doc: "Doubles x.",
  }
  const sampleCallers: readonly CallEdge[] = [
    { from: "bar", to: "foo", file: "src/bar.ts", span: { startLine: 3, endLine: 3 } },
  ]
  const sampleCallees: readonly CallEdge[] = [
    { from: "foo", to: "double", file: "src/foo.ts", span: { startLine: 15, endLine: 15 } },
    { from: "foo", to: "log", file: "src/foo.ts", span: { startLine: 16, endLine: 16 } },
  ]
  const sampleResult: GraphResult = {
    hits: [
      { title: "foo doubles its input", body: "note body", file: "src/foo.ts", score: 0.9 },
    ],
  }

  const provider: ICodeBrainProvider = {
    async defineSymbol(symbol) {
      calls.defineSymbol.push(symbol)
      return sampleDef
    },
    async callers(symbol) {
      calls.callers.push(symbol)
      return sampleCallers
    },
    async callees(symbol) {
      calls.callees.push(symbol)
      return sampleCallees
    },
    async graphQuery(query) {
      calls.graphQuery.push(query)
      return sampleResult
    },
    ...overrides,
  }

  return { provider, calls }
}

/**
 * Drive the tool the way a provider runtime would: validate input +
 * context against the contract, run the typed body, validate output. This
 * exercises the real contract boundary, not just the raw function.
 */
async function runTool(rawInput: unknown, provider: ICodeBrainProvider) {
  const input = validateInput(askCodebaseTool, rawInput)
  if (!input.ok) throw new Error(`input invalid: ${input.error.message}`)
  const context = validateContext(askCodebaseTool, { codeBrain: provider })
  if (!context.ok) throw new Error(`context invalid: ${context.error.message}`)

  const controller = new AbortController()
  const output = await askCodebaseBuiltin.body({
    input: input.value,
    context: context.value,
    driverCtx: { secrets: {}, authState: "unknown" },
    signal: controller.signal,
  })
  return validateOutput(askCodebaseTool, output)
}

describe("ask_codebase contract", () => {
  it("defaults mode to 'blend'", () => {
    const parsed = validateInput(askCodebaseTool, { question: "how does auth work?" })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.mode).toBe("blend")
  })

  it("declares no mutation, auto approval, idempotent, risk 0", () => {
    expect(askCodebaseTool.mutates).toEqual([])
    expect(askCodebaseTool.approval).toBe("auto")
    expect(askCodebaseTool.idempotent).toBe(true)
    expect(askCodebaseTool.riskLevel).toBe(0)
  })
})

describe("blend mode → graphQuery", () => {
  it("routes to graphQuery and returns hits", async () => {
    const { provider, calls } = makeFakeProvider()
    const out = await runTool({ question: "where is retry?", mode: "blend", limit: 5 }, provider)

    expect(calls.graphQuery).toEqual([{ question: "where is retry?", limit: 5 }])
    expect(calls.defineSymbol).toEqual([])
    expect(calls.callers).toEqual([])
    expect(calls.callees).toEqual([])
    expect(out.mode).toBe("blend")
    expect(out.hits?.length).toBe(1)
    expect(out.answer).toContain("foo doubles its input")
    expect(out.symbol).toBeUndefined()
    expect(out.callers).toBeUndefined()
  })

  it("forwards `symbol` as the neutral `scope` hint", async () => {
    const { provider, calls } = makeFakeProvider()
    await runTool({ question: "usages", mode: "blend", symbol: "AuthService" }, provider)
    expect(calls.graphQuery).toEqual([{ question: "usages", scope: "AuthService" }])
  })

  it("renders an empty-result answer without hits", async () => {
    const { provider } = makeFakeProvider({
      async graphQuery() {
        return { hits: [] }
      },
    })
    const out = await runTool({ question: "nothing matches", mode: "blend" }, provider)
    expect(out.answer).toBe("No results for: nothing matches")
    expect(out.hits).toEqual([])
  })
})

describe("define mode → defineSymbol", () => {
  it("routes to defineSymbol and returns the definition", async () => {
    const { provider, calls } = makeFakeProvider()
    const out = await runTool({ question: "define foo", mode: "define", symbol: "foo" }, provider)

    expect(calls.defineSymbol).toEqual(["foo"])
    expect(calls.graphQuery).toEqual([])
    expect(out.mode).toBe("define")
    expect(out.symbol?.symbol).toBe("foo")
    expect(out.answer).toContain("function foo(x: number): number")
    expect(out.answer).toContain("src/foo.ts:10")
    expect(out.hits).toBeUndefined()
  })

  it("returns symbol=null and a not-found answer when unknown", async () => {
    const { provider } = makeFakeProvider({
      async defineSymbol() {
        return null
      },
    })
    const out = await runTool({ question: "define ghost", mode: "define", symbol: "ghost" }, provider)
    expect(out.symbol).toBeNull()
    expect(out.answer).toBe("No definition found for symbol 'ghost'.")
  })

  it("rejects define mode without a symbol", async () => {
    const { provider, calls } = makeFakeProvider()
    await expect(runTool({ question: "define", mode: "define" }, provider)).rejects.toThrow(
      /requires a 'symbol'/,
    )
    expect(calls.defineSymbol).toEqual([])
  })
})

describe("callgraph mode → callers + callees", () => {
  it("routes to BOTH callers and callees and returns both edge sets", async () => {
    const { provider, calls } = makeFakeProvider()
    const out = await runTool(
      { question: "graph for foo", mode: "callgraph", symbol: "foo" },
      provider,
    )

    expect(calls.callers).toEqual(["foo"])
    expect(calls.callees).toEqual(["foo"])
    expect(calls.defineSymbol).toEqual([])
    expect(out.mode).toBe("callgraph")
    expect(out.callers?.length).toBe(1)
    expect(out.callees?.length).toBe(2)
    expect(out.answer).toBe("foo: 1 caller(s), 2 callee(s).")
    expect(out.symbol).toBeUndefined()
    expect(out.hits).toBeUndefined()
  })

  it("rejects callgraph mode without a symbol", async () => {
    const { provider, calls } = makeFakeProvider()
    await expect(
      runTool({ question: "graph", mode: "callgraph" }, provider),
    ).rejects.toThrow(/requires a 'symbol'/)
    expect(calls.callers).toEqual([])
    expect(calls.callees).toEqual([])
  })
})

describe("provider builtin binding", () => {
  it("binds the ask_codebase contract handle", () => {
    expect(askCodebaseBuiltin.tool.id).toBe("ask_codebase")
  })
})
