/**
 * A child's report (`message_parent`) or `[child-crashed]` notice reaches a
 * BUSY parent as its OWN queued turn — never string-glued onto whatever
 * prompt comes next (the human's, typically), and never stranded until an
 * unrelated prompt happens to arrive. Driven end-to-end through the real
 * registry + the real MCP tool, with a controllable fake agent session that
 * holds the parent busy until the test releases it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerAgentTools } from "../agent-tools.js"
import {
  createSessionsRegistry,
  isChildPromptSource,
  LEGACY_CHILD_NOTICE_SOURCE,
  migratePendingChildNotices,
  type AgentSessionLike,
  type SessionDescriptor,
  type SessionsRegistry,
} from "../sessions.js"
import { createSessionEventBus, type SessionEventBus } from "../session-event-bus.js"
import { sessionEventsPath } from "../transcript-writer.js"

/** `send()` blocks until `finishTurn()`; every message it was handed is
 *  recorded (as the ACP text it carried) for assertion. */
function controllableAgentSession(sessionId: string): {
  session: AgentSessionLike
  sent: string[]
  finishTurn: () => void
} {
  const sent: string[] = []
  const pending: Array<() => void> = []
  const session: AgentSessionLike = {
    sessionId,
    pid: 1234,
    async *send(message) {
      const m = message as { text?: string } | string
      sent.push(typeof m === "string" ? m : (m.text ?? JSON.stringify(m)))
      await new Promise<void>(resolve => pending.push(resolve))
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
  return { session, sent, finishTurn: () => pending.shift()?.() }
}

function idleAgentSession(sessionId: string): AgentSessionLike {
  return {
    sessionId,
    // eslint-disable-next-line require-yield
    async *send() {
      return
    },
    async cancel() {},
    async close() {},
  }
}

function nextTurnEnd(bus: SessionEventBus, sessionId: string): Promise<void> {
  return new Promise(resolve => {
    const off = bus.on("session:turn-end", ev => {
      if (ev.sessionId !== sessionId) return
      off()
      resolve()
    })
  })
}

async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("condition not met in time")
    await new Promise(r => setTimeout(r, 10))
  }
}

function userPrompts(tmp: string, sessionId: string): Array<{ text: string; source?: string }> {
  const path = sessionEventsPath(sessionId, tmp)
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(l => JSON.parse(l) as { kind: string; text: string; source?: string })
    .filter(r => r.kind === "user-prompt")
    .map(r => ({ text: r.text, ...(r.source ? { source: r.source } : {}) }))
}

async function messageParent(registry: SessionsRegistry, childId: string, message: string) {
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  registerAgentTools(server, { registry, callerSessionId: childId })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)
  try {
    const result = await client.callTool({ name: "message_parent", arguments: { message } })
    return JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text)
  } finally {
    await client.close()
  }
}

describe("child messages to a busy parent", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "child-msg-turns-"))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("drain as their own child-sourced turn at turn-end, and a later human prompt stays a separate turn", async () => {
    const bus = createSessionEventBus()
    const registry = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: bus })
    const parentAgent = controllableAgentSession("acp-parent")
    const parent = registry.spawnAgent({
      workspaceSlug: "w",
      cwd: "/tmp",
      agentSession: parentAgent.session,
      adapterSlug: "mock",
    })
    const child = registry.spawnAgent({
      workspaceSlug: "w",
      cwd: "/tmp",
      agentSession: idleAgentSession("acp-child"),
      adapterSlug: "mock",
      label: "worker-a",
      parentSessionId: parent.id,
      depth: 1,
    })

    await registry.enqueuePrompt(parent.id, "human: run the long job", {})
    expect(registry.get(parent.id)?.busy).toBe(true)

    const res = await messageParent(registry, child.id, "done: 3 files patched")
    expect(res).toMatchObject({ ok: true, delivery: "queued-next-turn" })
    expect(registry.get(parent.id)?.promptQueue).toEqual([
      expect.objectContaining({ source: `child:${child.id}`, origin: `child:${child.id}` }),
    ])

    // A human prompt queued behind the report.
    await registry.enqueuePrompt(parent.id, "human: what next?", { queue: true, origin: "user" })

    // First turn ends naturally → the report self-dispatches as turn 2 with
    // no other prompt in sight (D2), and carries nothing but the report (D1).
    const firstEnd = nextTurnEnd(bus, parent.id)
    parentAgent.finishTurn()
    await firstEnd
    await until(() => parentAgent.sent.length === 2)
    expect(parentAgent.sent[1]).toBe(`[child-message] worker-a (${child.id}): done: 3 files patched`)

    const secondEnd = nextTurnEnd(bus, parent.id)
    parentAgent.finishTurn()
    await secondEnd
    await until(() => parentAgent.sent.length === 3)
    expect(parentAgent.sent[2]).toBe("human: what next?")
    const thirdEnd = nextTurnEnd(bus, parent.id)
    parentAgent.finishTurn()
    await thirdEnd

    await until(() => userPrompts(tmp, parent.id).length === 3)
    expect(userPrompts(tmp, parent.id)).toEqual([
      { text: "human: run the long job" },
      { text: `[child-message] worker-a (${child.id}): done: 3 files patched`, source: `child:${child.id}` },
      { text: "human: what next?" },
    ])
    registry.shutdown()
  })

  it("an idle parent gets the report as a child-sourced turn right away", async () => {
    const bus = createSessionEventBus()
    const registry = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: bus })
    const parentAgent = controllableAgentSession("acp-parent")
    const parent = registry.spawnAgent({
      workspaceSlug: "w",
      cwd: "/tmp",
      agentSession: parentAgent.session,
      adapterSlug: "mock",
    })
    const child = registry.spawnAgent({
      workspaceSlug: "w",
      cwd: "/tmp",
      agentSession: idleAgentSession("acp-child"),
      adapterSlug: "mock",
      parentSessionId: parent.id,
      depth: 1,
    })
    const res = await messageParent(registry, child.id, "hello")
    expect(res).toMatchObject({ ok: true, delivery: "enqueued" })
    await until(() => parentAgent.sent.length === 1)
    const end = nextTurnEnd(bus, parent.id)
    parentAgent.finishTurn()
    await end
    await until(() => userPrompts(tmp, parent.id).length === 1)
    expect(userPrompts(tmp, parent.id)[0]!.source).toBe(`child:${child.id}`)
    registry.shutdown()
  })

  it("a child's `keep-going` never answers the parent's structured question", async () => {
    const bus = createSessionEventBus()
    const registry = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: bus })
    const parentAgent = controllableAgentSession("acp-parent")
    const parent = registry.spawnAgent({
      workspaceSlug: "w",
      cwd: "/tmp",
      agentSession: parentAgent.session,
      adapterSlug: "mock",
    })
    const child = registry.spawnAgent({
      workspaceSlug: "w",
      cwd: "/tmp",
      agentSession: idleAgentSession("acp-child"),
      adapterSlug: "mock",
      parentSessionId: parent.id,
      depth: 1,
    })
    const answered: string[] = []
    bus.on("session:awaiting-question-answered", ev => answered.push(ev.answer))
    const desc = registry.get(parent.id)!
    desc.awaitingInput = true
    desc.awaitingQuestion = {
      source: "structured",
      text: "Context is at 80%. Continue fresh to avoid losing continuity?",
      options: ["continue-fresh", "keep-going"],
    }

    // Idle path.
    await registry.enqueuePrompt(parent.id, "keep-going", { source: `child:${child.id}` })
    expect(answered).toEqual([])
    await until(() => parentAgent.sent.length === 1)
    expect(parentAgent.sent[0]).toBe("keep-going")
    const end = nextTurnEnd(bus, parent.id)
    parentAgent.finishTurn()
    await end

    // Queue-drain path: park a child `keep-going` behind a busy turn, and
    // raise the question just as that turn ends (before the drain matches).
    await registry.enqueuePrompt(parent.id, "human: long job", {})
    expect(registry.get(parent.id)?.busy).toBe(true)
    const r = await registry.enqueuePrompt(parent.id, "keep-going", {
      queue: true,
      source: `child:${child.id}`,
    })
    expect(r.queued).toBe(true)
    const off = bus.on("session:turn-end", () => {
      off()
      desc.awaitingInput = true
      desc.awaitingQuestion = {
        source: "structured",
        text: "Context is at 80%. Continue fresh to avoid losing continuity?",
        options: ["continue-fresh", "keep-going"],
      }
    })
    parentAgent.finishTurn()
    await until(() => parentAgent.sent.length === 3)
    expect(parentAgent.sent[2]).toBe("keep-going")
    expect(answered).toEqual([])
    const end3 = nextTurnEnd(bus, parent.id)
    parentAgent.finishTurn()
    await end3
    registry.shutdown()
  })

  it("a HUMAN `keep-going` still answers it (control)", async () => {
    const bus = createSessionEventBus()
    const registry = createSessionsRegistry({ persist: false, transcriptDir: tmp, sessionEvents: bus })
    const parent = registry.spawnAgent({
      workspaceSlug: "w",
      cwd: "/tmp",
      agentSession: controllableAgentSession("acp-parent").session,
      adapterSlug: "mock",
    })
    const answered: string[] = []
    bus.on("session:awaiting-question-answered", ev => answered.push(ev.answer))
    const desc = registry.get(parent.id)!
    desc.awaitingInput = true
    desc.awaitingQuestion = {
      source: "structured",
      text: "Context is at 80%. Continue fresh to avoid losing continuity?",
      options: ["continue-fresh", "keep-going"],
    }
    await registry.enqueuePrompt(parent.id, "keep-going", {})
    expect(answered).toEqual(["keep-going"])
    registry.shutdown()
  })
})

describe("isChildPromptSource", () => {
  it("matches only the child: provenance", () => {
    expect(isChildPromptSource("child:sess_1")).toBe(true)
    expect(isChildPromptSource("agent:sess_1")).toBe(false)
    expect(isChildPromptSource(undefined)).toBe(false)
  })
})

describe("migratePendingChildNotices (retired pendingChildCrashNotices)", () => {
  it("moves persisted notices to the back of promptQueue as child-sourced items and drops the field", () => {
    const desc = {
      id: "sess_x",
      promptQueue: [{ id: "q_old", message: "human queued", queuedAt: "2026-01-01T00:00:00.000Z" }],
      pendingChildCrashNotices: ["[child-crashed] w1: crashed", "[child-message] w2 (sess_2): hi"],
    } as unknown as SessionDescriptor
    migratePendingChildNotices(desc)
    expect(desc.pendingChildCrashNotices).toBeUndefined()
    expect(desc.promptQueue).toEqual([
      { id: "q_old", message: "human queued", queuedAt: "2026-01-01T00:00:00.000Z" },
      expect.objectContaining({
        message: "[child-crashed] w1: crashed",
        source: LEGACY_CHILD_NOTICE_SOURCE,
        origin: LEGACY_CHILD_NOTICE_SOURCE,
      }),
      expect.objectContaining({ message: "[child-message] w2 (sess_2): hi", source: LEGACY_CHILD_NOTICE_SOURCE }),
    ])
  })

  it("an empty array is just dropped; a descriptor without the field is untouched", () => {
    const a = { id: "a", pendingChildCrashNotices: [] } as unknown as SessionDescriptor
    migratePendingChildNotices(a)
    expect("pendingChildCrashNotices" in a).toBe(false)
    expect(a.promptQueue).toBeUndefined()
    const b = { id: "b" } as unknown as SessionDescriptor
    migratePendingChildNotices(b)
    expect(b).toEqual({ id: "b" })
  })

  it("runs at boot when loading a persisted snapshot", () => {
    const tmp = mkdtempSync(join(tmpdir(), "child-msg-migrate-"))
    try {
      const persistPath = join(tmp, "sessions.json")
      writeFileSync(
        persistPath,
        JSON.stringify({
          sessions: [
            {
              id: "sess_parent1",
              kind: "agent-cli",
              workspaceSlug: "w",
              command: "mock",
              pid: null,
              cwd: "/tmp",
              startedAt: "2026-09-01T00:00:00.000Z",
              status: "running",
              pendingChildCrashNotices: ["[child-crashed] w1: crashed"],
            },
          ],
        }),
      )
      const registry = createSessionsRegistry({ persistPath, transcriptDir: tmp })
      const desc = registry.get("sess_parent1")!
      expect(desc.pendingChildCrashNotices).toBeUndefined()
      expect(desc.promptQueue).toEqual([
        expect.objectContaining({ message: "[child-crashed] w1: crashed", source: LEGACY_CHILD_NOTICE_SOURCE }),
      ])
      registry.shutdown()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
