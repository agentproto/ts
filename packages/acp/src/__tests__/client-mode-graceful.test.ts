import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mock the ACP SDK so we can control what ClientSideConnection does without
// a real subprocess. The fake connection lets us verify that a rejected
// set_config_option for "mode" does NOT propagate as a newSession failure —
// mirrors client-effort-graceful.test.ts, but for the opencode-style "mode"
// config option (plan/build selected server-side, not via CLI flags).
// ---------------------------------------------------------------------------

const mockSetSessionConfigOption = vi.fn()
const mockNewSession = vi.fn()
const mockInitialize = vi.fn()

vi.mock("@agentclientprotocol/sdk", () => ({
  ndJsonStream: () => ({}),
  ClientSideConnection: vi.fn().mockImplementation(() => ({
    initialize: mockInitialize,
    newSession: mockNewSession,
    setSessionConfigOption: mockSetSessionConfigOption,
    on: vi.fn(),
    off: vi.fn(),
  })),
}))

import { createAcpClient } from "../client/index.js"

function fakeStreams() {
  const output = new WritableStream()
  const readable = new ReadableStream()
  return { output, input: readable }
}

describe("createAcpClient — newSession mode graceful degradation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInitialize.mockResolvedValue({ agentCapabilities: {} })
    mockNewSession.mockResolvedValue({ sessionId: "sess-graceful" })
  })

  it("resolves even when set_config_option for mode throws (server rejects it)", async () => {
    mockSetSessionConfigOption.mockRejectedValue(
      new Error("Internal error: unknown configId 'mode'"),
    )

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const client = await createAcpClient({ ...fakeStreams() })

    const session = await client.newSession({ cwd: "/tmp", mode: "plan" })

    expect(session).toBeDefined()
    expect(session.sessionId).toBe("sess-graceful")

    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/mode.*rejected by server/i)

    warnSpy.mockRestore()
  })

  it("calls set_config_option for mode when provided", async () => {
    mockSetSessionConfigOption.mockResolvedValue({})

    const client = await createAcpClient({ ...fakeStreams() })
    await client.newSession({ cwd: "/tmp", mode: "plan" })

    expect(mockSetSessionConfigOption).toHaveBeenCalledWith(
      expect.objectContaining({ configId: "mode", value: "plan" }),
    )
  })

  it("skips set_config_option for mode when mode is omitted", async () => {
    mockSetSessionConfigOption.mockResolvedValue({})

    const client = await createAcpClient({ ...fakeStreams() })
    await client.newSession({ cwd: "/tmp" })

    expect(mockSetSessionConfigOption).not.toHaveBeenCalled()
  })

  it("applies model, then effort, then mode in that order", async () => {
    mockSetSessionConfigOption.mockResolvedValue({})

    const client = await createAcpClient({ ...fakeStreams() })
    await client.newSession({
      cwd: "/tmp",
      model: "anthropic/claude-sonnet-4-6",
      effort: "high",
      mode: "build",
    })

    expect(mockSetSessionConfigOption).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ configId: "model" }),
    )
    expect(mockSetSessionConfigOption).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ configId: "effort" }),
    )
    expect(mockSetSessionConfigOption).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ configId: "mode", value: "build" }),
    )
  })
})
