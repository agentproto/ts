import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mock the ACP SDK (same pattern as client-on-activity.test.ts) so we can
// drive the `requestPermission` handler directly, as the SDK would when the
// agent raises a `session/request_permission` mid-turn.
// ---------------------------------------------------------------------------

const mockInitialize = vi.fn()
const mockNewSession = vi.fn()
const mockPrompt = vi.fn()
const mockCancel = vi.fn()

interface CapturedHandlers {
  requestPermission: (params: unknown) => Promise<unknown>
  sessionUpdate: (params: unknown) => Promise<void>
}
let capturedHandlersFactory: (() => CapturedHandlers) | undefined

vi.mock("@agentclientprotocol/sdk", () => ({
  ndJsonStream: () => ({}),
  ClientSideConnection: vi.fn().mockImplementation((handlersFactory: () => CapturedHandlers) => {
    capturedHandlersFactory = handlersFactory
    return {
      initialize: mockInitialize,
      newSession: mockNewSession,
      loadSession: vi.fn().mockResolvedValue({}),
      setSessionConfigOption: vi.fn().mockResolvedValue({}),
      prompt: mockPrompt,
      cancel: mockCancel,
      on: vi.fn(),
      off: vi.fn(),
    }
  }),
}))

import { createAcpClient } from "../client/index.js"
import type { StreamEvent } from "../types.js"

function fakeStreams() {
  return { output: new WritableStream(), input: new ReadableStream() }
}

const PERM_PARAMS = {
  sessionId: "sess-hold",
  toolCall: { toolCallId: "tc-1", title: "Write" },
  options: [
    { optionId: "a", name: "Allow once", kind: "allow_once" },
    { optionId: "r", name: "Reject", kind: "reject_once" },
  ],
}

describe("createAcpClient — permission-hold mode", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedHandlersFactory = undefined
    mockInitialize.mockResolvedValue({ agentCapabilities: {} })
    mockNewSession.mockResolvedValue({ sessionId: "sess-hold" })
    mockPrompt.mockReturnValue(new Promise(() => {})) // keep the turn open
    mockCancel.mockResolvedValue({})
  })

  it("surfaces requestPermission as an agent-prompt event and HOLDS the RPC", async () => {
    const client = await createAcpClient({ ...fakeStreams(), permissionHold: true })
    const session = await client.newSession({ cwd: "/tmp" })
    const iter = session
      .prompt({ messages: [{ type: "text", text: "go" }] })
      [Symbol.asyncIterator]()

    const handlers = capturedHandlersFactory!()
    let resolved: unknown
    const rpc = handlers.requestPermission(PERM_PARAMS).then(r => {
      resolved = r
    })

    const { value } = await iter.next()
    const evt = value as Extract<StreamEvent, { kind: "agent-prompt" }>
    expect(evt.kind).toBe("agent-prompt")
    expect(evt.text).toBe('Allow "Write"?')
    expect(evt.toolName).toBe("Write")
    expect(evt.toolCallId).toMatch(/^perm_/) // stable minted id
    // The RPC is still parked — nothing resolved it yet.
    await Promise.resolve()
    expect(resolved).toBeUndefined()

    // Respond with the allow option → the held RPC resolves with the ACP
    // `selected` outcome.
    const ok = client.respondPermission(evt.toolCallId, { optionId: "a" })
    expect(ok).toBe(true)
    await rpc
    expect(resolved).toEqual({ outcome: { outcome: "selected", optionId: "a" } })

    // Idempotent — a duplicate response finds nothing.
    expect(client.respondPermission(evt.toolCallId, { optionId: "a" })).toBe(false)
  })

  it("holds even when a handlers.requestPermission is ALSO supplied (guard not clobbered)", async () => {
    // Regression: the arm always passes a `requestPermission` handler. If that
    // handler reached the SDK it would auto-answer, silently defeating hold
    // mode. The hold guard must win and park the request instead.
    const autoAnswer = vi.fn(async () => ({
      outcome: { outcome: "selected", optionId: "a" },
    }))
    const client = await createAcpClient({
      ...fakeStreams(),
      permissionHold: true,
      handlers: { requestPermission: autoAnswer } as never,
    })
    const session = await client.newSession({ cwd: "/tmp" })
    const iter = session
      .prompt({ messages: [{ type: "text", text: "go" }] })
      [Symbol.asyncIterator]()

    const handlers = capturedHandlersFactory!()
    let resolved: unknown
    const rpc = handlers.requestPermission(PERM_PARAMS).then(r => {
      resolved = r
    })

    // Surfaced as agent-prompt — NOT auto-answered by the supplied handler.
    const { value } = await iter.next()
    const evt = value as Extract<StreamEvent, { kind: "agent-prompt" }>
    expect(evt.kind).toBe("agent-prompt")
    expect(autoAnswer).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(resolved).toBeUndefined()

    // Only an explicit inbox response resolves it — with OUR chosen option,
    // not the handler's.
    expect(client.respondPermission(evt.toolCallId, { optionId: "r" })).toBe(true)
    await rpc
    expect(resolved).toEqual({ outcome: { outcome: "selected", optionId: "r" } })
    expect(autoAnswer).not.toHaveBeenCalled()
  })

  it("maps a cancelled resolution to ACP's cancelled outcome", async () => {
    const client = await createAcpClient({ ...fakeStreams(), permissionHold: true })
    const session = await client.newSession({ cwd: "/tmp" })
    const iter = session
      .prompt({ messages: [{ type: "text", text: "go" }] })
      [Symbol.asyncIterator]()

    const handlers = capturedHandlersFactory!()
    let resolved: unknown
    const rpc = handlers.requestPermission(PERM_PARAMS).then(r => {
      resolved = r
    })
    const { value } = await iter.next()
    const evt = value as Extract<StreamEvent, { kind: "agent-prompt" }>

    client.respondPermission(evt.toolCallId, { cancelled: true })
    await rpc
    expect(resolved).toEqual({ outcome: { outcome: "cancelled" } })
  })

  it("cancels held requests when the session closes (no dangling RPC)", async () => {
    const client = await createAcpClient({ ...fakeStreams(), permissionHold: true })
    const session = await client.newSession({ cwd: "/tmp" })
    session.prompt({ messages: [{ type: "text", text: "go" }] })

    const handlers = capturedHandlersFactory!()
    let resolved: unknown
    const rpc = handlers.requestPermission(PERM_PARAMS).then(r => {
      resolved = r
    })

    await session.close()
    await rpc
    expect(resolved).toEqual({ outcome: { outcome: "cancelled" } })
  })

  it("with permissionHold OFF, the guard falls through to the supplied handler", async () => {
    const autoAnswer = vi.fn(async () => ({
      outcome: { outcome: "selected", optionId: "a" },
    }))
    const client = await createAcpClient({
      ...fakeStreams(),
      handlers: { requestPermission: autoAnswer } as never,
    })
    await client.newSession({ cwd: "/tmp" })
    const handlers = capturedHandlersFactory!()
    const result = await handlers.requestPermission(PERM_PARAMS)
    expect(autoAnswer).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ outcome: { outcome: "selected", optionId: "a" } })
  })

  it("without permissionHold the request path is unchanged (throws with no handler)", async () => {
    const client = await createAcpClient({ ...fakeStreams() })
    await client.newSession({ cwd: "/tmp" })
    const handlers = capturedHandlersFactory!()
    await expect(handlers.requestPermission(PERM_PARAMS)).rejects.toThrow(/no handler configured/)
    // And respondPermission is a no-op false when nothing is held.
    expect(client.respondPermission("perm_1", { cancelled: true })).toBe(false)
  })
})
