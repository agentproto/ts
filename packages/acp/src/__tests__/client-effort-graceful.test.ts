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

  it("does NOT crash the spawn when a model set_config_option is rejected (agentproto#186)", async () => {
    // Reproduces the real wrapper behaviour: claude-agent-acp rejects a model
    // id it can't resolve (e.g. the stale "claude-sonnet-4-6") with a JSON-RPC
    // -32603 whose only useful text is in `error.data.details`. That MUST NOT
    // reject newSession — the session starts on the agent's default model.
    const rejection: Error & { code?: number; data?: { details?: string } } =
      Object.assign(new Error("Internal error"), {
        code: -32603,
        data: { details: "Invalid value for config option model: claude-sonnet-4-6" },
      })
    mockSetSessionConfigOption.mockRejectedValue(rejection)

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const client = await createAcpClient({ ...fakeStreams() })

    // Act — must NOT throw even though the model set is rejected.
    const session = await client.newSession({
      cwd: "/tmp",
      model: "claude-sonnet-4-6",
    })

    expect(session).toBeDefined()
    expect(session.sessionId).toBe("sess-graceful")

    // The warning is loud, not silent: it names the requested model AND
    // surfaces the server's captured `data.details` reason.
    expect(warnSpy).toHaveBeenCalledOnce()
    const warned = String(warnSpy.mock.calls[0]?.[0])
    expect(warned).toMatch(/model="claude-sonnet-4-6".*rejected by server/i)
    expect(warned).toContain(
      "Invalid value for config option model: claude-sonnet-4-6",
    )

    warnSpy.mockRestore()
  })

  it("records a rejected model apply as modelApplyRejection on the session", async () => {
    // The non-fatal contract stands (see the #186 test above), but the host
    // must be able to SEE that the session is on the default model, not the
    // requested one — for a derived-from-model adapter (opencode & co.)
    // that difference is a different provider on a different bill, and the
    // driver escalates it to a spawn failure.
    const rejection: Error & { code?: number; data?: { details?: string } } =
      Object.assign(new Error("Internal error"), {
        code: -32603,
        data: { details: "Invalid value for config option model: deepseek/deepseek-v4-pro@openrouter" },
      })
    mockSetSessionConfigOption.mockRejectedValue(rejection)
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({
      cwd: "/tmp",
      model: "deepseek/deepseek-v4-pro@openrouter",
    })

    expect(session.modelApplyRejection).toEqual({
      requested: "deepseek/deepseek-v4-pro@openrouter",
      reason: expect.stringContaining(
        "Invalid value for config option model: deepseek/deepseek-v4-pro@openrouter",
      ) as unknown as string,
    })
    warnSpy.mockRestore()
  })

  it("leaves modelApplyRejection unset when the model apply succeeds", async () => {
    mockSetSessionConfigOption.mockResolvedValue({})

    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp", model: "claude-sonnet-5" })

    expect(session.modelApplyRejection).toBeUndefined()
  })

  it("applies a valid model via set_config_option before effort", async () => {
    mockSetSessionConfigOption.mockResolvedValue({})

    const client = await createAcpClient({ ...fakeStreams() })
    await client.newSession({ cwd: "/tmp", model: "claude-sonnet-5", effort: "high" })

    // Model is set first (a switch rebuilds the effort options), then effort.
    expect(mockSetSessionConfigOption).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ configId: "model", value: "claude-sonnet-5" }),
    )
    expect(mockSetSessionConfigOption).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ configId: "effort", value: "high" }),
    )
  })
})

// ---------------------------------------------------------------------------
// Effort config id resolution. Copilot CLI (1.0.113) advertises the effort
// option as `reasoning_effort` and answers `effort` with "Unknown config
// option 'effort'"; Claude/Codex/OpenCode advertise `effort`.
// ---------------------------------------------------------------------------

const selectOption = (id: string, category: string, values: string[]) => ({
  id,
  name: id,
  type: "select" as const,
  category,
  currentValue: values[0],
  options: values.map(value => ({ value, name: value })),
})

describe("createAcpClient — effort configId resolved from advertised configOptions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInitialize.mockResolvedValue({ agentCapabilities: {} })
    mockSetSessionConfigOption.mockResolvedValue({})
  })

  it("copilot-cli: uses `reasoning_effort` when that is what the session advertises", async () => {
    mockNewSession.mockResolvedValue({
      sessionId: "s-copilot",
      configOptions: [
        selectOption("model", "model", ["claude-sonnet-5.5", "mai-code-2"]),
        selectOption("reasoning_effort", "thought_level", ["low", "medium", "high", "xhigh", "max"]),
        selectOption("mode", "mode", ["agent", "plan", "autopilot"]),
      ],
    })
    const client = await createAcpClient({ ...fakeStreams() })
    await client.newSession({ cwd: "/tmp", model: "mai-code-2", effort: "high" })
    expect(mockSetSessionConfigOption).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ configId: "reasoning_effort", value: "high" }),
    )
    for (const call of mockSetSessionConfigOption.mock.calls) {
      expect(call[0].configId).not.toBe("effort")
    }
  })

  it("keeps `effort` when the session advertises it (Claude/Codex/OpenCode)", async () => {
    mockNewSession.mockResolvedValue({
      sessionId: "s-claude",
      configOptions: [selectOption("effort", "thought_level", ["low", "high"])],
    })
    const client = await createAcpClient({ ...fakeStreams() })
    await client.newSession({ cwd: "/tmp", effort: "low" })
    expect(mockSetSessionConfigOption).toHaveBeenCalledWith(
      expect.objectContaining({ configId: "effort", value: "low" }),
    )
  })

  it("falls back to the thought_level category for an unknown id", async () => {
    mockNewSession.mockResolvedValue({
      sessionId: "s-other",
      configOptions: [selectOption("thinking_budget", "thought_level", ["low", "high"])],
    })
    const client = await createAcpClient({ ...fakeStreams() })
    await client.newSession({ cwd: "/tmp", effort: "high" })
    expect(mockSetSessionConfigOption).toHaveBeenCalledWith(
      expect.objectContaining({ configId: "thinking_budget", value: "high" }),
    )
  })

  it("keeps the historical `effort` id when the session advertises no options", async () => {
    mockNewSession.mockResolvedValue({ sessionId: "s-none" })
    const client = await createAcpClient({ ...fakeStreams() })
    await client.newSession({ cwd: "/tmp", effort: "low" })
    expect(mockSetSessionConfigOption).toHaveBeenCalledWith(
      expect.objectContaining({ configId: "effort", value: "low" }),
    )
  })

  it("prefers the option list returned by the model switch (effort option rebuilt)", async () => {
    mockNewSession.mockResolvedValue({
      sessionId: "s-rebuilt",
      configOptions: [selectOption("model", "model", ["a", "b"])],
    })
    mockSetSessionConfigOption.mockResolvedValueOnce({
      configOptions: [
        selectOption("model", "model", ["a", "b"]),
        selectOption("reasoning_effort", "thought_level", ["low", "high"]),
      ],
    })
    const client = await createAcpClient({ ...fakeStreams() })
    await client.newSession({ cwd: "/tmp", model: "b", effort: "high" })
    expect(mockSetSessionConfigOption).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ configId: "reasoning_effort", value: "high" }),
    )
  })

  it("copilot-cli: agent/plan/autopilot from the `mode` config option surface as availableModes", async () => {
    mockNewSession.mockResolvedValue({
      sessionId: "s-modes",
      configOptions: [selectOption("mode", "mode", ["agent", "plan", "autopilot"])],
    })
    const client = await createAcpClient({ ...fakeStreams() })
    const session = await client.newSession({ cwd: "/tmp" })
    expect(session.availableModes.map(m => m.id)).toEqual(["agent", "plan", "autopilot"])
  })
})
