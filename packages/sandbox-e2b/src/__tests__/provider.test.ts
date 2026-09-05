import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { SandboxSpec } from "@agentproto/sandbox"

const { sandboxCreateMock } = vi.hoisted(() => ({ sandboxCreateMock: vi.fn() }))

vi.mock("e2b", () => ({
  Sandbox: { create: sandboxCreateMock },
}))

function fakeSandbox(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sandboxId: "sbx_abc",
    getHost: vi.fn((port: number) => `sbx-abc-${port}.e2b.dev`),
    commands: { run: vi.fn(async () => ({})) },
    kill: vi.fn(async () => true),
    ...overrides,
  }
}

describe("e2bSandboxProvider.boot", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    sandboxCreateMock.mockReset()
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const spec: SandboxSpec = { provider: "e2b", config: {} }

  it("boots via Sandbox.create with the resolved env, starts the daemon when not already up, and returns the mcp url", async () => {
    const sandbox = fakeSandbox()
    sandboxCreateMock.mockResolvedValue(sandbox)
    fetchMock.mockRejectedValueOnce(new Error("connect refused")) // initial probe: not up
    fetchMock.mockResolvedValue({ ok: true }) // post-start probe: healthy

    const { e2bSandboxProvider, DEFAULT_TEMPLATE } = await import("../provider.js")
    // healthProbeTimeoutMs: 0 forces exactly one initial-probe attempt (deterministic —
    // no race against the poll interval) before falling through to the start command.
    const bootSpec: SandboxSpec = { provider: "e2b", config: { healthProbeTimeoutMs: 0 } }
    const booted = await e2bSandboxProvider.boot(bootSpec, { env: { OPENROUTER_API_KEY: "k" } })

    expect(sandboxCreateMock).toHaveBeenCalledWith(
      DEFAULT_TEMPLATE,
      expect.objectContaining({ envs: { OPENROUTER_API_KEY: "k" } }),
    )
    // the stable template's recorded bake is PROVEN (cli 0.17.0) and no
    // cliVersion was requested, so the on-boot npm install is SKIPPED — the
    // baked image already carries the pinned CLI + adapters.
    expect(sandbox.commands.run).not.toHaveBeenCalledWith(
      expect.stringContaining("npm i -g"),
      expect.anything(),
    )
    // then starts the daemon;
    // opens the daemon's own origin allowlist for this sandbox's public host,
    // and DISABLES e2b's 60s default command timeout (timeoutMs: 0) — that
    // default applies to background commands too and was SIGKILLing the
    // daemon one minute after boot, killing every >60s agent turn.
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringContaining("agentproto serve --port 18790 --bind 0.0.0.0"),
      expect.objectContaining({ background: true, envs: { OPENROUTER_API_KEY: "k" }, timeoutMs: 0 }),
    )
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringContaining("--allow-origin https://sbx-abc-18790.e2b.dev"),
      expect.anything(),
    )
    expect(booted.mcpUrl).toBe("https://sbx-abc-18790.e2b.dev/mcp")
    expect(booted.sandboxId).toBe("sbx_abc")
  })

  it("installs config.installPackages alongside the CLI update in ONE npm invocation (adapter survives the update)", async () => {
    const sandbox = fakeSandbox()
    sandboxCreateMock.mockResolvedValue(sandbox)
    fetchMock.mockRejectedValueOnce(new Error("connect refused"))
    fetchMock.mockResolvedValue({ ok: true })

    const { e2bSandboxProvider } = await import("../provider.js")
    const bootSpec: SandboxSpec = {
      provider: "e2b",
      config: {
        healthProbeTimeoutMs: 0,
        installPackages: [
          "@agentproto/adapter-claude-sdk@latest",
          "@anthropic-ai/claude-code@latest",
        ],
      },
    }
    await e2bSandboxProvider.boot(bootSpec, { env: {} })

    expect(sandbox.commands.run).toHaveBeenCalledWith(
      "sudo npm i -g @agentproto/cli@latest '@agentproto/adapter-claude-sdk@latest' '@anthropic-ai/claude-code@latest'",
      expect.anything(),
    )
  })

  it("pins the boot CLI install to config.cliVersion instead of @latest", async () => {
    const sandbox = fakeSandbox()
    sandboxCreateMock.mockResolvedValue(sandbox)
    fetchMock.mockRejectedValueOnce(new Error("connect refused"))
    fetchMock.mockResolvedValue({ ok: true })

    const { e2bSandboxProvider } = await import("../provider.js")
    const bootSpec: SandboxSpec = {
      provider: "e2b",
      config: { healthProbeTimeoutMs: 0, cliVersion: "0.8.0" },
    }
    await e2bSandboxProvider.boot(bootSpec, { env: {} })

    expect(sandbox.commands.run).toHaveBeenCalledWith(
      "sudo npm i -g @agentproto/cli@0.8.0",
      expect.anything(),
    )
  })

  it("pins the CLI version alongside installPackages in one npm invocation", async () => {
    const sandbox = fakeSandbox()
    sandboxCreateMock.mockResolvedValue(sandbox)
    fetchMock.mockRejectedValueOnce(new Error("connect refused"))
    fetchMock.mockResolvedValue({ ok: true })

    const { e2bSandboxProvider } = await import("../provider.js")
    const bootSpec: SandboxSpec = {
      provider: "e2b",
      config: {
        healthProbeTimeoutMs: 0,
        cliVersion: "0.8.0",
        installPackages: ["@agentproto/adapter-claude-sdk@latest"],
      },
    }
    await e2bSandboxProvider.boot(bootSpec, { env: {} })

    expect(sandbox.commands.run).toHaveBeenCalledWith(
      "sudo npm i -g @agentproto/cli@0.8.0 '@agentproto/adapter-claude-sdk@latest'",
      expect.anything(),
    )
  })

  it("defaults the boot CLI install to @latest on a CUSTOM template with no cliVersion", async () => {
    const sandbox = fakeSandbox()
    sandboxCreateMock.mockResolvedValue(sandbox)
    fetchMock.mockRejectedValueOnce(new Error("connect refused"))
    fetchMock.mockResolvedValue({ ok: true })

    const { e2bSandboxProvider } = await import("../provider.js")
    const bootSpec: SandboxSpec = {
      provider: "e2b",
      config: { healthProbeTimeoutMs: 0, template: "custom-template" },
    }
    await e2bSandboxProvider.boot(bootSpec, { env: {} })

    expect(sandbox.commands.run).toHaveBeenCalledWith(
      "sudo npm i -g @agentproto/cli@latest",
      expect.anything(),
    )
  })

  it("skips the boot install on the PROVEN stable template when the pin matches", async () => {
    const sandbox = fakeSandbox()
    sandboxCreateMock.mockResolvedValue(sandbox)
    fetchMock.mockRejectedValueOnce(new Error("connect refused"))
    fetchMock.mockResolvedValue({ ok: true })

    const { e2bSandboxProvider, resolveUpdateCli, TEMPLATES } = await import("../provider.js")
    // the committed stable record is PROVEN against a real bake
    expect(TEMPLATES.stable.baked.cli).toBe("0.17.0")
    const bootSpec: SandboxSpec = {
      provider: "e2b",
      config: { healthProbeTimeoutMs: 0, cliVersion: "0.17.0" }, // matches the baked pin
    }
    await e2bSandboxProvider.boot(bootSpec, { env: {} })

    // proven bake + matching pin → the on-boot install is skipped
    expect(sandbox.commands.run).not.toHaveBeenCalledWith(
      expect.stringContaining("npm i -g"),
      expect.anything(),
    )
    // unit-level: a proven bake matching the pin (or an unset cliVersion,
    // where the bake IS the pin) skips the legacy install
    expect(resolveUpdateCli({ cliVersion: "0.17.0" }, TEMPLATES.stable.id!)).toBe(false)
    expect(resolveUpdateCli({}, TEMPLATES.stable.id!)).toBe(false)
  })

  describe("resolveUpdateCli — recorded bake gates the skip", () => {
    const templatesWithBake = {
      stable: {
        id: "bakedid000000000000",
        baked: { cli: "0.17.0" },
      },
    }

    it("skips when the recorded bake matches the declared pin (cliVersion unset — the bake IS the pin)", async () => {
      const { resolveUpdateCli } = await import("../provider.js")
      expect(resolveUpdateCli({}, "bakedid000000000000", templatesWithBake)).toBe(false)
    })

    it("skips when the recorded bake matches the requested cliVersion", async () => {
      const { resolveUpdateCli } = await import("../provider.js")
      expect(resolveUpdateCli({ cliVersion: "0.17.0" }, "bakedid000000000000", templatesWithBake)).toBe(false)
    })

    it("installs when the requested cliVersion differs from the recorded bake", async () => {
      const { resolveUpdateCli } = await import("../provider.js")
      expect(resolveUpdateCli({ cliVersion: "0.8.0" }, "bakedid000000000000", templatesWithBake)).toBe(true)
    })

    it("installs on an unknown template id (no bake record)", async () => {
      const { resolveUpdateCli } = await import("../provider.js")
      expect(resolveUpdateCli({}, "custom-template", templatesWithBake)).toBe(true)
    })
  })

  it("explicit updateCliOnBoot: true overrides the baked-template skip", async () => {
    const sandbox = fakeSandbox()
    sandboxCreateMock.mockResolvedValue(sandbox)
    fetchMock.mockRejectedValueOnce(new Error("connect refused"))
    fetchMock.mockResolvedValue({ ok: true })

    const { e2bSandboxProvider } = await import("../provider.js")
    const bootSpec: SandboxSpec = {
      provider: "e2b",
      config: { healthProbeTimeoutMs: 0, updateCliOnBoot: true },
    }
    await e2bSandboxProvider.boot(bootSpec, { env: {} })

    expect(sandbox.commands.run).toHaveBeenCalledWith(
      "sudo npm i -g @agentproto/cli@latest",
      expect.anything(),
    )
  })

  it("runs config.setupCommands AFTER the npm install and BEFORE agentproto serve", async () => {
    const calls: string[] = []
    const sandbox = fakeSandbox({
      commands: {
        run: vi.fn(async (cmd: string) => {
          calls.push(cmd)
          return {}
        }),
      },
    })
    sandboxCreateMock.mockResolvedValue(sandbox)
    fetchMock.mockRejectedValueOnce(new Error("connect refused"))
    fetchMock.mockResolvedValue({ ok: true })

    const { e2bSandboxProvider } = await import("../provider.js")
    const bootSpec: SandboxSpec = {
      provider: "e2b",
      config: {
        healthProbeTimeoutMs: 0,
        template: "custom-template",
        setupCommands: ["install-hook-a", "install-hook-b"],
      },
    }
    await e2bSandboxProvider.boot(bootSpec, { env: { OPENROUTER_API_KEY: "k" } })

    // each setup command is host-executed with the resolved env
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      "install-hook-a",
      expect.objectContaining({ envs: { OPENROUTER_API_KEY: "k" } }),
    )
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      "install-hook-b",
      expect.objectContaining({ envs: { OPENROUTER_API_KEY: "k" } }),
    )
    // ordering: npm install → setup commands (in order) → serve
    const npmIdx = calls.findIndex(c => c.startsWith("sudo npm i -g"))
    const aIdx = calls.indexOf("install-hook-a")
    const bIdx = calls.indexOf("install-hook-b")
    const serveIdx = calls.findIndex(c => c.includes("agentproto serve"))
    expect(npmIdx).toBeGreaterThanOrEqual(0)
    expect(npmIdx).toBeLessThan(aIdx)
    expect(aIdx).toBeLessThan(bIdx)
    expect(bIdx).toBeLessThan(serveIdx)
  })

  it("runs no setup commands when config.setupCommands is absent", async () => {
    const sandbox = fakeSandbox()
    sandboxCreateMock.mockResolvedValue(sandbox)
    fetchMock.mockRejectedValueOnce(new Error("connect refused"))
    fetchMock.mockResolvedValue({ ok: true })

    const { e2bSandboxProvider } = await import("../provider.js")
    const bootSpec: SandboxSpec = { provider: "e2b", config: { healthProbeTimeoutMs: 0 } }
    await e2bSandboxProvider.boot(bootSpec, { env: {} })

    // proven stable bake + no cliVersion → install skipped; only the daemon
    // serve command runs (no stray provision commands)
    expect(sandbox.commands.run).toHaveBeenCalledTimes(1)
  })

  it("defaults the sandbox LIFETIME to 45min — never e2b's 5-minute default (mid-turn reaper)", async () => {
    const sandbox = fakeSandbox()
    sandboxCreateMock.mockResolvedValue(sandbox)
    fetchMock.mockResolvedValue({ ok: true })

    const { e2bSandboxProvider, DEFAULT_TEMPLATE } = await import("../provider.js")
    await e2bSandboxProvider.boot(spec, { env: {} })

    expect(sandboxCreateMock).toHaveBeenCalledWith(
      DEFAULT_TEMPLATE,
      expect.objectContaining({ timeoutMs: 45 * 60_000 }),
    )
  })

  it("config.timeoutMs still overrides the lifetime default", async () => {
    const sandbox = fakeSandbox()
    sandboxCreateMock.mockResolvedValue(sandbox)
    fetchMock.mockResolvedValue({ ok: true })

    const { e2bSandboxProvider } = await import("../provider.js")
    await e2bSandboxProvider.boot(
      { provider: "e2b", config: { timeoutMs: 120_000 } },
      { env: {} },
    )

    expect(sandboxCreateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeoutMs: 120_000 }),
    )
  })

  it("skips the CLI update when updateCliOnBoot is false", async () => {
    const sandbox = fakeSandbox()
    sandboxCreateMock.mockResolvedValue(sandbox)
    fetchMock.mockRejectedValueOnce(new Error("connect refused"))
    fetchMock.mockResolvedValue({ ok: true })

    const { e2bSandboxProvider } = await import("../provider.js")
    const bootSpec: SandboxSpec = {
      provider: "e2b",
      config: { healthProbeTimeoutMs: 0, updateCliOnBoot: false },
    }
    await e2bSandboxProvider.boot(bootSpec, { env: {} })

    expect(sandbox.commands.run).not.toHaveBeenCalledWith(
      "sudo npm i -g @agentproto/cli@latest",
      expect.anything(),
    )
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringContaining("agentproto serve"),
      expect.anything(),
    )
  })

  it("skips starting the daemon when the health probe already succeeds (autostart case)", async () => {
    const sandbox = fakeSandbox()
    sandboxCreateMock.mockResolvedValue(sandbox)
    fetchMock.mockResolvedValue({ ok: true })

    const { e2bSandboxProvider } = await import("../provider.js")
    await e2bSandboxProvider.boot(spec, { env: {} })

    expect(sandbox.commands.run).not.toHaveBeenCalled()
  })

  it("still runs config.setupCommands when the daemon was already autostarted — the hook install must not be skipped", async () => {
    const sandbox = fakeSandbox()
    sandboxCreateMock.mockResolvedValue(sandbox)
    fetchMock.mockResolvedValue({ ok: true }) // health probe succeeds immediately: autostart case

    const { e2bSandboxProvider } = await import("../provider.js")
    const bootSpec: SandboxSpec = {
      provider: "e2b",
      config: { setupCommands: ["install-hook-a"] },
    }
    await e2bSandboxProvider.boot(bootSpec, { env: { OPENROUTER_API_KEY: "k" } })

    // the setup command still lands even though this provider never had to
    // start the daemon itself
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      "install-hook-a",
      expect.objectContaining({ envs: { OPENROUTER_API_KEY: "k" } }),
    )
    // but the CLI update and `agentproto serve` are still skipped — only the
    // setup command ran
    expect(sandbox.commands.run).toHaveBeenCalledTimes(1)
  })

  it("uses config.template/port/workspace overrides from the spec", async () => {
    const sandbox = fakeSandbox()
    sandboxCreateMock.mockResolvedValue(sandbox)
    fetchMock.mockResolvedValue({ ok: true })

    const { e2bSandboxProvider } = await import("../provider.js")
    const customSpec: SandboxSpec = {
      provider: "e2b",
      config: { template: "custom-template", port: 9999, workspace: "/workspace" },
    }
    const booted = await e2bSandboxProvider.boot(customSpec, { env: {} })

    expect(sandboxCreateMock).toHaveBeenCalledWith("custom-template", expect.anything())
    expect(sandbox.getHost).toHaveBeenCalledWith(9999)
    expect(booted.mcpUrl).toBe("https://sbx-abc-9999.e2b.dev/mcp")
  })

  it("kills the sandbox and throws when the daemon never becomes healthy", async () => {
    const sandbox = fakeSandbox()
    sandboxCreateMock.mockResolvedValue(sandbox)
    fetchMock.mockRejectedValue(new Error("connect refused"))

    const { e2bSandboxProvider } = await import("../provider.js")
    const flakySpec: SandboxSpec = {
      provider: "e2b",
      config: { healthProbeTimeoutMs: 5, daemonReadyTimeoutMs: 5, pollIntervalMs: 5 },
    }
    await expect(e2bSandboxProvider.boot(flakySpec, { env: {} })).rejects.toThrow(/did not become healthy/)
    expect(sandbox.kill).toHaveBeenCalledTimes(1)
  })

  it("fails FAST with the box daemon's captured output when the serve process exits during boot", async () => {
    // A box whose daemon crashes on boot (e.g. it can't load a baked adapter)
    // must surface that crash to the caller and reclaim the VM — never hang
    // the HTTP/MCP call waiting out the full readiness window, never leak.
    const serveHandle = {
      // wait() rejects on a non-zero exit, just like a real CommandHandle for
      // a crashed process.
      wait: vi.fn(async () => {
        throw new Error("command exited with code 1")
      }),
      exitCode: 1,
      stdout: "",
      stderr: "agentproto: FATAL cannot find module '@agentproto/adapter-mastra-agent'",
    }
    const sandbox = fakeSandbox({
      commands: {
        run: vi.fn(async (cmd: string) =>
          cmd.includes("agentproto serve") ? serveHandle : {},
        ),
      },
    })
    sandboxCreateMock.mockResolvedValue(sandbox)
    // health never comes up; the fast path is the process-exit signal, not the
    // (long) readiness deadline.
    fetchMock.mockRejectedValue(new Error("connect refused"))

    const { e2bSandboxProvider } = await import("../provider.js")
    const bootSpec: SandboxSpec = {
      provider: "e2b",
      // A LONG readiness window on purpose: a correct fail-fast must not wait
      // for it — the exit race short-circuits well before 5 minutes.
      config: {
        healthProbeTimeoutMs: 0,
        template: "custom-template",
        daemonReadyTimeoutMs: 300_000,
        pollIntervalMs: 1,
        updateCliOnBoot: false,
      },
    }
    const err = await e2bSandboxProvider.boot(bootSpec, { env: {} }).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
    )
    expect(err).not.toBeNull()
    expect(err!.message).toMatch(/did not become healthy/)
    // the box's own daemon output is surfaced in the error (diagnosable) …
    expect(err!.message).toContain("cannot find module '@agentproto/adapter-mastra-agent'")
    // … and the early-exit is called out
    expect(err!.message).toMatch(/box daemon process exited during boot/)
    // … and the VM is reclaimed exactly once.
    expect(sandbox.kill).toHaveBeenCalledTimes(1)
  })

  it("never leaks the box when the boot npm install throws (kills, then rethrows)", async () => {
    // The live 2026-09-05 leak: a slow/failing `npm i -g` under registry load
    // threw AFTER Sandbox.create, and nothing reclaimed the running box.
    const sandbox = fakeSandbox({
      commands: {
        run: vi.fn(async (cmd: string) => {
          if (cmd.startsWith("sudo npm i -g")) throw new Error("npm ETIMEDOUT registry")
          return {}
        }),
      },
    })
    sandboxCreateMock.mockResolvedValue(sandbox)
    fetchMock.mockRejectedValueOnce(new Error("connect refused")) // initial probe: not up → triggers npm install

    const { e2bSandboxProvider } = await import("../provider.js")
    const bootSpec: SandboxSpec = {
      provider: "e2b",
      config: { healthProbeTimeoutMs: 0, template: "custom-template" },
    }
    await expect(e2bSandboxProvider.boot(bootSpec, { env: {} })).rejects.toThrow(/npm ETIMEDOUT/)
    // the VM is reclaimed, and the serve command was never reached
    expect(sandbox.kill).toHaveBeenCalledTimes(1)
    expect(sandbox.commands.run).not.toHaveBeenCalledWith(
      expect.stringContaining("agentproto serve"),
      expect.anything(),
    )
  })

  it("stop() kills the sandbox", async () => {
    const sandbox = fakeSandbox()
    sandboxCreateMock.mockResolvedValue(sandbox)
    fetchMock.mockResolvedValue({ ok: true })

    const { e2bSandboxProvider } = await import("../provider.js")
    const booted = await e2bSandboxProvider.boot(spec, { env: {} })
    await booted.stop()
    expect(sandbox.kill).toHaveBeenCalledTimes(1)
  })

  it("expose(port) returns https://<getHost(port)> for any port", async () => {
    const sandbox = fakeSandbox()
    sandboxCreateMock.mockResolvedValue(sandbox)
    fetchMock.mockResolvedValue({ ok: true })

    const { e2bSandboxProvider } = await import("../provider.js")
    const booted = await e2bSandboxProvider.boot(spec, { env: {} })
    const result = await booted.expose!(3210)
    expect(sandbox.getHost).toHaveBeenCalledWith(3210)
    expect(result.url).toBe("https://sbx-abc-3210.e2b.dev")
  })

  it("spec.extraPorts are resolved at boot into booted.ports", async () => {
    const sandbox = fakeSandbox()
    sandboxCreateMock.mockResolvedValue(sandbox)
    fetchMock.mockResolvedValue({ ok: true })

    const { e2bSandboxProvider } = await import("../provider.js")
    const bootSpec: SandboxSpec = {
      provider: "e2b",
      config: {},
      extraPorts: [3210, 8080],
    }
    const booted = await e2bSandboxProvider.boot(bootSpec, { env: {} })
    expect(booted.ports).toEqual({
      3210: "https://sbx-abc-3210.e2b.dev",
      8080: "https://sbx-abc-8080.e2b.dev",
    })
    expect(sandbox.getHost).toHaveBeenCalledWith(3210)
    expect(sandbox.getHost).toHaveBeenCalledWith(8080)
  })

  it("booted.ports is absent when extraPorts is not declared", async () => {
    const sandbox = fakeSandbox()
    sandboxCreateMock.mockResolvedValue(sandbox)
    fetchMock.mockResolvedValue({ ok: true })

    const { e2bSandboxProvider } = await import("../provider.js")
    const booted = await e2bSandboxProvider.boot(spec, { env: {} })
    expect(booted.ports).toBeUndefined()
  })
})
