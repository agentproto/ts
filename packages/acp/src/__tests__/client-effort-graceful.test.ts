import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mock the ACP SDK so we can control what ClientSideConnection does without
// a real subprocess. The fake connection lets us verify that a rejected
// set_config_option for "effort" does NOT propagate as a newSession failure.
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

// Minimal fake streams — irrelevant once the SDK is mocked.
function fakeStreams() {
  const output = new WritableStream()
  const readable = new ReadableStream()
  return { output, input: readable }
}

describe("createAcpClient — newSession effort graceful degradation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInitialize.mockResolvedValue({ agentCapabilities: {} })
    mockNewSession.mockResolvedValue({ sessionId: "sess-graceful" })
  })

  it("resolves even when set_config_option for effort throws (server rejects it)", async () => {
    // Arrange: server rejects effort — simulates the claude-code "Internal
    // error" that triggered the original bug.
    mockSetSessionConfigOption.mockRejectedValue(
      new Error("Internal error: unknown configId 'effort'"),
    )

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const client = await createAcpClient({ ...fakeStreams() })

    // Act — must NOT throw even though setSessionConfigOption rejects.
    const session = await client.newSession({ cwd: "/tmp", effort: "low" })

    // Assert: session object is returned correctly.
    expect(session).toBeDefined()
    expect(session.sessionId).toBe("sess-graceful")

    // Assert: the rejection was logged as a warning (best-effort semantic).
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/effort.*rejected by server/i)

    warnSpy.mockRestore()
  })

  it("still calls set_config_option for effort when provided", async () => {
    mockSetSessionConfigOption.mockResolvedValue({})

    const client = await createAcpClient({ ...fakeStreams() })
    await client.newSession({ cwd: "/tmp", effort: "medium" })

    expect(mockSetSessionConfigOption).toHaveBeenCalledWith(
      expect.objectContaining({ configId: "effort", value: "medium" }),
    )
  })

  it("skips set_config_option for effort when effort is omitted", async () => {
    mockSetSessionConfigOption.mockResolvedValue({})

    const client = await createAcpClient({ ...fakeStreams() })
    await client.newSession({ cwd: "/tmp" })

    // model was not passed either, so setSessionConfigOption should not be
    // called at all.
    expect(mockSetSessionConfigOption).not.toHaveBeenCalled()
  })

  it("does NOT swallow a model set_config_option failure (only effort is best-effort)", async () => {
    // The try/catch must wrap ONLY effort, not model — if model is rejected
    // the whole newSession should propagate the error.
    mockSetSessionConfigOption.mockRejectedValue(
      new Error("model config rejected"),
    )

    const client = await createAcpClient({ ...fakeStreams() })

    await expect(
      client.newSession({ cwd: "/tmp", model: "claude-haiku-4-5-20251001" }),
    ).rejects.toThrow("model config rejected")
  })
})
