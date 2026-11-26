import { describe, it, expect, afterEach } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createEventRing } from "../event-ring.js"
import { registerOrchestrationTools } from "../orchestration-tools.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type SessionsRegistry,
} from "../sessions.js"
import {
  MODERN_PROTOCOL_VERSION,
  createHumanGate,
  createMrtrStateStore,
  type HumanGateAuditEntry,
} from "../mcp-modern/index.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

type Json = Record<string, any>

const OPTIONS = [
  { optionId: "opt-once", name: "Allow once", kind: "allow_once" },
  { optionId: "opt-always", name: "Allow always", kind: "allow_always" },
  { optionId: "opt-reject", name: "Reject", kind: "reject_once" },
]

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

function noopConversations(): ConversationStore {
  return {
    async open() {},
    async appendTurn() {},
    async read() {
      return { meta: {} as never, turns: [] }
    },
    async list() {
      return []
    },
    pathFor: (id: string) => id,
  }
}

function noopHeartbeat(): HeartbeatRunner {
  return { start() {}, stop() {}, async fireNow() {} }
}

function holdSession(opts: {
  requestId?: string
  toolName?: string
  text?: string
  extra?: Record<string, unknown>
} = {}): {
  session: AgentSessionLike
  responded: Array<{ requestId: string; resolution: unknown }>
  done: Promise<void>
} {
  const requestId = opts.requestId ?? "perm-1"
  const toolName = opts.toolName ?? "Write"
  const responded: Array<{ requestId: string; resolution: unknown }> = []
  let release: (() => void) | null = null
  let markDone!: () => void
  const done = new Promise<void>(resolve => {
    markDone = resolve
  })
  const session: AgentSessionLike = {
    sessionId: `acp-${requestId}`,
    pid: 4242,
    async *send() {
      yield {
        kind: "agent-prompt",
        toolCallId: requestId,
        toolName,
        text: opts.text ?? `Allow "${toolName}"?`,
        options: OPTIONS,
        ...(opts.extra ?? {}),
      }
      await new Promise<void>(r => {
        release = r
      })
      yield { kind: "turn-end", reason: "completed" }
      markDone()
    },
    respondPermission(id, resolution) {
      responded.push({ requestId: id, resolution })
      release?.()
      return true
    },
    async cancel() {},
    async close() {
      release?.()
    },
  }
  return { session, responded, done }
}

async function spawnAndPark(
  registry: SessionsRegistry,
  fake: { session: AgentSessionLike },
  parentSessionId?: string,
): Promise<string> {
  const desc = registry.spawnAgent({
    workspaceSlug: "default",
    cwd: process.cwd(),
    agentSession: fake.session,
    adapterSlug: "claude-code",
    permissionHold: true,
    label: "held-session",
    ...(parentSessionId ? { parentSessionId } : {}),
  })
  void registry.sendPrompt(desc.id, "go").catch(() => {})
  for (let i = 0; i < 100; i++) {
    if (registry.listPendingPermissions({ sessionId: desc.id }).length > 0) break
    await new Promise(r => setTimeout(r, 5))
  }
  return desc.id
}

async function callModernTool(
  baseUrl: string,
  name: string,
  args: Json,
  opts: {
    id?: number
    elicitation?: Json | null
    requestState?: string
    inputResponses?: Json
    query?: string
  } = {},
) {
  const clientCapabilities =
    opts.elicitation === null ? {} : { elicitation: opts.elicitation ?? { form: {} } }
  const params: Json = {
    name,
    arguments: args,
    ...(opts.requestState !== undefined ? { requestState: opts.requestState } : {}),
    ...(opts.inputResponses !== undefined ? { inputResponses: opts.inputResponses } : {}),
    _meta: {
      "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
      "io.modelcontextprotocol/clientCapabilities": clientCapabilities,
    },
  }
  const res = await fetch(`${baseUrl}/mcp${opts.query ?? ""}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
      "mcp-method": "tools/call",
      "mcp-name": name,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: opts.id ?? 1, method: "tools/call", params }),
  })
  return { status: res.status, json: (await res.json()) as Json }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!()
  }
})

async function startRig(opts: { enableHumanGate?: boolean; mrtrDir?: string; bootId?: string } = {}) {
  const dir = opts.mrtrDir ?? mkdtempSync(join(tmpdir(), "agentproto-mrtr-e2e-"))
  if (!opts.mrtrDir) {
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }))
  }
  const sessionEvents = createSessionEventBus()
  const eventRing = createEventRing()
  const registry = createSessionsRegistry({ persist: false, sessionEvents })
  const stateStore = createMrtrStateStore({ dir, ...(opts.bootId ? { bootId: opts.bootId } : {}) })
  const audits: HumanGateAuditEntry[] = []
  const humanGate = createHumanGate({
    sessions: registry,
    stateStore,
    onAudit: entry => audits.push(entry),
  })

  const port = await freePort()
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    sessions: registry,
    mcpServerFactory: async (_deny, callerSessionId) => {
      const { server } = await createMcpServer({ specs: [], name: "elicit-e2e", version: "1.0.0" })
      registerOrchestrationTools(server, {
        registry,
        sessionEvents,
        eventRing,
        ...(callerSessionId ? { callerSessionId } : {}),
      })
      return server
    },
    mcpModern: {
      enabled: true,
      extensions: {},
      ...(opts.enableHumanGate !== false ? { humanGate } : {}),
    },
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    meta: { workspace: process.cwd(), registered: [] },
  })
  cleanups.push(async () => {
    await http.stop()
    registry.shutdown()
  })

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    registry,
    stateStore,
    audits,
    dir,
  }
}

describe("MCP 2026-07-28 elicitation (MRTR) e2e over /mcp", () => {
  it("surfaces a parked permission as input_required, unblocks on accept replay, and logs principal", async () => {
    const rig = await startRig()
    const fake = holdSession({ requestId: "perm-approve", toolName: "Write" })
    const sid = await spawnAndPark(rig.registry, fake)

    const first = await callModernTool(rig.baseUrl, "permissions_list", { sessionId: sid }, { id: 1 })
    expect(first.status).toBe(200)
    expect(first.json.result.resultType).toBe("input_required")
    expect(first.json.result).not.toHaveProperty("ttlMs")
    expect(first.json.result).not.toHaveProperty("cacheScope")
    expect(typeof first.json.result.requestState).toBe("string")
    const reqKey = Object.keys(first.json.result.inputRequests)[0]!
    expect(first.json.result.inputRequests[reqKey].method).toBe("elicitation/create")
    expect(first.json.result.inputRequests[reqKey].params.mode).toBe("form")

    // Replay with a new JSON-RPC id and exact requestState.
    const replay = await callModernTool(
      rig.baseUrl,
      "permissions_list",
      { sessionId: sid },
      {
        id: 2,
        requestState: first.json.result.requestState,
        inputResponses: {
          [reqKey]: { action: "accept", content: { decision: "approve", scope: "once" } },
        },
      },
    )
    expect(replay.status).toBe(200)
    expect(replay.json.result.resultType).toBe("complete")
    await fake.done
    expect(fake.responded).toHaveLength(1)
    expect(fake.responded[0]?.resolution).toMatchObject({ optionId: "opt-once" })
    expect(rig.audits).toContainEqual(
      expect.objectContaining({ principal: "operator", kind: "permission", entityId: "perm-approve", action: "accept", applied: true }),
    )
  })

  it("denies a parked permission on decline and leaves it pending on cancel", async () => {
    const rig = await startRig()
    const fake = holdSession({ requestId: "perm-decline", toolName: "Bash" })
    const sid = await spawnAndPark(rig.registry, fake)

    // Cancel leaves the permission parked.
    const first = await callModernTool(rig.baseUrl, "permissions_list", { sessionId: sid }, { id: 1 })
    const reqKey = Object.keys(first.json.result.inputRequests)[0]!
    const cancelled = await callModernTool(
      rig.baseUrl,
      "permissions_list",
      { sessionId: sid },
      {
        id: 2,
        requestState: first.json.result.requestState,
        inputResponses: { [reqKey]: { action: "cancel" } },
      },
    )
    expect(cancelled.json.result.resultType).toBe("complete")
    expect(rig.registry.listPendingPermissions({ sessionId: sid })).toHaveLength(1)

    // Decline rejects and unblocks.
    const second = await callModernTool(rig.baseUrl, "permissions_list", { sessionId: sid }, { id: 3 })
    const declined = await callModernTool(
      rig.baseUrl,
      "permissions_list",
      { sessionId: sid },
      {
        id: 4,
        requestState: second.json.result.requestState,
        inputResponses: { [reqKey]: { action: "decline" } },
      },
    )
    expect(declined.json.result.resultType).toBe("complete")
    await fake.done
    expect(fake.responded[0]?.resolution).toMatchObject({ optionId: "opt-reject" })
  })

  it("projects multi-field question.fields and answers via respondPermission({ answers })", async () => {
    const rig = await startRig()
    const fake = holdSession({
      requestId: "q-multi",
      text: "Deployment questions",
      extra: {
        request: "question",
        question: {
          prompt: "Configure release",
          choices: [],
          allowFreeText: false,
          fields: [
            {
              id: "env",
              input: "single",
              prompt: "Environment",
              required: true,
              choices: [
                { value: "staging", label: "Staging" },
                { value: "prod", label: "Production" },
              ],
            },
            { id: "confirm", input: "boolean", prompt: "Proceed?" },
          ],
        },
      },
    })
    const sid = await spawnAndPark(rig.registry, fake)

    const first = await callModernTool(rig.baseUrl, "permissions_list", { sessionId: sid }, { id: 1 })
    expect(first.json.result.resultType).toBe("input_required")
    const reqKey = Object.keys(first.json.result.inputRequests)[0]!

    // Missing required field returns a fresh InputRequiredResult instead of an error.
    const incomplete = await callModernTool(
      rig.baseUrl,
      "permissions_list",
      { sessionId: sid },
      {
        id: 2,
        requestState: first.json.result.requestState,
        inputResponses: { [reqKey]: { action: "accept", content: { confirm: true } } },
      },
    )
    expect(incomplete.json.result.resultType).toBe("input_required")
    expect(incomplete.json.result.requestState).not.toBe(first.json.result.requestState)

    // Complete answer unblocks the session.
    const replay = await callModernTool(
      rig.baseUrl,
      "permissions_list",
      { sessionId: sid },
      {
        id: 3,
        requestState: incomplete.json.result.requestState,
        inputResponses: {
          [reqKey]: { action: "accept", content: { env: "staging", confirm: true } },
        },
      },
    )
    expect(replay.json.result.resultType).toBe("complete")
    await fake.done
    expect(fake.responded[0]?.resolution).toEqual({
      answers: { env: { selected: ["staging"] }, confirm: { value: true } },
    })
  })

  it("forbids self-approval (pending.sessionId === callerSessionId) and out-of-subtree resolution", async () => {
    const rig = await startRig()
    const parent = rig.registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: holdSession({ requestId: "unused-parent" }).session,
      adapterSlug: "claude-code",
      label: "parent",
    })
    const outsider = rig.registry.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession: holdSession({ requestId: "unused-outsider" }).session,
      adapterSlug: "claude-code",
      label: "outsider",
    })

    const fakeChild = holdSession({ requestId: "perm-child", toolName: "Bash" })
    const childId = await spawnAndPark(rig.registry, fakeChild, parent.id)

    // The blocked child itself NEVER gets input_required for its own permission.
    const selfCall = await callModernTool(
      rig.baseUrl,
      "permissions_list",
      { sessionId: childId },
      { id: 1, query: `?callerSessionId=${childId}` },
    )
    expect(selfCall.json.result.resultType).toBe("complete")

    // An outsider session outside the subtree NEVER gets input_required either.
    const outsiderCall = await callModernTool(
      rig.baseUrl,
      "permissions_list",
      { sessionId: childId },
      { id: 2, query: `?callerSessionId=${outsider.id}` },
    )
    expect(outsiderCall.json.result.resultType).toBe("complete")

    // The parent in subtree CAN elicit and resolve its child's permission.
    const parentCall = await callModernTool(
      rig.baseUrl,
      "permissions_list",
      { sessionId: childId },
      { id: 3, query: `?callerSessionId=${parent.id}` },
    )
    expect(parentCall.json.result.resultType).toBe("input_required")
    const reqKey = Object.keys(parentCall.json.result.inputRequests)[0]!
    const stateForParent = parentCall.json.result.requestState as string

    // Replaying parent's token from child or outsider is refused (-32602).
    const stolenByChild = await callModernTool(
      rig.baseUrl,
      "permissions_list",
      { sessionId: childId },
      {
        id: 4,
        query: `?callerSessionId=${childId}`,
        requestState: stateForParent,
        inputResponses: { [reqKey]: { action: "accept", content: { decision: "approve" } } },
      },
    )
    expect(stolenByChild.json.error?.code).toBe(-32602)

    // Replaying parent's token with altered arguments is refused (-32602).
    const alteredArgs = await callModernTool(
      rig.baseUrl,
      "permissions_list",
      { sessionId: "other-session" },
      {
        id: 5,
        query: `?callerSessionId=${parent.id}`,
        requestState: stateForParent,
        inputResponses: { [reqKey]: { action: "accept", content: { decision: "approve" } } },
      },
    )
    expect(alteredArgs.json.error?.code).toBe(-32602)

    // Original parent succeeds.
    const parentReplay = await callModernTool(
      rig.baseUrl,
      "permissions_list",
      { sessionId: childId },
      {
        id: 6,
        query: `?callerSessionId=${parent.id}`,
        requestState: stateForParent,
        inputResponses: { [reqKey]: { action: "accept", content: { decision: "approve" } } },
      },
    )
    expect(parentReplay.json.result.resultType).toBe("complete")
    await fakeChild.done
    expect(rig.audits).toContainEqual(
      expect.objectContaining({ principal: parent.id, entityId: "perm-child", applied: true }),
    )
  })

  it("never produces input_required when client lacks elicitation capability or humanGate is disabled", async () => {
    const rig = await startRig()
    const fake = holdSession({ requestId: "perm-nocap", toolName: "Write" })
    const sid = await spawnAndPark(rig.registry, fake)

    const noCap = await callModernTool(rig.baseUrl, "permissions_list", { sessionId: sid }, { elicitation: null })
    expect(noCap.json.result.resultType).toBe("complete")

    const urlOnly = await callModernTool(rig.baseUrl, "permissions_list", { sessionId: sid }, { elicitation: { url: {} } })
    expect(urlOnly.json.result.resultType).toBe("complete")

    const disabledRig = await startRig({ enableHumanGate: false })
    const fake2 = holdSession({ requestId: "perm-disabled", toolName: "Write" })
    const sid2 = await spawnAndPark(disabledRig.registry, fake2)
    const disabled = await callModernTool(disabledRig.baseUrl, "permissions_list", { sessionId: sid2 })
    expect(disabled.json.result.resultType).toBe("complete")
  })

  it("returns deterministic input_unavailable when replaying a permission token after simulated restart", async () => {
    const sharedDir = mkdtempSync(join(tmpdir(), "agentproto-mrtr-restart-"))
    cleanups.push(async () => rmSync(sharedDir, { recursive: true, force: true }))

    const rig1 = await startRig({ mrtrDir: sharedDir, bootId: "boot-alpha" })
    const fake = holdSession({ requestId: "perm-restart", toolName: "Write" })
    const sid = await spawnAndPark(rig1.registry, fake)

    const first = await callModernTool(rig1.baseUrl, "permissions_list", { sessionId: sid }, { id: 1 })
    expect(first.json.result.resultType).toBe("input_required")
    const reqKey = Object.keys(first.json.result.inputRequests)[0]!
    const staleToken = first.json.result.requestState as string

    // Simulated daemon restart on the same MRTR directory with a new bootId.
    const rig2 = await startRig({ mrtrDir: sharedDir, bootId: "boot-beta" })
    const replayed = await callModernTool(
      rig2.baseUrl,
      "permissions_list",
      { sessionId: sid },
      {
        id: 2,
        requestState: staleToken,
        inputResponses: { [reqKey]: { action: "accept", content: { decision: "approve" } } },
      },
    )
    expect(replayed.json.error?.code).toBe(-32602)
    expect(replayed.json.error?.data).toEqual({ reason: "input_unavailable" })
  })
})
