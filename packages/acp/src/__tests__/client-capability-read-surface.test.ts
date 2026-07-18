import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Read-surface for the wrapper's advertised capabilities (SPEC §3.9/§3.4a):
// `newSession`/`loadSession` responses can carry `configOptions` (per-model
// value lists) and `modes` (`SessionModeState`), but until now this client
// discarded both and only learned the accepted vocabulary by catching a
// reject from `setConfigOption`. Every assertion here fails on `main` — the
// fields don't exist on `AcpClientSession` at all before this change.
// Mirrors client-set-config-option.test.ts's mock-the-SDK approach.
// ---------------------------------------------------------------------------

const mockSetSessionConfigOption = vi.fn()
const mockSetSessionMode = vi.fn()
const mockNewSession = vi.fn()
const mockLoadSession = vi.fn()
const mockInitialize = vi.fn()

vi.mock("@agentclientprotocol/sdk", () => ({
  ndJsonStream: () => ({}),
  ClientSideConnection: vi.fn().mockImplementation(() => ({
    initialize: mockInitialize,
    newSession: mockNewSession,
    loadSession: mockLoadSession,
    setSessionConfigOption: mockSetSessionConfigOption,
    setSessionMode: mockSetSessionMode,
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

const fakeConfigOptions = [
  {
    type: "select" as const,
    id: "model",
    name: "Model",
    options: [
      { value: "opus", name: "Opus" },
      { value: "sonnet", name: "Sonnet" },
    ],
    currentValue: "sonnet",
  },
  {
    type: "select" as const,
    id: "effort",
    name: "Effort",
    options: [
      { value: "high", name: "High" },
      { value: "xhigh", name: "Extra high" },
    ],
    currentValue: "high",
  },
]

const fakeModeState = {
  availableModes: [
    { id: "default", name: "Default" },
    { id: "plan", name: "Plan" },
  ],
  currentModeId: "default",
}

describe("AcpClient — capability read surface (configOptions + SessionModeState)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInitialize.mockResolvedValue({ agentCapabilities: {} })
  })

  it("captures configOptions + availableModes + currentModeId from newSession's response", async () => {
    mockNewSession.mockResolvedValue({
      sessionId: "sess-caps",
      configOptions: fakeConfigOptions,
      modes: fakeModeState,
    })

    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })

    expect(session.availableConfigOptions).toEqual(fakeConfigOptions)
    expect(session.availableModes).toEqual(fakeModeState.availableModes)
    expect(session.currentModeId).toBe("default")
  })

  it("captures configOptions + availableModes + currentModeId from loadSession's response", async () => {
    mockLoadSession.mockResolvedValue({
      configOptions: fakeConfigOptions,
      modes: fakeModeState,
    })

    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.loadSession({ sessionId: "sess-loaded", cwd: "/tmp" })

    expect(session.availableConfigOptions).toEqual(fakeConfigOptions)
    expect(session.availableModes).toEqual(fakeModeState.availableModes)
    expect(session.currentModeId).toBe("default")
  })

  it("defaults to empty arrays and undefined currentModeId when the wrapper advertises nothing", async () => {
    mockNewSession.mockResolvedValue({ sessionId: "sess-bare" })

    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })

    expect(session.availableConfigOptions).toEqual([])
    expect(session.availableModes).toEqual([])
    expect(session.currentModeId).toBeUndefined()
  })

  it("defaults to empty arrays when the wrapper sends explicit nulls", async () => {
    mockNewSession.mockResolvedValue({
      sessionId: "sess-null",
      configOptions: null,
      modes: null,
    })

    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })

    expect(session.availableConfigOptions).toEqual([])
    expect(session.availableModes).toEqual([])
    expect(session.currentModeId).toBeUndefined()
  })
})

describe("AcpClientSession.setSessionMode — live posture switch", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInitialize.mockResolvedValue({ agentCapabilities: {} })
    mockNewSession.mockResolvedValue({
      sessionId: "sess-mode",
      modes: fakeModeState,
    })
  })

  it("calls the SDK's setSessionMode with the session's own id and resolves {applied:true}", async () => {
    mockSetSessionMode.mockResolvedValue({})

    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })

    const result = await session.setSessionMode("plan")

    expect(mockSetSessionMode).toHaveBeenCalledWith({
      sessionId: "sess-mode",
      modeId: "plan",
    })
    expect(result).toEqual({ applied: true })
  })

  it("is non-fatal on rejection — resolves {applied:false, reason} instead of throwing", async () => {
    mockSetSessionMode.mockRejectedValue(new Error("unknown mode: bogus"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })

    await expect(session.setSessionMode("bogus")).resolves.toEqual({
      applied: false,
      reason: "unknown mode: bogus",
    })
    expect(warnSpy).toHaveBeenCalledOnce()

    warnSpy.mockRestore()
  })

  it("prefers error.data.details over the generic message, same as setConfigOption's handling", async () => {
    mockSetSessionMode.mockRejectedValue({
      message: "Internal error",
      data: { details: "Invalid value for config option mode: bogus" },
    })

    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })

    const result = await session.setSessionMode("bogus")
    expect(result).toEqual({
      applied: false,
      reason: "Invalid value for config option mode: bogus",
    })
  })

  it("never mutates the connect-time availableModes/currentModeId snapshot on its own", async () => {
    mockSetSessionMode.mockResolvedValue({})

    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })

    await session.setSessionMode("plan")

    // The session object's snapshot fields are read-only and captured once
    // at connect time — a live switch is surfaced only via the returned
    // {applied, reason}, not by silently rewriting currentModeId out from
    // under a caller that's still holding the earlier session reference.
    expect(session.currentModeId).toBe("default")
  })
})
