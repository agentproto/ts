import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { SandboxSpec } from "@agentproto/sandbox"

const { boxApiMock, boxApiCtorMock, configCtorMock } = vi.hoisted(() => {
  const boxApiMock = {
    create: vi.fn(),
    get: vi.fn(),
    resume: vi.fn(),
    command: vi.fn(async (_req: { boxId: string; commandRequest: { command: string } }) => ({})),
    remove: vi.fn(async () => ({})),
    stop: vi.fn(async () => ({})),
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

function resetBoxApiMock() {
  boxApiMock.create.mockReset()
  boxApiMock.get.mockReset()
  boxApiMock.resume.mockReset()
  boxApiMock.command.mockReset().mockResolvedValue({})
  boxApiMock.remove.mockReset().mockResolvedValue({})
  boxApiMock.stop.mockReset().mockResolvedValue({})
}

describe("boxSandboxProvider.boot", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    resetBoxApiMock()
    boxApiMock.create.mockResolvedValue({
      ok: true,
      type: "box.created",
      status: "provisioning",
      ttlSeconds: null,
      box: fakeBox(),
    })
    boxApiMock.get.mockResolvedValue({ ok: true, type: "box", box: fakeBox() })
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const spec: SandboxSpec = { provider: "box", config: {} }

  it("boots via BoxApi.create, disables Box's own auto-stop by default, and returns the mcp url computed from the box's subdomain", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connect refused")) // initial probe: not up
    fetchMock.mockResolvedValue({ ok: true }) // post-start probe: healthy

    const { boxSandboxProvider } = await import("../provider.js")
    const bootSpec: SandboxSpec = { provider: "box", config: { healthProbeTimeoutMs: 0 } }
    const booted = await boxSandboxProvider.boot(bootSpec, { env: { OPENROUTER_API_KEY: "k" } })

    expect(boxApiMock.create).toHaveBeenCalledWith({
      createBoxRequest: { ttlSeconds: null, env: { OPENROUTER_API_KEY: "k" } },
    })
    // updates the CLI before installing the systemd unit
    expect(boxApiMock.command).toHaveBeenCalledWith({
      boxId: "bx_abc",
      commandRequest: expect.objectContaining({ command: 'sudo npm i -g "@agentproto/cli@latest"' }),
    })
    // exposes the daemon's port on Box's edge
    expect(boxApiMock.command).toHaveBeenCalledWith({
      boxId: "bx_abc",
      commandRequest: expect.objectContaining({ command: "box host 18790 --public" }),
    })
    // installs the always-on systemd unit, bound to this box's computed public host
    expect(boxApiMock.command).toHaveBeenCalledWith({
      boxId: "bx_abc",
      commandRequest: expect.objectContaining({
        command: expect.stringContaining(
          'ExecStart=agentproto serve --port 18790 --bind 0.0.0.0 --workspace "/home/user" --allow-origin https://frazil-pneuma-rallye-18790.on.ascii.dev',
        ),
      }),
    })
    expect(boxApiMock.command).toHaveBeenCalledWith({
      boxId: "bx_abc",
      commandRequest: expect.objectContaining({ command: expect.stringContaining("Restart=always") }),
    })
    // starts the daemon via systemd, handing it to PID 1 (survives resume, unlike a backgrounded shell command)
    expect(boxApiMock.command).toHaveBeenCalledWith({
      boxId: "bx_abc",
      commandRequest: expect.objectContaining({
        command: "sudo systemctl daemon-reload && sudo systemctl enable --now agentproto",
      }),
    })
    expect(booted.mcpUrl).toBe("https://frazil-pneuma-rallye-18790.on.ascii.dev/mcp")
    expect(booted.sandboxId).toBe("bx_abc")
  })

  it("writes the resolved secrets into the systemd unit's EnvironmentFile (systemd doesn't inherit shell env)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connect refused"))
    fetchMock.mockResolvedValue({ ok: true })

    const { boxSandboxProvider } = await import("../provider.js")
    const bootSpec: SandboxSpec = { provider: "box", config: { healthProbeTimeoutMs: 0 } }
    await boxSandboxProvider.boot(bootSpec, { env: { OPENROUTER_API_KEY: "sekret" } })

    expect(boxApiMock.command).toHaveBeenCalledWith({
      boxId: "bx_abc",
      commandRequest: expect.objectContaining({
        command: expect.stringContaining("OPENROUTER_API_KEY=sekret"),
      }),
    })
    expect(boxApiMock.command).toHaveBeenCalledWith({
      boxId: "bx_abc",
      commandRequest: expect.objectContaining({
        command: expect.stringContaining("EnvironmentFile=-/etc/agentproto/agentproto.env"),
      }),
    })
  })

  it("installs config.installPackages alongside the CLI update in ONE npm invocation (adapter survives the update)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connect refused"))
    fetchMock.mockResolvedValue({ ok: true })

    const { boxSandboxProvider } = await import("../provider.js")
    const bootSpec: SandboxSpec = {
      provider: "box",
      config: {
        healthProbeTimeoutMs: 0,
        installPackages: ["@agentproto/adapter-claude-sdk@latest", "@anthropic-ai/claude-code@latest"],
      },
    }
    await boxSandboxProvider.boot(bootSpec, { env: {} })

    expect(boxApiMock.command).toHaveBeenCalledWith({
      boxId: "bx_abc",
      commandRequest: expect.objectContaining({
        command:
          "sudo npm i -g \"@agentproto/cli@latest\" '@agentproto/adapter-claude-sdk@latest' '@anthropic-ai/claude-code@latest'",
      }),
    })
  })

  it("pins the boot CLI install to config.cliVersion instead of @latest", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connect refused"))
    fetchMock.mockResolvedValue({ ok: true })

    const { boxSandboxProvider } = await import("../provider.js")
    const bootSpec: SandboxSpec = { provider: "box", config: { healthProbeTimeoutMs: 0, cliVersion: "0.8.0" } }
    await boxSandboxProvider.boot(bootSpec, { env: {} })

    expect(boxApiMock.command).toHaveBeenCalledWith({
      boxId: "bx_abc",
      commandRequest: expect.objectContaining({ command: 'sudo npm i -g "@agentproto/cli@0.8.0"' }),
    })
  })

  it("runs config.setupCommands AFTER provisioning and BEFORE the systemd start", async () => {
    const calls: string[] = []
    boxApiMock.command.mockImplementation(async ({ commandRequest }: { commandRequest: { command: string } }) => {
      calls.push(commandRequest.command)
      return {}
    })
    fetchMock.mockRejectedValueOnce(new Error("connect refused"))
    fetchMock.mockResolvedValue({ ok: true })

    const { boxSandboxProvider } = await import("../provider.js")
    const bootSpec: SandboxSpec = {
      provider: "box",
      config: { healthProbeTimeoutMs: 0, setupCommands: ["install-hook-a", "install-hook-b"] },
    }
    await boxSandboxProvider.boot(bootSpec, { env: {} })

    const npmIdx = calls.findIndex(c => c.startsWith("sudo npm i -g"))
    const hostIdx = calls.findIndex(c => c.startsWith("box host"))
    const unitIdx = calls.findIndex(c => c.includes("agentproto.service"))
    const aIdx = calls.indexOf("install-hook-a")
    const bIdx = calls.indexOf("install-hook-b")
    const startIdx = calls.findIndex(c => c.includes("systemctl enable --now"))

    expect(npmIdx).toBeGreaterThanOrEqual(0)
    expect(npmIdx).toBeLessThan(hostIdx)
    expect(hostIdx).toBeLessThan(unitIdx)
    expect(unitIdx).toBeLessThan(aIdx)
    expect(aIdx).toBeLessThan(bIdx)
    expect(bIdx).toBeLessThan(startIdx)
  })

  it("runs exactly 4 commands (npm, host, unit, start) when config.setupCommands is absent", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connect refused"))
    fetchMock.mockResolvedValue({ ok: true })

    const { boxSandboxProvider } = await import("../provider.js")
    const bootSpec: SandboxSpec = { provider: "box", config: { healthProbeTimeoutMs: 0 } }
    await boxSandboxProvider.boot(bootSpec, { env: {} })

    expect(boxApiMock.command).toHaveBeenCalledTimes(4)
  })

  it("defaults ttlSeconds to null (never Box's 1-hour default) — mid-turn reaper risk", async () => {
    fetchMock.mockResolvedValue({ ok: true })
    const { boxSandboxProvider } = await import("../provider.js")
    await boxSandboxProvider.boot(spec, { env: {} })

    expect(boxApiMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ createBoxRequest: expect.objectContaining({ ttlSeconds: null }) }),
    )
  })

  it("config.ttlSeconds still overrides the null default", async () => {
    fetchMock.mockResolvedValue({ ok: true })
    const { boxSandboxProvider } = await import("../provider.js")
    await boxSandboxProvider.boot({ provider: "box", config: { ttlSeconds: 1800 } }, { env: {} })

    expect(boxApiMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ createBoxRequest: expect.objectContaining({ ttlSeconds: 1800 }) }),
    )
  })

  it("skips the CLI update when updateCliOnBoot is false, but still exposes the port and starts the daemon", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connect refused"))
    fetchMock.mockResolvedValue({ ok: true })

    const { boxSandboxProvider } = await import("../provider.js")
    const bootSpec: SandboxSpec = { provider: "box", config: { healthProbeTimeoutMs: 0, updateCliOnBoot: false } }
    await boxSandboxProvider.boot(bootSpec, { env: {} })

    expect(boxApiMock.command).not.toHaveBeenCalledWith(
      expect.objectContaining({
        commandRequest: expect.objectContaining({ command: expect.stringContaining("npm i -g") }),
      }),
    )
    expect(boxApiMock.command).toHaveBeenCalledWith(
      expect.objectContaining({
        commandRequest: expect.objectContaining({ command: expect.stringContaining("systemctl enable --now") }),
      }),
    )
  })

  it("skips provisioning entirely when the health probe already succeeds", async () => {
    fetchMock.mockResolvedValue({ ok: true })
    const { boxSandboxProvider } = await import("../provider.js")
    await boxSandboxProvider.boot(spec, { env: {} })

    expect(boxApiMock.command).not.toHaveBeenCalled()
  })

  it("still runs config.setupCommands when the daemon was already up", async () => {
    fetchMock.mockResolvedValue({ ok: true })
    const { boxSandboxProvider } = await import("../provider.js")
    const bootSpec: SandboxSpec = { provider: "box", config: { setupCommands: ["install-hook-a"] } }
    await boxSandboxProvider.boot(bootSpec, { env: { OPENROUTER_API_KEY: "k" } })

    expect(boxApiMock.command).toHaveBeenCalledWith({
      boxId: "bx_abc",
      commandRequest: expect.objectContaining({ command: "install-hook-a" }),
    })
    expect(boxApiMock.command).toHaveBeenCalledTimes(1)
  })

  it("uses config.port/workspace overrides from the spec", async () => {
    fetchMock.mockResolvedValue({ ok: true })
    const { boxSandboxProvider } = await import("../provider.js")
    const customSpec: SandboxSpec = { provider: "box", config: { port: 9999, workspace: "/workspace" } }
    const booted = await boxSandboxProvider.boot(customSpec, { env: {} })

    expect(booted.mcpUrl).toBe("https://frazil-pneuma-rallye-9999.on.ascii.dev/mcp")
  })

  it("waits for the box to leave a non-ready state before provisioning it", async () => {
    boxApiMock.get
      .mockResolvedValueOnce({ ok: true, type: "box", box: fakeBox({ state: "provisioning", subdomain: null }) })
      .mockResolvedValueOnce({ ok: true, type: "box", box: fakeBox({ state: "ready" }) })
    fetchMock.mockResolvedValue({ ok: true })

    const { boxSandboxProvider } = await import("../provider.js")
    const booted = await boxSandboxProvider.boot(
      { provider: "box", config: { pollIntervalMs: 1 } },
      { env: {} },
    )

    expect(boxApiMock.get).toHaveBeenCalledTimes(2)
    expect(booted.sandboxId).toBe("bx_abc")
  })

  it("throws when the box enters a terminal bad state while waiting to become ready", async () => {
    boxApiMock.get.mockResolvedValue({ ok: true, type: "box", box: fakeBox({ state: "error", subdomain: null }) })

    const { boxSandboxProvider } = await import("../provider.js")
    await expect(boxSandboxProvider.boot(spec, { env: {} })).rejects.toThrow(/terminal state "error"/)
  })

  it("removes the box and throws when the daemon never becomes healthy", async () => {
    fetchMock.mockRejectedValue(new Error("connect refused"))

    const { boxSandboxProvider } = await import("../provider.js")
    const flakySpec: SandboxSpec = {
      provider: "box",
      config: { healthProbeTimeoutMs: 5, daemonReadyTimeoutMs: 5, pollIntervalMs: 5 },
    }
    await expect(boxSandboxProvider.boot(flakySpec, { env: {} })).rejects.toThrow(/did not become healthy/)
    expect(boxApiMock.remove).toHaveBeenCalledWith({ boxId: "bx_abc" })
  })

  it("stop() removes (deletes) the box", async () => {
    fetchMock.mockResolvedValue({ ok: true })
    const { boxSandboxProvider } = await import("../provider.js")
    const booted = await boxSandboxProvider.boot(spec, { env: {} })
    await booted.stop()
    expect(boxApiMock.remove).toHaveBeenCalledWith({ boxId: "bx_abc" })
  })

  it("pause() calls Box's stop (archive/snapshot) — NOT remove", async () => {
    fetchMock.mockResolvedValue({ ok: true })
    const { boxSandboxProvider } = await import("../provider.js")
    const booted = await boxSandboxProvider.boot(spec, { env: {} })
    expect(booted.pause).toBeDefined()
    await booted.pause!()
    expect(boxApiMock.stop).toHaveBeenCalledWith({ boxId: "bx_abc" })
    expect(boxApiMock.remove).not.toHaveBeenCalled()
  })
})
