import { describe, it, expect, vi, beforeEach } from "vitest"
import { PassThrough } from "node:stream"
import type { ChildProcess } from "node:child_process"

// Capture the args every `client.newSession` / `client.loadSession` call
// receives, so the test can prove the host's `mcpServers` survives the
// hop through AcpProtocolArm.connect → @agentproto/acp client.
const newSessionCalls: Array<Record<string, unknown>> = []
const loadSessionCalls: Array<Record<string, unknown>> = []

/** Injected per-test: when set, newSession throws with this error. */
let newSessionError: Error | null = null

vi.mock("@agentproto/acp/client", () => ({
  createAcpClient: vi.fn(async () => ({
    agentCapabilities: {},
    async newSession(params: Record<string, unknown>) {
      newSessionCalls.push(params)
      if (newSessionError) throw newSessionError
      return { sessionId: "sess-1" }
    },
    async loadSession(params: Record<string, unknown>) {
      loadSessionCalls.push(params)
      return { sessionId: params.sessionId }
    },
  })),
}))

import { createAcpClient } from "@agentproto/acp/client"
import {
  createAcpProtocolArm,
  planModePermissionHandler,
  type AcpPermissionHandler,
} from "../acp-client.js"

/** A minimal ChildProcess stand-in with piped stdio the arm can wrap. */
function fakeChild(): ChildProcess {
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
  } as unknown as ChildProcess
}

/** The two always-present connect fields the runner fills in before the
 *  arm sees them — irrelevant to mcpServers threading, so stubbed. */
const baseConnect = { env: {}, abortSignal: new AbortController().signal }

describe("AcpProtocolArm.connect — mcpServers threading", () => {
  beforeEach(() => {
    newSessionCalls.length = 0
    loadSessionCalls.length = 0
    newSessionError = null
  })

  it("forwards host mcpServers to client.newSession on a fresh session", async () => {
    const arm = createAcpProtocolArm({ child: fakeChild(), cwd: "/work" })
    const mcpServers = [
      { name: "orchestrator", transport: "stdio" as const, ref: "./O.md" },
    ]
    await arm.connect({ ...baseConnect, cwd: "/work", mcpServers })

    expect(newSessionCalls).toHaveLength(1)
    expect(newSessionCalls[0]).toEqual({ cwd: "/work", mcpServers })
  })

  it("forwards host mcpServers to client.loadSession on resume", async () => {
    const arm = createAcpProtocolArm({ child: fakeChild(), cwd: "/work" })
    const mcpServers = [{ name: "gw", transport: "http" as const }]
    await arm.connect({
      ...baseConnect,
      cwd: "/work",
      resumeSessionId: "prev-123",
      mcpServers,
    })

    expect(loadSessionCalls).toHaveLength(1)
    expect(loadSessionCalls[0]).toEqual({
      sessionId: "prev-123",
      cwd: "/work",
      mcpServers,
    })
  })

  it("omits mcpServers when the host provides none", async () => {
    const arm = createAcpProtocolArm({ child: fakeChild(), cwd: "/work" })
    await arm.connect({ ...baseConnect, cwd: "/work" })

    expect(newSessionCalls).toHaveLength(1)
    expect(newSessionCalls[0]).toEqual({ cwd: "/work", mcpServers: undefined })
  })
})

describe("AcpProtocolArm.connect — model + effort threading", () => {
  beforeEach(() => {
    newSessionCalls.length = 0
    newSessionError = null
  })

  it("forwards model and effort to client.newSession", async () => {
    const arm = createAcpProtocolArm({ child: fakeChild(), cwd: "/work" })
    await arm.connect({
      ...baseConnect,
      cwd: "/work",
      model: "claude-haiku-4-5-20251001",
      effort: "low",
    })

    expect(newSessionCalls).toHaveLength(1)
    expect(newSessionCalls[0]).toMatchObject({
      cwd: "/work",
      model: "claude-haiku-4-5-20251001",
      effort: "low",
    })
  })

  it("omits model and effort when not provided", async () => {
    const arm = createAcpProtocolArm({ child: fakeChild(), cwd: "/work" })
    await arm.connect({ ...baseConnect, cwd: "/work" })

    expect(newSessionCalls[0]).not.toHaveProperty("model")
    expect(newSessionCalls[0]).not.toHaveProperty("effort")
  })

  it("forwards mode to client.newSession (opencode-style config-applied mode)", async () => {
    const arm = createAcpProtocolArm({ child: fakeChild(), cwd: "/work" })
    await arm.connect({ ...baseConnect, cwd: "/work", mode: "plan" })

    expect(newSessionCalls).toHaveLength(1)
    expect(newSessionCalls[0]).toMatchObject({ cwd: "/work", mode: "plan" })
  })

  it("omits mode when not provided", async () => {
    const arm = createAcpProtocolArm({ child: fakeChild(), cwd: "/work" })
    await arm.connect({ ...baseConnect, cwd: "/work" })

    expect(newSessionCalls[0]).not.toHaveProperty("mode")
  })
})

describe("AcpProtocolArm.connect — onActivity threading", () => {
  it("forwards onActivity from connect options to createAcpClient", async () => {
    const arm = createAcpProtocolArm({ child: fakeChild(), cwd: "/work" })
    const onActivity = vi.fn()
    await arm.connect({ ...baseConnect, cwd: "/work", onActivity })

    expect(vi.mocked(createAcpClient)).toHaveBeenCalledWith(
      expect.objectContaining({ onActivity }),
    )
  })

  it("passes onActivity: undefined through when the host doesn't supply one", async () => {
    const arm = createAcpProtocolArm({ child: fakeChild(), cwd: "/work" })
    await arm.connect({ ...baseConnect, cwd: "/work" })

    expect(vi.mocked(createAcpClient)).toHaveBeenCalledWith(
      expect.objectContaining({ onActivity: undefined }),
    )
  })
})

describe("AcpProtocolArm.connect — turnIdleTimeoutMs threading", () => {
  it("forwards turnIdleTimeoutMs from connect options to createAcpClient", async () => {
    const arm = createAcpProtocolArm({ child: fakeChild(), cwd: "/work" })
    await arm.connect({ ...baseConnect, cwd: "/work", turnIdleTimeoutMs: 300_000 })

    expect(vi.mocked(createAcpClient)).toHaveBeenCalledWith(
      expect.objectContaining({ turnIdleTimeoutMs: 300_000 }),
    )
  })

  it("passes turnIdleTimeoutMs: undefined through when the host doesn't supply one", async () => {
    const arm = createAcpProtocolArm({ child: fakeChild(), cwd: "/work" })
    await arm.connect({ ...baseConnect, cwd: "/work" })

    expect(vi.mocked(createAcpClient)).toHaveBeenCalledWith(
      expect.objectContaining({ turnIdleTimeoutMs: undefined }),
    )
  })
})

// Regression coverage for the plan-mode auto-allow bug: a session spawned
// with mode:"plan" wrote a file anyway because the default permission
// handler auto-approved Claude Code's "ready to code?" (ExitPlanMode)
// escalation, whose options carry the same allow_always/allow_once/
// reject_once kinds as any ordinary tool approval — the only reliable
// discriminator is `toolCall.kind === "switch_mode"` (confirmed by
// reading the installed @agentclientprotocol/claude-agent-acp@0.54.1
// wrapper's compiled source).
const switchModeExit = {
  sessionId: "sess-1",
  toolCall: { toolCallId: "t1", kind: "switch_mode", title: "Ready to code?" },
  options: [
    { optionId: "auto", kind: "allow_always", name: 'Yes, and use "auto" mode' },
    { optionId: "acceptEdits", kind: "allow_always", name: "Yes, and auto-accept edits" },
    { optionId: "default", kind: "allow_once", name: "Yes, and manually approve edits" },
    { optionId: "plan", kind: "reject_once", name: "No, keep planning" },
  ],
}

const ordinaryWriteApproval = {
  sessionId: "sess-1",
  toolCall: { toolCallId: "t2", kind: "edit", title: "canary.txt" },
  options: [
    { optionId: "allow_always", kind: "allow_always", name: "Always allow Write" },
    { optionId: "allow", kind: "allow_once", name: "Allow" },
    { optionId: "reject", kind: "reject_once", name: "Reject" },
  ],
}

describe("planModePermissionHandler", () => {
  it("rejects the plan-mode-exit escalation by selecting the reject_once option", async () => {
    const outcome = await planModePermissionHandler(switchModeExit)
    expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "plan" } })
  })

  it("falls back to cancelled for a switch_mode request with no reject_once option offered", async () => {
    const outcome = await planModePermissionHandler({
      ...switchModeExit,
      options: switchModeExit.options.filter(o => o.kind !== "reject_once"),
    })
    expect(outcome).toEqual({ outcome: { outcome: "cancelled" } })
  })

  it("still auto-approves an ordinary tool permission request", async () => {
    const outcome = await planModePermissionHandler(ordinaryWriteApproval)
    expect(outcome).toEqual({
      outcome: { outcome: "selected", optionId: "allow_always" },
    })
  })

  it("returns cancelled when no options are offered at all", async () => {
    const outcome = await planModePermissionHandler({ sessionId: "sess-1" })
    expect(outcome).toEqual({ outcome: { outcome: "cancelled" } })
  })
})

describe("AcpProtocolArm.connect — permission handler selection by requestedMode", () => {
  function capturedRequestPermission(): AcpPermissionHandler {
    const call = vi.mocked(createAcpClient).mock.calls.at(-1)![0] as {
      handlers: { requestPermission: AcpPermissionHandler }
    }
    return call.handlers.requestPermission
  }

  it("guards against the plan-mode-exit escalation when requestedMode is 'plan' and no onPermissionRequest override is given", async () => {
    const arm = createAcpProtocolArm({
      child: fakeChild(),
      cwd: "/work",
      requestedMode: "plan",
    })
    await arm.connect({ ...baseConnect, cwd: "/work" })

    const outcome = await capturedRequestPermission()(switchModeExit)
    expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "plan" } })
  })

  it("still auto-approves ordinary tool permission requests when requestedMode is 'plan'", async () => {
    const arm = createAcpProtocolArm({
      child: fakeChild(),
      cwd: "/work",
      requestedMode: "plan",
    })
    await arm.connect({ ...baseConnect, cwd: "/work" })

    const outcome = await capturedRequestPermission()(ordinaryWriteApproval)
    expect(outcome).toEqual({
      outcome: { outcome: "selected", optionId: "allow_always" },
    })
  })

  it("does not guard the escalation when no mode was requested — today's default-mode behavior is unchanged", async () => {
    const arm = createAcpProtocolArm({ child: fakeChild(), cwd: "/work" })
    await arm.connect({ ...baseConnect, cwd: "/work" })

    const outcome = await capturedRequestPermission()(switchModeExit)
    // Same as autoAllowPermissionHandler: first allow_* option wins.
    expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "auto" } })
  })

  it("does not guard the escalation for a non-plan mode (e.g. 'accept-edits')", async () => {
    const arm = createAcpProtocolArm({
      child: fakeChild(),
      cwd: "/work",
      requestedMode: "accept-edits",
    })
    await arm.connect({ ...baseConnect, cwd: "/work" })

    const outcome = await capturedRequestPermission()(switchModeExit)
    expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "auto" } })
  })

  it("prefers a caller-supplied onPermissionRequest over the mode-aware default even when requestedMode is 'plan'", async () => {
    const custom = vi.fn(async () => ({
      outcome: { outcome: "cancelled" as const },
    }))
    const arm = createAcpProtocolArm({
      child: fakeChild(),
      cwd: "/work",
      requestedMode: "plan",
      onPermissionRequest: custom,
    })
    await arm.connect({ ...baseConnect, cwd: "/work" })

    await capturedRequestPermission()(ordinaryWriteApproval)
    expect(custom).toHaveBeenCalledWith(ordinaryWriteApproval)
  })
})
