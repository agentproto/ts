import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { SandboxSpec } from "@agentproto/sandbox"

const { boxApiMock, boxApiCtorMock, configCtorMock } = vi.hoisted(() => {
  const boxApiMock = {
    create: vi.fn(),
    get: vi.fn(),
    resume: vi.fn(),
    command: vi.fn(async () => ({})),
    remove: vi.fn(async () => ({})),
    stop: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
  }
  return {
    boxApiMock,
    boxApiCtorMock: vi.fn(() => boxApiMock),
    configCtorMock: vi.fn((opts: unknown) => opts),
  }
})

vi.mock("@asciidev/box-sdk", () => ({
  BoxApi: boxApiCtorMock,
  Configuration: configCtorMock,
}))

function fakeBox(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "bx_abc",
    name: "test-box",
    state: "ready",
    subdomain: "frazil-pneuma-rallye",
    desktopAvailable: false,
    snapshotAvailable: false,
    ...overrides,
  }
}

describe("boxSandboxProvider.connect", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    boxApiMock.create.mockReset()
    boxApiMock.get.mockReset().mockResolvedValue({ ok: true, type: "box", box: fakeBox() })
    boxApiMock.resume.mockReset().mockResolvedValue({ ok: true, type: "box.resumed", id: "bx_abc" })
    boxApiMock.command.mockReset().mockResolvedValue({})
    boxApiMock.remove.mockReset().mockResolvedValue({})
    boxApiMock.stop.mockReset().mockResolvedValue({})
    boxApiMock.update.mockReset().mockResolvedValue({})
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const spec: SandboxSpec = { provider: "box", config: {} }

  it("resumes via BoxApi.resume (not create) and returns the mcp url when the daemon is already healthy", async () => {
    fetchMock.mockResolvedValue({ ok: true })

    const { boxSandboxProvider } = await import("../provider.js")
    const booted = await boxSandboxProvider.connect!("bx_abc", spec, { env: {} })

    expect(boxApiMock.resume).toHaveBeenCalledWith({ boxId: "bx_abc", resumeRequest: {} })
    expect(boxApiMock.create).not.toHaveBeenCalled()
    expect(boxApiMock.command).not.toHaveBeenCalled()
    expect(booted.mcpUrl).toBe("https://frazil-pneuma-rallye-18790.on.ascii.dev/mcp")
    expect(booted.sandboxId).toBe("bx_abc")
  })

  it("starts the daemon when the resumed box's systemd-managed daemon isn't already healthy (stale-daemon-on-reconnect)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connect refused")) // initial probe: not up
    fetchMock.mockResolvedValue({ ok: true }) // post-start probe: healthy

    const { boxSandboxProvider } = await import("../provider.js")
    const reconnectSpec: SandboxSpec = { provider: "box", config: { healthProbeTimeoutMs: 0 } }
    await boxSandboxProvider.connect!("bx_abc", reconnectSpec, { env: { OPENROUTER_API_KEY: "k" } })

    expect(boxApiMock.command).toHaveBeenCalledWith({
      boxId: "bx_abc",
      commandRequest: expect.objectContaining({ command: 'sudo npm i -g "@agentproto/cli@latest"' }),
    })
    expect(boxApiMock.command).toHaveBeenCalledWith({
      boxId: "bx_abc",
      commandRequest: expect.objectContaining({
        command: "sudo systemctl daemon-reload && sudo systemctl enable --now agentproto",
      }),
    })
  })

  it("uses config.port/workspace overrides from the spec, same as boot", async () => {
    fetchMock.mockResolvedValue({ ok: true })

    const { boxSandboxProvider } = await import("../provider.js")
    const customSpec: SandboxSpec = { provider: "box", config: { port: 9999 } }
    const booted = await boxSandboxProvider.connect!("bx_abc", customSpec, { env: {} })

    expect(booted.mcpUrl).toBe("https://frazil-pneuma-rallye-9999.on.ascii.dev/mcp")
  })

  it("does not need to re-arm any lifetime on resume — Box's no-auto-stop default is sticky, unlike e2b's timeout", async () => {
    fetchMock.mockResolvedValue({ ok: true })

    const { boxSandboxProvider } = await import("../provider.js")
    await boxSandboxProvider.connect!("bx_abc", spec, { env: {} })

    // resumeRequest carries no ttl field — the SDK's ResumeRequest shape has none
    expect(boxApiMock.resume).toHaveBeenCalledWith({ boxId: "bx_abc", resumeRequest: {} })
  })

  it("pause() calls Box's stop (snapshot) — never remove", async () => {
    fetchMock.mockResolvedValue({ ok: true })

    const { boxSandboxProvider } = await import("../provider.js")
    const booted = await boxSandboxProvider.connect!("bx_abc", spec, { env: {} })
    expect(booted.pause).toBeDefined()
    await booted.pause!()
    expect(boxApiMock.stop).toHaveBeenCalledWith({ boxId: "bx_abc" })
    expect(boxApiMock.remove).not.toHaveBeenCalled()
  })

  describe("expose: \"private\" (attachSandbox's token-gated path)", () => {
    it("defaults to --public and no token when expose is omitted (unchanged behaviour)", async () => {
      fetchMock.mockResolvedValue({ ok: true })

      const { boxSandboxProvider } = await import("../provider.js")
      const booted = await boxSandboxProvider.connect!("bx_abc", spec, { env: {} })

      expect(boxApiMock.command).not.toHaveBeenCalled()
      expect(booted.token).toBeUndefined()
    })

    // `box host --private` emits a JSON object whose `url` carries the token
    // as a `_token` query param — see `parseBoxHostToken` (verified live).
    const privateHostStdout = (token: string) =>
      JSON.stringify({
        access: "private",
        boxId: "bx_abc",
        isProtected: true,
        port: 18790,
        title: null,
        url: `https://frazil-pneuma-rallye-18790.on.ascii.dev?_token=${token}`,
      }) + "\n"

    it("runs `box host --private`, parses the `_token`, and returns the Cookie auth header even when the daemon is already healthy", async () => {
      fetchMock.mockResolvedValue({ ok: true })
      boxApiMock.command.mockResolvedValue({ stdout: privateHostStdout("tok_secret_abc"), stderr: "" })

      const { boxSandboxProvider } = await import("../provider.js")
      const booted = await boxSandboxProvider.connect!("bx_abc", spec, { env: {}, expose: "private" })

      expect(boxApiMock.command).toHaveBeenCalledWith({
        boxId: "bx_abc",
        commandRequest: expect.objectContaining({ command: "box host bx_abc 18790 --private" }),
      })
      expect(booted.token).toBe("tok_secret_abc")
      expect(booted.authHeaders).toEqual({ Cookie: "_port_auth=tok_secret_abc" })
    })

    it("uses --private instead of --public during first-time provisioning when expose is private", async () => {
      fetchMock.mockRejectedValueOnce(new Error("connect refused"))
      fetchMock.mockResolvedValue({ ok: true })
      boxApiMock.command.mockResolvedValue({ stdout: privateHostStdout("tok_fresh"), stderr: "" })

      const { boxSandboxProvider } = await import("../provider.js")
      const reconnectSpec: SandboxSpec = { provider: "box", config: { healthProbeTimeoutMs: 0 } }
      const booted = await boxSandboxProvider.connect!("bx_abc", reconnectSpec, {
        env: {},
        expose: "private",
      })

      expect(boxApiMock.command).toHaveBeenCalledWith({
        boxId: "bx_abc",
        commandRequest: expect.objectContaining({ command: "box host bx_abc 18790 --private" }),
      })
      expect(boxApiMock.command).not.toHaveBeenCalledWith(
        expect.objectContaining({
          commandRequest: expect.objectContaining({ command: expect.stringContaining("--public") }),
        }),
      )
      expect(booted.token).toBe("tok_fresh")
    })

    it("throws when `box host --private` produces no `_token` in its output", async () => {
      fetchMock.mockResolvedValue({ ok: true })
      boxApiMock.command.mockResolvedValue({ stdout: "", stderr: "" })

      const { boxSandboxProvider } = await import("../provider.js")
      await expect(
        boxSandboxProvider.connect!("bx_abc", spec, { env: {}, expose: "private" }),
      ).rejects.toThrow(/produced no .?_token/)
    })
  })

  describe("keepAlive (attachSandbox's always-on rendezvous pin)", () => {
    it("re-asserts no-auto-stop via BoxApi.update when keepAlive is true", async () => {
      fetchMock.mockResolvedValue({ ok: true })

      const { boxSandboxProvider } = await import("../provider.js")
      await boxSandboxProvider.connect!("bx_abc", spec, { env: {}, keepAlive: true })

      expect(boxApiMock.update).toHaveBeenCalledWith({
        boxId: "bx_abc",
        updateBoxRequest: { ttlSeconds: null },
      })
    })

    it("does not call BoxApi.update when keepAlive is false", async () => {
      fetchMock.mockResolvedValue({ ok: true })

      const { boxSandboxProvider } = await import("../provider.js")
      await boxSandboxProvider.connect!("bx_abc", spec, { env: {}, keepAlive: false })

      expect(boxApiMock.update).not.toHaveBeenCalled()
    })

    it("does not call BoxApi.update when keepAlive is omitted", async () => {
      fetchMock.mockResolvedValue({ ok: true })

      const { boxSandboxProvider } = await import("../provider.js")
      await boxSandboxProvider.connect!("bx_abc", spec, { env: {} })

      expect(boxApiMock.update).not.toHaveBeenCalled()
    })
  })
})
