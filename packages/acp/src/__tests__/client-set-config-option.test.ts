import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mid-session `AcpClientSession.setConfigOption` — the counterpart to the
// model/effort/mode params `newSession` already applies at connect time
// (see client-mode-graceful.test.ts), but callable AFTER a session is live.
// Mirrors that file's mock-the-SDK approach so we control exactly what
// `ClientSideConnection.setSessionConfigOption` does without a real
// subprocess.
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

describe("AcpClientSession.setConfigOption — mid-session config switch", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInitialize.mockResolvedValue({ agentCapabilities: {} })
    mockNewSession.mockResolvedValue({ sessionId: "sess-live" })
  })

  it("calls setSessionConfigOption with the session's own id and resolves {applied:true}", async () => {
    mockSetSessionConfigOption.mockResolvedValue({})

    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })

    const result = await session.setConfigOption("model", "opus-5")

    expect(mockSetSessionConfigOption).toHaveBeenCalledWith(
      expect.objectContaining({
        configId: "model",
        value: "opus-5",
        sessionId: "sess-live",
      }),
    )
    expect(result).toEqual({ applied: true })
  })

  it("is non-fatal on rejection — resolves {applied:false, reason} instead of throwing", async () => {
    mockSetSessionConfigOption.mockRejectedValue(
      new Error("Invalid value for config option model: bogus-id"),
    )
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })

    await expect(session.setConfigOption("model", "bogus-id")).resolves.toEqual({
      applied: false,
      reason: "Invalid value for config option model: bogus-id",
    })
    expect(warnSpy).toHaveBeenCalledOnce()

    warnSpy.mockRestore()
  })

  it("prefers error.data.details over the generic message, same as newSession's own handling", async () => {
    mockSetSessionConfigOption.mockRejectedValue({
      message: "Internal error",
      data: { details: "Invalid value for config option model: claude-sonnet-4-6" },
    })

    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })

    const result = await session.setConfigOption("model", "claude-sonnet-4-6")
    expect(result).toEqual({
      applied: false,
      reason: "Invalid value for config option model: claude-sonnet-4-6",
    })
  })

  it("can switch effort/mode configIds too — not model-specific", async () => {
    mockSetSessionConfigOption.mockResolvedValue({})

    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })

    await session.setConfigOption("effort", "xhigh")
    expect(mockSetSessionConfigOption).toHaveBeenCalledWith(
      expect.objectContaining({ configId: "effort", value: "xhigh" }),
    )
  })
})
