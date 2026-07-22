/**
 * Unit tests for the task_* MCP tools (task-tools.ts): the 4 tools over a
 * FAKE ledger + scoped-caller identity. Drives the REAL registered
 * handlers through an in-memory MCP client (the policy-list test idiom) —
 * what's under test is the tool layer: caller derivation (operator vs
 * scoped session vs unbound scope), the "self" owner sugar, argument
 * passthrough, the first-class conflict reply, and the handshake-safe
 * no-ledger error. The ledger's own semantics live in task-ledger.test.ts.
 */

import { describe, expect, it } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerTaskTools } from "../task-tools.js"
import type {
  TaskCaller,
  TaskCreateInput,
  TaskLedger,
  TaskListFilter,
  TaskRecord,
  TaskUpdateInput,
  TaskWriteResult,
} from "../task-ledger.js"

// ── Fixtures ──────────────────────────────────────────────────────────

const T0 = "2026-07-22T10:00:00.000Z"

function record(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "task_1",
    boardId: "tree:root",
    title: "t",
    status: "pending",
    createdBy: "sup",
    rev: 0,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  }
}

interface RecordedCall {
  verb: "create" | "list" | "claim" | "update"
  input: TaskCreateInput | TaskListFilter | { taskId: string; rev: number } | TaskUpdateInput | undefined
  caller: TaskCaller
}

/** A ledger that records every call and answers canned results — the tool
 *  layer is under test, not the state machine. */
function fakeLedger(results: {
  create?: TaskWriteResult
  claim?: TaskWriteResult
  update?: TaskWriteResult
} = {}): { ledger: TaskLedger; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const task = record()
  const ledger: TaskLedger = {
    create(input, caller) {
      calls.push({ verb: "create", input, caller })
      return results.create ?? { ok: true, task }
    },
    list(filter, caller) {
      calls.push({ verb: "list", input: filter, caller })
      return [task]
    },
    get: () => task,
    claim(input, caller) {
      calls.push({ verb: "claim", input, caller })
      return results.claim ?? { ok: true, task }
    },
    update(input, caller) {
      calls.push({ verb: "update", input, caller })
      return results.update ?? { ok: true, task }
    },
    resolveBoardId: (caller, explicit) =>
      explicit ?? (caller.kind === "session" ? `tree:${caller.sessionId}` : "ws:default"),
    dispose() {},
  }
  return { ledger, calls }
}

async function client(opts: {
  ledger?: TaskLedger
  callerScope?: { ownerSessionId?: string }
}): Promise<Client> {
  const server = new McpServer({ name: "task-tools-server", version: "0.0.0" })
  registerTaskTools(server, {
    ...(opts.ledger ? { ledger: opts.ledger } : {}),
    ...(opts.callerScope ? { callerScope: opts.callerScope } : {}),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const mcp = new Client({ name: "task-tools-client", version: "0.0.0" })
  await mcp.connect(clientTransport)
  return mcp
}

/** Parse the JSON text block out of a tool reply, structurally (the SDK
 *  types `content` as unknown — narrow, don't assert). */
function payloadOf(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const blocks = "content" in result ? result.content : undefined
  if (!Array.isArray(blocks)) throw new Error("tool reply has no content array")
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue
    if (!("type" in block) || block.type !== "text") continue
    if (!("text" in block) || typeof block.text !== "string") continue
    const parsed: unknown = JSON.parse(block.text)
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { ...parsed }
    }
    throw new Error(`tool reply was not a JSON object: ${block.text}`)
  }
  throw new Error("tool reply had no text block")
}

async function call(
  mcp: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return payloadOf(await mcp.callTool({ name, arguments: args }))
}

// ── Registration ──────────────────────────────────────────────────────

describe("registration", () => {
  it("registers all four tools", async () => {
    const { ledger } = fakeLedger()
    const mcp = await client({ ledger })
    const names = (await mcp.listTools()).tools.map(t => t.name).sort()
    expect(names).toEqual(["task_claim", "task_create", "task_list", "task_update"])
    await mcp.close()
  })

  it("without a ledger the tools still register and answer a structured error (handshake-safe)", async () => {
    const mcp = await client({})
    expect((await mcp.listTools()).tools).toHaveLength(4)
    for (const [name, args] of [
      ["task_create", { title: "t" }],
      ["task_list", {}],
      ["task_claim", { taskId: "task_1", rev: 0 }],
      ["task_update", { taskId: "task_1", rev: 0 }],
    ] as const) {
      expect((await call(mcp, name, { ...args })).error).toBe("task ledger not available")
    }
    await mcp.close()
  })
})

// ── Caller identity ───────────────────────────────────────────────────

describe("caller identity", () => {
  it("root context (no scope) acts as the operator", async () => {
    const { ledger, calls } = fakeLedger()
    const mcp = await client({ ledger })
    await call(mcp, "task_create", { title: "t" })
    await call(mcp, "task_list", {})
    await call(mcp, "task_claim", { taskId: "task_1", rev: 0 })
    await call(mcp, "task_update", { taskId: "task_1", rev: 0, note: "n" })
    expect(calls.map(c => c.caller)).toEqual([
      { kind: "operator" },
      { kind: "operator" },
      { kind: "operator" },
      { kind: "operator" },
    ])
    await mcp.close()
  })

  it("a bound scope acts as its owner session — ACL + board default follow", async () => {
    const { ledger, calls } = fakeLedger()
    const mcp = await client({ ledger, callerScope: { ownerSessionId: "sess_x" } })
    await call(mcp, "task_claim", { taskId: "task_1", rev: 3 })
    expect(calls).toEqual([
      {
        verb: "claim",
        input: { taskId: "task_1", rev: 3 },
        caller: { kind: "session", sessionId: "sess_x" },
      },
    ])
    // The echoed default board is derived from that identity.
    const listed = await call(mcp, "task_list", {})
    expect(listed.boardId).toBe("tree:sess_x")
    await mcp.close()
  })

  it("an unbound scope can act as nobody", async () => {
    const { ledger, calls } = fakeLedger()
    const mcp = await client({ ledger, callerScope: {} })
    for (const [name, args] of [
      ["task_create", { title: "t" }],
      ["task_list", {}],
      ["task_claim", { taskId: "task_1", rev: 0 }],
      ["task_update", { taskId: "task_1", rev: 0 }],
    ] as const) {
      const payload = await call(mcp, name, { ...args })
      expect(payload.error).toContain("not yet bound")
    }
    expect(calls).toEqual([])
    await mcp.close()
  })
})

// ── Argument passthrough ──────────────────────────────────────────────

describe("argument passthrough", () => {
  it("task_create forwards the full shape, verify gate included", async () => {
    const { ledger, calls } = fakeLedger()
    const mcp = await client({ ledger })
    await call(mcp, "task_create", {
      title: "wire it",
      description: "d",
      boardId: "sprint-42",
      blockedBy: ["task_0"],
      verify: { command: "pnpm", args: ["test"] },
      meta: { prUrl: "https://example.test/pr/1" },
    })
    expect(calls[0]).toEqual({
      verb: "create",
      input: {
        title: "wire it",
        description: "d",
        boardId: "sprint-42",
        blockedBy: ["task_0"],
        verify: { command: "pnpm", args: ["test"] },
        meta: { prUrl: "https://example.test/pr/1" },
      },
      caller: { kind: "operator" },
    })
    await mcp.close()
  })

  it('owner:"self" resolves to the calling session (operator → "operator")', async () => {
    const scoped = fakeLedger()
    const scopedMcp = await client({
      ledger: scoped.ledger,
      callerScope: { ownerSessionId: "sess_x" },
    })
    await call(scopedMcp, "task_create", { title: "mine", owner: "self" })
    expect(scoped.calls[0]?.input).toEqual({ title: "mine", owner: "sess_x" })
    await scopedMcp.close()

    const root = fakeLedger()
    const rootMcp = await client({ ledger: root.ledger })
    await call(rootMcp, "task_create", { title: "mine", owner: "self" })
    expect(root.calls[0]?.input).toEqual({ title: "mine", owner: "operator" })
    // …and a literal owner passes through untouched.
    await call(rootMcp, "task_create", { title: "th", owner: "sess_y" })
    expect(root.calls[1]?.input).toEqual({ title: "th", owner: "sess_y" })
    await rootMcp.close()
  })

  it("task_update forwards status/edit/release/evidence fields verbatim", async () => {
    const { ledger, calls } = fakeLedger()
    const mcp = await client({ ledger })
    await call(mcp, "task_update", {
      taskId: "task_1",
      rev: 4,
      status: "done",
      evidence: { policyId: "plc_1" },
      note: "gated elsewhere",
    })
    await call(mcp, "task_update", { taskId: "task_1", rev: 5, owner: null })
    expect(calls[0]?.input).toEqual({
      taskId: "task_1",
      rev: 4,
      status: "done",
      evidence: { policyId: "plc_1" },
      note: "gated elsewhere",
    })
    expect(calls[1]?.input).toEqual({ taskId: "task_1", rev: 5, owner: null })
    await mcp.close()
  })
})

// ── Result rendering ──────────────────────────────────────────────────

describe("result rendering", () => {
  it("a claim conflict is a FIRST-CLASS reply: {conflict:true, current}", async () => {
    const current = record({ owner: "sess_other", status: "in_progress", rev: 2 })
    const { ledger } = fakeLedger({
      claim: { ok: false, conflict: true, current },
    })
    const mcp = await client({ ledger })
    const payload = await call(mcp, "task_claim", { taskId: "task_1", rev: 0 })
    expect(payload.conflict).toBe(true)
    expect(payload.current).toMatchObject({ owner: "sess_other", rev: 2 })
    await mcp.close()
  })

  it("a Tier-1 done surfaces verifying:true alongside the (unmoved) task", async () => {
    const task = record({ status: "in_progress", owner: "sess_x", rev: 1 })
    const { ledger } = fakeLedger({ update: { ok: true, task, verifying: true } })
    const mcp = await client({ ledger })
    const payload = await call(mcp, "task_update", {
      taskId: "task_1",
      rev: 1,
      status: "done",
    })
    expect(payload.verifying).toBe(true)
    expect(payload.task).toMatchObject({ status: "in_progress" })
    await mcp.close()
  })

  it("a refusal renders as {error}", async () => {
    const { ledger } = fakeLedger({
      update: { ok: false, conflict: false, error: "invalid transition pending → done" },
    })
    const mcp = await client({ ledger })
    const payload = await call(mcp, "task_update", { taskId: "task_1", rev: 0, status: "done" })
    expect(payload.error).toBe("invalid transition pending → done")
    await mcp.close()
  })
})
