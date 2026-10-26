/**
 * Host-recorded `silent` turn-end from an explicit no-op ack.
 *
 * A woken agent that decides "nothing to do" says so through
 * `inbox_ack({ noop: true })`. The HOST records that against the current turn
 * and only then marks the turn-end `silent`, never by reading prose. These
 * tests drive the real registry + real MCP message tools and assert the guard
 * rails: one noop ack and nothing else on a daemon-origin wake is silent;
 * any other tool call, assistant text, blocker/question ack, error, interrupt,
 * awaiting-input stop, ack without `noop`, or human-origin prompt is not.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerMessageTools } from "../message-tools.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type SessionsRegistry,
} from "../sessions.js"
import { createSessionEventBus, type SessionTurnEndEvent } from "../session-event-bus.js"
import { createSessionMessage, type MessageKind } from "../session-message.js"

interface Scenario {
  /** Absent = human-origin prompt. */
  promptSource?: string
  /** Omit for the noop case; pass an explicit kind to seed the inbox. */
  ackKind?: MessageKind
  noop?: boolean
  assistantText?: boolean
  extraToolCall?: boolean
  turnEndReason?: string
  inBandError?: boolean
  interrupt?: boolean
}

interface Harness {
  id: string
  registry: SessionsRegistry
  turnEnds: SessionTurnEndEvent[]
  ackResult: () => { text: string; isError: boolean }
  run: () => Promise<void>
}

async function harness(sessionId: string, scenario: Scenario): Promise<Harness> {
  const sessionEvents = createSessionEventBus()
  const registry = createSessionsRegistry({ persist: false, sessionEvents })
  const turnEnds: SessionTurnEndEvent[] = []
  sessionEvents.on("session:turn-end", ev => turnEnds.push(ev))

  let callTool:
    | ((name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>)
    | undefined
  let ackResult = { text: "", isError: false }
  let targetId = ""

  const agent: AgentSessionLike = {
    sessionId,
    async *send() {
      if (scenario.ackKind !== undefined) {
        await registry.sendMessage(
          createSessionMessage({
            to: targetId,
            from: { relation: "system" },
            kind: scenario.ackKind,
            urgency: "fyi",
            text: `${scenario.ackKind} message`,
          }),
        )
      }
      yield {
        kind: "tool-call",
        toolName: "inbox_ack",
        toolCallId: "ack-1",
        arguments: { ids: "all", ...(scenario.noop === false ? {} : { noop: true }) },
      }
      ackResult = await callTool!("inbox_ack", {
        ids: "all",
        ...(scenario.noop === false ? {} : { noop: true }),
      })
      yield { kind: "tool-result", toolName: "inbox_ack", toolCallId: "ack-1", result: ackResult.text }
      if (scenario.extraToolCall) {
        yield { kind: "tool-call", toolName: "read", toolCallId: "read-1", arguments: {} }
        yield { kind: "tool-result", toolName: "read", toolCallId: "read-1", result: "ok" }
      }
      if (scenario.assistantText) {
        yield { kind: "text-delta", text: "nothing to do\n" }
      }
      if (scenario.interrupt) {
        void registry.interruptSession(targetId)
        await new Promise(r => setTimeout(r, 0))
      }
      if (scenario.inBandError) {
        yield { kind: "error", error: { message: "provider failed" } }
      }
      yield { kind: "turn-end", reason: scenario.turnEndReason ?? "completed" }
    },
    async cancel() {},
    async close() {},
  }

  const desc = registry.spawnAgent({
    workspaceSlug: "default",
    cwd: "/tmp",
    agentSession: agent,
    adapterSlug: "fake",
  })
  targetId = desc.id

  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  registerMessageTools(server, { registry, callerSessionId: desc.id })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: "t", version: "0" })
  await client.connect(ct)

  callTool = async (name, args) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    return { text: r.content[0]!.text, isError: r.isError === true }
  }

  return {
    id: desc.id,
    registry,
    turnEnds,
    ackResult: () => ackResult,
    run: async () => {
      await registry.sendPrompt(
        desc.id,
        "wake",
        scenario.promptSource ? { source: scenario.promptSource } : undefined,
      )
      await client.close()
    },
  }
}

describe("silent turn-end from a noop ack", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "silent-turn-"))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  const silentDesc = (registry: SessionsRegistry, id: string): boolean | undefined =>
    (registry.get(id) as unknown as { lastTurnSilent?: boolean } | undefined)?.lastTurnSilent

  it("marks a daemon-origin wake silent when the only action is a noop ack", async () => {
    const h = await harness("w1", {
      promptSource: "session-follow",
      ackKind: "report",
      noop: true,
    })
    await h.run()
    expect(h.turnEnds).toHaveLength(1)
    expect(h.turnEnds[0]!.silent).toBe(true)
    expect(h.turnEnds[0]!.empty).toBeUndefined()
    expect(silentDesc(h.registry, h.id)).toBe(true)
    h.registry.shutdown()
  })

  it("is not silent when the noop ack comes with any other tool call", async () => {
    const h = await harness("w2", {
      promptSource: "session-follow",
      ackKind: "report",
      noop: true,
      extraToolCall: true,
    })
    await h.run()
    expect(h.turnEnds[0]!.silent).toBeUndefined()
    h.registry.shutdown()
  })

  it("is not silent when the noop ack comes with assistant text", async () => {
    const h = await harness("w3", {
      promptSource: "session-follow",
      ackKind: "report",
      noop: true,
      assistantText: true,
    })
    await h.run()
    expect(h.turnEnds[0]!.silent).toBeUndefined()
    h.registry.shutdown()
  })

  it("is not silent when a blocker or question message was acked", async () => {
    for (const [id, kind] of [
      ["w4", "blocker"],
      ["w5", "question"],
    ] as const) {
      const h = await harness(id, {
        promptSource: "session-follow",
        ackKind: kind,
        noop: true,
      })
      await h.run()
      expect(h.turnEnds[0]!.silent).toBeUndefined()
      h.registry.shutdown()
    }
  })

  it("is not silent on an errored, interrupted, or awaiting-input turn", async () => {
    const errored = await harness("w6", {
      promptSource: "session-follow",
      ackKind: "report",
      noop: true,
      turnEndReason: "error",
      inBandError: true,
    })
    await errored.run()
    expect(errored.turnEnds[0]!.silent).toBeUndefined()

    const interrupted = await harness("w7", {
      promptSource: "session-follow",
      ackKind: "report",
      noop: true,
      interrupt: true,
    })
    await interrupted.run()
    expect(interrupted.turnEnds[0]!.interrupted).toBe(true)
    expect(interrupted.turnEnds[0]!.silent).toBeUndefined()

    const awaiting = await harness("w8", {
      promptSource: "session-follow",
      ackKind: "report",
      noop: true,
      turnEndReason: "awaiting-input",
    })
    await awaiting.run()
    expect(awaiting.turnEnds[0]!.awaitingInput).toBe(true)
    expect(awaiting.turnEnds[0]!.silent).toBeUndefined()

    errored.registry.shutdown()
    interrupted.registry.shutdown()
    awaiting.registry.shutdown()
  })

  it("is not silent on a human-origin prompt", async () => {
    const h = await harness("w9", { ackKind: "report", noop: true })
    await h.run()
    expect(h.turnEnds[0]!.silent).toBeUndefined()
    h.registry.shutdown()
  })

  it("an ack without noop is not silent and its result is unchanged", async () => {
    const h = await harness("w10", {
      promptSource: "session-follow",
      ackKind: "report",
      noop: false,
    })
    await h.run()
    expect(h.turnEnds[0]!.silent).toBeUndefined()
    const ack = h.ackResult()
    expect(ack.isError).toBe(false)
    expect(ack.text).toMatch(/^\{"ok":true,"acked":\["msg_[a-f0-9]{8}"\]\}$/)
    expect(Object.keys(JSON.parse(ack.text))).toEqual(["ok", "acked"])
    h.registry.shutdown()
  })
})
