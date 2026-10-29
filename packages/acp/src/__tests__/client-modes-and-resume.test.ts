import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mock the ACP SDK (same shape as client-effort-graceful.test.ts) so we can
// drive newSession/loadSession responses and assert the mode-folding +
// resume model re-apply behaviour without a real subprocess.
// ---------------------------------------------------------------------------

const mockSetSessionConfigOption = vi.fn()
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
    setSessionMode: vi.fn(),
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

describe("createAcpClient — mode folding + resume config re-apply", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInitialize.mockResolvedValue({ agentCapabilities: {} })
    mockSetSessionConfigOption.mockResolvedValue({})
  })

  it("folds a category:'mode' config option into availableModes when the modes field is absent", async () => {
    // opencode 1.19 leaves `modes` undefined and advertises the registry as a
    // config option. Without folding it, availableModes is [] and no canonical
    // posture ever resolves native.
    mockNewSession.mockResolvedValue({
      sessionId: "sess-open",
      configOptions: [
        { id: "model", category: "model", type: "select", currentValue: "opencode/big-pickle", options: [] },
        {
          id: "mode",
          category: "mode",
          type: "select",
          currentValue: "build",
          options: [
            { value: "build", name: "Build" },
            { value: "plan", name: "Plan" },
          ],
        },
      ],
    })

    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })

    expect(session.availableModes).toEqual([
      { id: "build", name: "Build" },
      { id: "plan", name: "Plan" },
    ])
    expect(session.currentModeId).toBe("build")
  })

  it("flattens grouped config-option values", async () => {
    mockNewSession.mockResolvedValue({
      sessionId: "sess-grouped",
      configOptions: [
        {
          id: "mode",
          category: "mode",
          type: "select",
          currentValue: "a",
          options: [
            { group: "g1", name: "Group", options: [{ value: "a", name: "A" }] },
            { group: "g2", name: "Group2", options: [{ value: "b", name: "B" }] },
          ],
        },
      ],
    })

    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })

    expect(session.availableModes).toEqual([
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ])
  })

  it("prefers the native modes field over a config option when both are present", async () => {
    mockNewSession.mockResolvedValue({
      sessionId: "sess-native",
      modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Manual" }] },
      configOptions: [
        { id: "mode", category: "mode", type: "select", currentValue: "build", options: [{ value: "build", name: "Build" }] },
      ],
    })

    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })

    expect(session.availableModes).toEqual([{ id: "default", name: "Manual" }])
    expect(session.currentModeId).toBe("default")
  })

  it("re-applies the requested model/effort/mode on loadSession (resume)", async () => {
    // Before the fix loadSession applied NOTHING, so a restarted opencode
    // session drifted to the harness default. Assert all three are re-sent.
    mockLoadSession.mockResolvedValue({
      sessionId: "sess-resume",
      configOptions: [
        { id: "mode", category: "mode", type: "select", currentValue: "build", options: [{ value: "build", name: "Build" }, { value: "plan", name: "Plan" }] },
      ],
    })

    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.loadSession({
      sessionId: "sess-resume",
      cwd: "/tmp",
      model: "opencode-go/deepseek-v4.1-flash",
      effort: "low",
      mode: "plan",
    })

    expect(session.sessionId).toBe("sess-resume")
    // Modes are also folded on resume.
    expect(session.availableModes).toEqual([
      { id: "build", name: "Build" },
      { id: "plan", name: "Plan" },
    ])
    const configIds = mockSetSessionConfigOption.mock.calls.map(c => c[0].configId)
    expect(configIds).toEqual(["model", "effort", "mode"])
    expect(mockSetSessionConfigOption).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ configId: "model", value: "opencode-go/deepseek-v4.1-flash" }),
    )
    expect(session.modelApplyRejection).toBeUndefined()
  })

  it("records modelApplyRejection when the resume-time model apply is rejected", async () => {
    mockLoadSession.mockResolvedValue({ sessionId: "sess-resume2" })
    const rejection: Error & { code?: number; data?: { details?: string } } = Object.assign(
      new Error("Internal error"),
      { code: -32603, data: { details: "Invalid value for config option model: opencode-go/deepseek-v4.1-flash" } },
    )
    mockSetSessionConfigOption.mockRejectedValueOnce(rejection)
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.loadSession({
      sessionId: "sess-resume2",
      cwd: "/tmp",
      model: "opencode-go/deepseek-v4.1-flash",
    })

    expect(session.modelApplyRejection).toEqual({
      requested: "opencode-go/deepseek-v4.1-flash",
      reason: expect.stringContaining("Invalid value for config option model") as unknown as string,
    })
    warnSpy.mockRestore()
  })

  it("retries a TRANSIENT model-apply rejection and keeps the requested model", async () => {
    mockLoadSession.mockResolvedValue({ sessionId: "sess-retry" })
    const transient: Error & { data?: { details?: string } } = Object.assign(
      new Error("Internal error"),
      { data: { details: "API error: 429 rate_limit_error" } },
    )
    mockSetSessionConfigOption
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce({})
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const client = await createAcpClient({
      ...fakeStreams(),
      modelApplyRetry: { baseDelayMs: 0, maxAttempts: 3 },
    })
    const session = await client.loadSession({
      sessionId: "sess-retry",
      cwd: "/tmp",
      model: "claude-sonnet-5-5[1m]",
    })

    // The retry lands the requested model, so the descriptor records no
    // rejection — this is the boot-resume downgrade the fix prevents.
    expect(session.modelApplyRejection).toBeUndefined()
    expect(mockSetSessionConfigOption).toHaveBeenCalledTimes(2)
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/retrying/i)
    warnSpy.mockRestore()
  })

  it("gives up after the bounded retries when a transient rejection persists, recording the mismatch", async () => {
    mockLoadSession.mockResolvedValue({ sessionId: "sess-retry-fail" })
    const transient: Error & { data?: { details?: string } } = Object.assign(
      new Error("Internal error"),
      { data: { details: "API error: 429 rate_limit_error" } },
    )
    mockSetSessionConfigOption.mockRejectedValue(transient)
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const client = await createAcpClient({
      ...fakeStreams(),
      modelApplyRetry: { baseDelayMs: 0, maxAttempts: 3 },
    })
    const session = await client.loadSession({
      sessionId: "sess-retry-fail",
      cwd: "/tmp",
      model: "claude-sonnet-5-5[1m]",
    })

    expect(mockSetSessionConfigOption).toHaveBeenCalledTimes(3)
    expect(session.modelApplyRejection?.requested).toBe("claude-sonnet-5-5[1m]")
    expect(session.modelApplyRejection?.reason).toContain("429")
    warnSpy.mockRestore()
  })

  it("does NOT retry a permanent (non-transient) model rejection", async () => {
    mockLoadSession.mockResolvedValue({ sessionId: "sess-permanent" })
    const permanent: Error & { data?: { details?: string } } = Object.assign(
      new Error("Internal error"),
      { data: { details: "Invalid value for config option model: bogus" } },
    )
    mockSetSessionConfigOption.mockRejectedValue(permanent)
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const client = await createAcpClient({
      ...fakeStreams(),
      modelApplyRetry: { baseDelayMs: 0, maxAttempts: 3 },
    })
    const session = await client.loadSession({
      sessionId: "sess-permanent",
      cwd: "/tmp",
      model: "bogus",
    })

    expect(mockSetSessionConfigOption).toHaveBeenCalledTimes(1)
    expect(session.modelApplyRejection?.reason).toContain("Invalid value")
    warnSpy.mockRestore()
  })

  it("leaves availableModes empty when neither modes nor a mode config option is advertised", async () => {
    mockNewSession.mockResolvedValue({ sessionId: "sess-none" })

    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })

    expect(session.availableModes).toEqual([])
    expect(session.currentModeId).toBeUndefined()
  })
})
