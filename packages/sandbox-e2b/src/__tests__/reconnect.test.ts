import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { SandboxSpec } from "@agentproto/sandbox"

const { sandboxCreateMock, sandboxConnectMock } = vi.hoisted(() => ({
  sandboxCreateMock: vi.fn(),
  sandboxConnectMock: vi.fn(),
}))

vi.mock("e2b", () => ({
  Sandbox: { create: sandboxCreateMock, connect: sandboxConnectMock },
}))

function fakeSandbox(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sandboxId: "sbx_abc",
    getHost: vi.fn((port: number) => `sbx-abc-${port}.e2b.dev`),
    commands: { run: vi.fn(async () => ({})) },
    kill: vi.fn(async () => true),
    pause: vi.fn(async () => true),
    setTimeout: vi.fn(async () => {}),
    ...overrides,
  }
}

describe("e2bSandboxProvider.connect", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    sandboxCreateMock.mockReset()
    sandboxConnectMock.mockReset()
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const spec: SandboxSpec = { provider: "e2b", config: {} }

  it("resumes via Sandbox.connect (not create) and returns the mcp url when the daemon is already healthy", async () => {
    const sandbox = fakeSandbox()
    sandboxConnectMock.mockResolvedValue(sandbox)
    fetchMock.mockResolvedValue({ ok: true })

    const { e2bSandboxProvider } = await import("../provider.js")
    const booted = await e2bSandboxProvider.connect!("sbx_abc", spec, { env: {} })

    expect(sandboxConnectMock).toHaveBeenCalledWith(
      "sbx_abc",
      expect.objectContaining({ apiKey: process.env.E2B_API_KEY }),
    )
    expect(sandboxCreateMock).not.toHaveBeenCalled()
    expect(sandbox.commands.run).not.toHaveBeenCalled()
    // A resumed box keeps its ORIGINAL deadline — connect must re-arm the
    // lifetime so the reconnected session isn't reaped mid-turn.
    expect(sandbox.setTimeout).toHaveBeenCalledWith(45 * 60_000)
    expect(booted.mcpUrl).toBe("https://sbx-abc-18790.e2b.dev/mcp")
    expect(booted.sandboxId).toBe("sbx_abc")
  })

  it("starts the daemon when the resumed box's daemon isn't already healthy (stale-daemon-on-reconnect)", async () => {
    const sandbox = fakeSandbox()
    sandboxConnectMock.mockResolvedValue(sandbox)
    fetchMock.mockRejectedValueOnce(new Error("connect refused")) // initial probe: not up
    fetchMock.mockResolvedValue({ ok: true }) // post-start probe: healthy

    const { e2bSandboxProvider } = await import("../provider.js")
    const reconnectSpec: SandboxSpec = { provider: "e2b", config: { healthProbeTimeoutMs: 0 } }
    await e2bSandboxProvider.connect!("sbx_abc", reconnectSpec, { env: { OPENROUTER_API_KEY: "k" } })

    expect(sandbox.commands.run).toHaveBeenCalledWith(
      "sudo npm i -g @agentproto/cli@latest",
      expect.objectContaining({ envs: { OPENROUTER_API_KEY: "k" } }),
    )
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringContaining("agentproto serve --port 18790 --bind 0.0.0.0"),
      expect.objectContaining({ background: true, envs: { OPENROUTER_API_KEY: "k" } }),
    )
  })

  it("uses config.port/workspace overrides from the spec, same as boot", async () => {
    const sandbox = fakeSandbox()
    sandboxConnectMock.mockResolvedValue(sandbox)
    fetchMock.mockResolvedValue({ ok: true })

    const { e2bSandboxProvider } = await import("../provider.js")
    const customSpec: SandboxSpec = { provider: "e2b", config: { port: 9999 } }
    const booted = await e2bSandboxProvider.connect!("sbx_abc", customSpec, { env: {} })

    expect(sandbox.getHost).toHaveBeenCalledWith(9999)
    expect(booted.mcpUrl).toBe("https://sbx-abc-9999.e2b.dev/mcp")
  })

  it("pause() keeps the full memory snapshot (keepMemory: true) — never a cold-boot-on-resume", async () => {
    const sandbox = fakeSandbox()
    sandboxCreateMock.mockResolvedValue(sandbox)
    fetchMock.mockResolvedValue({ ok: true })

    const { e2bSandboxProvider } = await import("../provider.js")
    const booted = await e2bSandboxProvider.boot(spec, { env: {} })
    expect(booted.pause).toBeDefined()
    await booted.pause!()
    expect(sandbox.pause).toHaveBeenCalledWith({ keepMemory: true })
    expect(sandbox.kill).not.toHaveBeenCalled()
  })
})
