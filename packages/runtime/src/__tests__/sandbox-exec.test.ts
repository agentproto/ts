import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { AuthProfile } from "@agentproto/auth"
import type { BootedSandbox, SandboxBootOpts, SandboxSpec } from "@agentproto/sandbox"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"
import type { SandboxProviderResolver } from "../sandbox-adapters.js"
import {
  SANDBOX_EXEC_MAX_COMMAND_BYTES,
  SANDBOX_EXEC_MAX_ENV_BYTES,
  SANDBOX_EXEC_STREAM_MAX_CHARS,
  execSandboxCommand,
  registerSandboxExecTool,
  type ExecSandboxCommandOptions,
} from "../sandbox-exec.js"

// ── fake McpServer that captures registered tools ──────────────────────────

interface Registered {
  name: string
  description: string
  shape: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<{
    content: { type: "text"; text: string }[]
    isError?: boolean
  }>
}

function fakeServer(): { server: McpServer; tools: Registered[] } {
  const tools: Registered[] = []
  const server = {
    tool: (
      name: string,
      description: string,
      shape: Record<string, unknown>,
      handler: Registered["handler"],
    ) => {
      tools.push({ name, description, shape, handler })
    },
  } as unknown as McpServer
  return { server, tools }
}

const CAPABILITIES = { networkEgress: true, mounts: false, lifecyclePause: true, readOnly: false }

/** Fake `BootedSandbox` whose `exec()` is a spy — zero vendor-SDK calls. */
function fakeBooted(opts: {
  sandboxId?: string
  exec?: (command: { command: string; cwd?: string; env?: Record<string, string>; timeoutMs?: number }) => Promise<{
    exitCode: number
    stdout: string
    stderr: string
    durationMs: number
  }>
  omitExec?: boolean
}): { booted: BootedSandbox; stop: ReturnType<typeof vi.fn>; exec: ReturnType<typeof vi.fn> | undefined } {
  const stop = vi.fn(async () => {})
  if (opts.omitExec || !opts.exec) {
    return {
      booted: {
        mcpUrl: "mcp",
        sandboxId: opts.sandboxId ?? "sbx_abc",
        stop,
      },
      stop,
      exec: undefined,
    }
  }
  const exec = vi.fn(opts.exec)
  return {
    booted: {
      mcpUrl: "mcp",
      sandboxId: opts.sandboxId ?? "sbx_abc",
      exec: exec as unknown as BootedSandbox["exec"],
      stop,
    },
    stop,
    exec,
  }
}

/** Fake `SandboxProviderHandle` wiring boot/connect to the procured fakes above. */
function fakeHandle(opts: {
  connect?: (id: string, spec: SandboxSpec, bootOpts: SandboxBootOpts) => Promise<BootedSandbox>
  connectForExec?: (id: string, spec: SandboxSpec, bootOpts: SandboxBootOpts) => Promise<BootedSandbox>
  boot?: (spec: SandboxSpec, bootOpts: SandboxBootOpts) => Promise<BootedSandbox>
  omitConnect?: boolean
}): SandboxProviderHandle {
  return {
    slug: "e2b",
    name: "e2b",
    version: "installed",
    description: "fake",
    requiresSetup: true,
    capabilities: { ...CAPABILITIES, exec: true },
    provider: {
      boot: opts.boot ?? (vi.fn(async () => ({})) as unknown as SandboxProviderHandle["provider"]["boot"]),
      ...(opts.omitConnect
        ? {}
        : {
            connect:
              opts.connect ??
              (vi.fn(async () => {
                throw new Error("should not connect in this test")
              }) as unknown as SandboxProviderHandle["provider"]["connect"]),
          }),
      ...(opts.connectForExec
        ? { connectForExec: opts.connectForExec as SandboxProviderHandle["provider"]["connectForExec"] }
        : {}),
    },
    async check() {
      return true
    },
  }
}

function resolverFor(handle: SandboxProviderHandle | null): SandboxProviderResolver {
  return async () => handle
}

let ledgerPath = ""

beforeEach(async () => {
  ledgerPath = join(await mkdtemp(join(tmpdir(), "sandbox-exec-")), "sandboxes.json")
  vi.stubEnv("AGENTPROTO_SANDBOX_LEDGER", ledgerPath)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// ── execSandboxCommand ───────────────────────────────────────────────────

describe("execSandboxCommand", () => {
  it("runs the command on a fresh EPHEMERAL box and always stops it", async () => {
    const procured = fakeBooted({
      exec: async () => ({ exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 5 }),
    })
    const boot = vi.fn(async () => procured.booted)
    const handle = fakeHandle({ boot })

    const result = await execSandboxCommand(
      { provider: "e2b", command: "pnpm test" },
      { resolveSandboxProvider: resolverFor(handle) },
    )

    expect(boot).toHaveBeenCalledWith(
      { provider: "e2b", config: {} },
      expect.objectContaining({ env: {} }),
    )
    expect(procured.exec).toHaveBeenCalledWith(
      expect.objectContaining({ command: "pnpm test" }),
    )
    expect(procured.stop).toHaveBeenCalledTimes(1) // ephemeral box torn down
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.exitCode).toBe(0)
      expect(result.result.stdout).toBe("ok\n")
      expect(result.result.stderr).toBe("")
      expect(result.result.sandboxId).toBe("sbx_abc")
      expect(result.result.stdoutTruncated).toBe(false)
      expect(result.result.stderrTruncated).toBe(false)
    }
  })

  it("targets the EXISTING sandbox via connect() when sandboxId is given and never stops it", async () => {
    const procured = fakeBooted({
      sandboxId: "sbx_existing",
      exec: async () => ({ exitCode: 7, stdout: "", stderr: "boom\n", durationMs: 4 }),
    })
    const connect = vi.fn(async (id: string, _spec: SandboxSpec, _opts: SandboxBootOpts) => procured.booted)
    const handle = fakeHandle({ connect })

    const result = await execSandboxCommand(
      { provider: "e2b", sandboxId: "sbx_existing", command: "false" },
      { resolveSandboxProvider: resolverFor(handle) },
    )

    expect(connect).toHaveBeenCalledWith(
      "sbx_existing",
      { provider: "e2b", config: {} },
      expect.anything(),
    )
    expect(procured.stop).not.toHaveBeenCalled() // attached box left as found
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Non-zero exit is a RESULT, not a failure.
      expect(result.result.exitCode).toBe(7)
      expect(result.result.sandboxId).toBe("sbx_existing")
    }
  })

  it("prefers the exec-only provider path over connect() when the provider offers one", async () => {
    const procured = fakeBooted({
      sandboxId: "sbx_existing",
      exec: async () => ({ exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 1 }),
    })
    const connect = vi.fn(async () => {
      throw new Error("connect must not run for an exec-only call")
    })
    const connectForExec = vi.fn(async (_id: string, _spec: SandboxSpec, _opts: SandboxBootOpts) => procured.booted)
    const handle = fakeHandle({ connect, connectForExec })

    const result = await execSandboxCommand(
      { provider: "computer", sandboxId: "sbx_existing", command: "true" },
      { resolveSandboxProvider: resolverFor(handle) },
    )

    expect(connectForExec).toHaveBeenCalledWith(
      "sbx_existing",
      { provider: "computer", config: {} },
      expect.anything(),
    )
    expect(connect).not.toHaveBeenCalled()
    expect(procured.stop).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
  })

  it("forwards cwd, env and timeoutMs to the box's exec", async () => {
    const procured = fakeBooted({
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
    })
    const handle = fakeHandle({ boot: vi.fn(async () => procured.booted) })

    await execSandboxCommand(
      {
        provider: "e2b",
        command: "ls",
        cwd: "/home/user",
        env: { FOO: "bar" },
        timeoutMs: 1234,
      },
      { resolveSandboxProvider: resolverFor(handle) },
    )

    expect(procured.exec).toHaveBeenCalledWith({
      command: "ls",
      cwd: "/home/user",
      env: { FOO: "bar" },
      timeoutMs: 1234,
    })
  })

  it("returns sandbox_provider_not_found for an unknown provider slug", async () => {
    const result = await execSandboxCommand(
      { provider: "nope", command: "true" },
      { resolveSandboxProvider: resolverFor(null) },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("sandbox_provider_not_found")
  })

  it("returns sandbox_no_exec for a provider whose booted sandbox has no exec capability (ephemeral path still stops the box)", async () => {
    const procured = fakeBooted({ omitExec: true })
    const handle = fakeHandle({ boot: vi.fn(async () => procured.booted) })

    const result = await execSandboxCommand(
      { provider: "local", command: "true" },
      { resolveSandboxProvider: resolverFor(handle) },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("sandbox_no_exec")
      expect(result.message).toContain("does not support command exec")
    }
    expect(procured.stop).toHaveBeenCalledTimes(1)
  })

  it("returns sandbox_no_exec for a persistent sandbox with no exec capability and leaves it running", async () => {
    const procured = fakeBooted({ sandboxId: "sbx_existing", omitExec: true })
    const handle = fakeHandle({ connect: vi.fn(async () => procured.booted) })

    const result = await execSandboxCommand(
      { provider: "local", sandboxId: "sbx_existing", command: "true" },
      { resolveSandboxProvider: resolverFor(handle) },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("sandbox_no_exec")
    expect(procured.stop).not.toHaveBeenCalled()
  })

  it("turns a THROWN exec (e.g. command timeout) into sandbox_exec_failed and still stops the ephemeral box", async () => {
    const procured = fakeBooted({
      exec: async () => {
        throw new Error("timed out after 500ms")
      },
    })
    const handle = fakeHandle({ boot: vi.fn(async () => procured.booted) })

    const result = await execSandboxCommand(
      { provider: "e2b", command: "sleep 999", timeoutMs: 500 },
      { resolveSandboxProvider: resolverFor(handle) },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("sandbox_exec_failed")
      expect(result.message).toContain("timed out after 500ms")
    }
    expect(procured.stop).toHaveBeenCalledTimes(1)
  })

  it("surfaces a boot failure as sandbox_exec_failed — nothing exec'd, nothing to stop", async () => {
    const boot = vi.fn(async () => {
      throw new Error("quota exceeded")
    })
    const handle = fakeHandle({ boot })

    const result = await execSandboxCommand(
      { provider: "e2b", command: "true" },
      { resolveSandboxProvider: resolverFor(handle) },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("sandbox_exec_failed")
      expect(result.message).toContain("quota exceeded")
    }
  })

  it("truncates each stream beyond the cap with an explicit marker + booleans", async () => {
    const long = "x".repeat(SANDBOX_EXEC_STREAM_MAX_CHARS + 40)
    const wf = fakeBooted({
      exec: async () => ({ exitCode: 0, stdout: long, stderr: "y".repeat(SANDBOX_EXEC_STREAM_MAX_CHARS + 9), durationMs: 2 }),
    })
    const handle = fakeHandle({ boot: vi.fn(async () => wf.booted) })

    const result = await execSandboxCommand(
      { provider: "e2b", command: "cat /dev/db" },
      { resolveSandboxProvider: resolverFor(handle) },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.stdoutTruncated).toBe(true)
      expect(result.result.stderrTruncated).toBe(true)
      expect(result.result.stdout.startsWith("x".repeat(SANDBOX_EXEC_STREAM_MAX_CHARS))).toBe(true)
      expect(result.result.stdout).toContain("…[truncated:")
      expect(result.result.stdout.length).toBeLessThan(long.length + 100)
    }
  })

  it("stamps the ledger connected when targeting an existing sandbox (AGENTPROTO_SANDBOX_LEDGER override)", async () => {
    const procured = fakeBooted({
      sandboxId: "sbx_existing",
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
    })
    const handle = fakeHandle({ connect: vi.fn(async () => procured.booted) })

    await execSandboxCommand(
      { provider: "e2b", sandboxId: "sbx_existing", command: "true" },
      { resolveSandboxProvider: resolverFor(handle) },
    )

    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as {
      sandboxes: { sandboxId: string; state: string }[]
    }
    expect(ledger.sandboxes.some(s => s.sandboxId === "sbx_existing" && s.state === "connected")).toBe(true)
  })
})

// ── sandbox_exec tool ────────────────────────────────────────────────────

describe("sandbox_exec tool", () => {
  it("returns the exec output as tool content on success", async () => {
    const procured = fakeBooted({
      exec: async () => ({ exitCode: 0, stdout: "hi\n", stderr: "", durationMs: 3 }),
    })
    const { server, tools } = fakeServer()
    registerSandboxExecTool(server, {
      resolveSandboxProvider: resolverFor(fakeHandle({ boot: vi.fn(async () => procured.booted) })),
    })

    const tool = tools.find(t => t.name === "sandbox_exec")!
    const result = await tool.handler({ provider: "e2b", command: "echo hi" })

    expect(result.isError).toBeUndefined()
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.exitCode).toBe(0)
    expect(payload.stdout).toBe("hi\n")
    expect(payload.sandboxId).toBe("sbx_abc")
  })

  it("returns isError + the failure code/message when exec fails", async () => {
    const { server, tools } = fakeServer()
    registerSandboxExecTool(server, { resolveSandboxProvider: resolverFor(null) })

    const tool = tools.find(t => t.name === "sandbox_exec")!
    const result = await tool.handler({ provider: "e2b", command: "true" })

    expect(result.isError).toBe(true)
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.code).toBe("sandbox_provider_not_found")
  })
})

// ── envProfiles / errors / size guard / files ────────────────────────────

const SECRET = "sk-test-SECRET-value-0123456789"
const OK_EXEC = async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 })

const plainProfile: AuthProfile = {
  id: "opencode-zen-free",
  endpoint: "opencode",
  method: "api-key",
  credentialRef: "slot/opencode-zen",
}

/** Deps with an in-memory profile table + keychain mock (no real keychain). */
function profileDeps(
  profiles: AuthProfile[],
  keychain: Record<string, string>,
  extra: Partial<ExecSandboxCommandOptions> = {},
): ExecSandboxCommandOptions & { read: ReturnType<typeof vi.fn> } {
  const read = vi.fn(async (ref: { path: string }) => {
    const value = keychain[ref.path]
    return value === undefined ? undefined : { value, kind: "pat" as const }
  })
  return {
    getAuthProfile: async id => profiles.find(p => p.id === id),
    secretStore: { read },
    read,
    ...extra,
  }
}

function setup(exec = OK_EXEC) {
  const procured = fakeBooted({ exec })
  const boot = vi.fn(async () => procured.booted)
  return { procured, handle: fakeHandle({ boot }), boot }
}

describe("sandbox_exec envProfiles", () => {
  it("reads a plain profile's credential through the keychain store and hands it to the provider exec env only", async () => {
    const { procured, handle } = setup()
    const deps = profileDeps([plainProfile], { "slot/opencode-zen": SECRET })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const log = vi.spyOn(console, "log").mockImplementation(() => {})

    const result = await execSandboxCommand(
      {
        provider: "e2b",
        command: "opencode run",
        env: { PLAIN: "1" },
        envProfiles: { OPENCODE_API_KEY: "opencode-zen-free" },
      },
      { ...deps, resolveSandboxProvider: resolverFor(handle) },
    )

    expect(deps.read).toHaveBeenCalledWith({ path: "slot/opencode-zen" })
    expect(procured.exec).toHaveBeenCalledWith(
      expect.objectContaining({ command: "opencode run", env: { PLAIN: "1", OPENCODE_API_KEY: SECRET } }),
    )
    // The value is in env only: not in argv (command), the result, or any log line.
    expect(procured.exec!.mock.calls[0]![0].command).not.toContain(SECRET)
    expect(JSON.stringify(result)).not.toContain(SECRET)
    for (const spy of [warn, log]) expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET)
    warn.mockRestore()
    log.mockRestore()
  })

  it("never lets the caller name a keychain ref: an id that is not a profile is just unknown", async () => {
    const { procured, handle } = setup()
    const deps = profileDeps([plainProfile], { "slot/opencode-zen": SECRET })
    const result = await execSandboxCommand(
      { provider: "e2b", command: "true", envProfiles: { OPENCODE_API_KEY: "slot/opencode-zen" } },
      { ...deps, resolveSandboxProvider: resolverFor(handle) },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("sandbox_exec_env_profile")
      expect(result.message).toContain('unknown auth profile "slot/opencode-zen"')
    }
    expect(deps.read).not.toHaveBeenCalled()
    expect(procured.exec).not.toHaveBeenCalled()
  })

  it("rejects an unknown profile id with a clear error before booting anything", async () => {
    const { handle, boot } = setup()
    const result = await execSandboxCommand(
      { provider: "e2b", command: "true", envProfiles: { K_EY: "nope" } },
      { ...profileDeps([], {}), resolveSandboxProvider: resolverFor(handle) },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("sandbox_exec_env_profile")
      expect(result.message).toContain('unknown auth profile "nope"')
    }
    expect(boot).not.toHaveBeenCalled()
  })

  it("refuses a disabled profile without reading its credential", async () => {
    const { handle, boot } = setup()
    const deps = profileDeps([{ ...plainProfile, disabled: true }], { "slot/opencode-zen": SECRET })
    const result = await execSandboxCommand(
      { provider: "e2b", command: "true", envProfiles: { OPENCODE_API_KEY: "opencode-zen-free" } },
      { ...deps, resolveSandboxProvider: resolverFor(handle) },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("is disabled")
    expect(deps.read).not.toHaveBeenCalled()
    expect(boot).not.toHaveBeenCalled()
  })

  it.each(["lowercase", "1LEADING_DIGIT", "HAS-DASH", "HAS SPACE", ""])(
    "rejects the invalid env name %j",
    async name => {
      const { handle, boot } = setup()
      const result = await execSandboxCommand(
        { provider: "e2b", command: "true", envProfiles: { [name]: "opencode-zen-free" } },
        { ...profileDeps([plainProfile], {}), resolveSandboxProvider: resolverFor(handle) },
      )
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe("sandbox_exec_invalid_input")
        expect(result.message).toContain("not a valid env var name")
      }
      expect(boot).not.toHaveBeenCalled()
    },
  )

  it("rejects a literal env var and a profile naming the same variable", async () => {
    const { handle, boot } = setup()
    const deps = profileDeps([plainProfile], { "slot/opencode-zen": SECRET })
    const result = await execSandboxCommand(
      {
        provider: "e2b",
        command: "true",
        env: { OPENCODE_API_KEY: "literal" },
        envProfiles: { OPENCODE_API_KEY: "opencode-zen-free" },
      },
      { ...deps, resolveSandboxProvider: resolverFor(handle) },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("sandbox_exec_invalid_input")
      expect(result.message).toContain("also set in `env`")
    }
    expect(deps.read).not.toHaveBeenCalled()
    expect(boot).not.toHaveBeenCalled()
  })

  it("fails loudly when the keychain has no value for the profile's ref", async () => {
    const { handle, boot } = setup()
    const result = await execSandboxCommand(
      { provider: "e2b", command: "true", envProfiles: { OPENCODE_API_KEY: "opencode-zen-free" } },
      { ...profileDeps([plainProfile], {}), resolveSandboxProvider: resolverFor(handle) },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("could not be read from the keychain")
    expect(boot).not.toHaveBeenCalled()
  })

  it("does not fall back to the daemon's own env for the requested name", async () => {
    vi.stubEnv("OPENCODE_API_KEY", "daemon-env-value-should-not-leak")
    const { handle } = setup()
    const result = await execSandboxCommand(
      { provider: "e2b", command: "true", envProfiles: { OPENCODE_API_KEY: "opencode-zen-free" } },
      { ...profileDeps([plainProfile], {}), resolveSandboxProvider: resolverFor(handle) },
    )
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain("daemon-env-value-should-not-leak")
  })

  it("refuses a source-backed profile that has no stored credential and no sub-account", async () => {
    const { handle } = setup()
    const { credentialRef: _drop, ...bare } = plainProfile
    const result = await execSandboxCommand(
      { provider: "e2b", command: "true", envProfiles: { K_EY: "opencode-zen-free" } },
      {
        ...profileDeps([{ ...bare, method: "oauth-bearer", source: "claude-code-oauth" }], {}),
        resolveSandboxProvider: resolverFor(handle),
      },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("source-backed")
  })

  it("rejects envProfiles on a device target (keychain refs never reach another machine)", async () => {
    const { handle, boot } = setup()
    const deps = profileDeps([plainProfile], { "slot/opencode-zen": SECRET })
    const result = await execSandboxCommand(
      { provider: "device:laptop", command: "true", envProfiles: { OPENCODE_API_KEY: "opencode-zen-free" } },
      { ...deps, resolveSandboxProvider: resolverFor(handle) },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("device targets")
    expect(deps.read).not.toHaveBeenCalled()
    expect(boot).not.toHaveBeenCalled()
  })

  describe("sub-account profiles", () => {
    const subProfile: AuthProfile = {
      id: "opencode-org",
      endpoint: "opencode",
      method: "api-key",
      source: "opencode-console",
      subaccount: { kind: "org", id: "org_1" },
    }

    it("goes through the registered SubaccountProvider: credential → requested name, provider env merged", async () => {
      const { procured, handle } = setup()
      const resolveSubaccount = vi.fn(async () => ({
        pin: subProfile.subaccount!,
        credential: SECRET,
        authInputs: { credentialEnvOverride: "IGNORED", extraEnv: { OPENCODE_CONFIG_CONTENT: '{"org":"org_1"}' } },
      }))
      const result = await execSandboxCommand(
        { provider: "e2b", command: "opencode run", envProfiles: { OPENCODE_API_KEY: "opencode-org" } },
        { ...profileDeps([subProfile], {}), resolveSubaccount, resolveSandboxProvider: resolverFor(handle) },
      )
      expect(resolveSubaccount).toHaveBeenCalledWith(subProfile, {})
      expect(procured.exec).toHaveBeenCalledWith(
        expect.objectContaining({
          env: { OPENCODE_API_KEY: SECRET, OPENCODE_CONFIG_CONTENT: '{"org":"org_1"}' },
        }),
      )
      expect(JSON.stringify(result)).not.toContain(SECRET)
    })

    it("hands the parent account's stored credential to the provider when the profile has a ref", async () => {
      const { handle } = setup()
      const withRef = { ...subProfile, credentialRef: "slot/parent" }
      const resolveSubaccount = vi.fn(async () => ({
        pin: subProfile.subaccount!,
        credential: "scoped-token-abcdef",
        authInputs: {},
      }))
      await execSandboxCommand(
        { provider: "e2b", command: "x", envProfiles: { OPENCODE_API_KEY: "opencode-org" } },
        {
          ...profileDeps([withRef], { "slot/parent": "parent-secret-123456" }),
          resolveSubaccount,
          resolveSandboxProvider: resolverFor(handle),
        },
      )
      expect(resolveSubaccount).toHaveBeenCalledWith(withRef, { credential: "parent-secret-123456" })
    })

    it("surfaces a provider failure without echoing secrets", async () => {
      const { handle } = setup()
      const result = await execSandboxCommand(
        { provider: "e2b", command: "x", envProfiles: { OPENCODE_API_KEY: "opencode-org" } },
        {
          ...profileDeps([subProfile], {}),
          resolveSubaccount: async () => {
            throw new Error("org not found")
          },
          resolveSandboxProvider: resolverFor(handle),
        },
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toContain("org not found")
    })

    it("rejects a provider env var that collides with a literal env var", async () => {
      const { handle } = setup()
      const result = await execSandboxCommand(
        {
          provider: "e2b",
          command: "x",
          env: { OPENCODE_CONFIG_CONTENT: "mine" },
          envProfiles: { OPENCODE_API_KEY: "opencode-org" },
        },
        {
          ...profileDeps([subProfile], {}),
          resolveSubaccount: async () => ({
            pin: subProfile.subaccount!,
            credential: SECRET,
            authInputs: { extraEnv: { OPENCODE_CONFIG_CONTENT: "theirs" } },
          }),
          resolveSandboxProvider: resolverFor(handle),
        },
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toContain("collides")
    })
  })
})

describe("sandbox_exec redaction + error hygiene", () => {
  it("redacts a resolved secret from stdout, stderr and the exec error", async () => {
    const leaky = setup(async () => ({
      exitCode: 1,
      stdout: `token=${SECRET}\n`,
      stderr: `bad ${SECRET} bad`,
      durationMs: 1,
    }))
    const deps = profileDeps([plainProfile], { "slot/opencode-zen": SECRET })
    const ok = await execSandboxCommand(
      { provider: "e2b", command: "env", envProfiles: { OPENCODE_API_KEY: "opencode-zen-free" } },
      { ...deps, resolveSandboxProvider: resolverFor(leaky.handle) },
    )
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.result.stdout).toBe("token=<redacted>\n")
      expect(ok.result.stderr).toBe("bad <redacted> bad")
    }

    const throwing = setup(async () => {
      throw new Error(`upstream said: invalid credentials ${SECRET}`)
    })
    const failed = await execSandboxCommand(
      { provider: "e2b", command: "env", envProfiles: { OPENCODE_API_KEY: "opencode-zen-free" } },
      { ...deps, resolveSandboxProvider: resolverFor(throwing.handle) },
    )
    expect(failed.ok).toBe(false)
    if (!failed.ok) {
      expect(failed.message).toContain("<redacted>")
      expect(failed.message).not.toContain(SECRET)
    }
  })

  it("redacts a literal env secret (secret-looking name) from the provider error too", async () => {
    const throwing = setup(async () => {
      throw new Error(`boom ${SECRET}`)
    })
    const failed = await execSandboxCommand(
      { provider: "e2b", command: "x", env: { MY_API_TOKEN: SECRET } },
      { resolveSandboxProvider: resolverFor(throwing.handle) },
    )
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.message).not.toContain(SECRET)
  })

  it("does not shred output for short benign literal env values", async () => {
    const { handle } = setup(async () => ({ exitCode: 0, stdout: "mode=prod\n", stderr: "", durationMs: 1 }))
    const result = await execSandboxCommand(
      { provider: "e2b", command: "x", env: { MODE: "prod" } },
      { resolveSandboxProvider: resolverFor(handle) },
    )
    expect(result.ok && result.result.stdout).toBe("mode=prod\n")
  })

  it("truncates the echoed command in a provider error to ~200 chars with a …(N chars) marker", async () => {
    const short = "echo " + "b".repeat(1000)
    const second = setup(async () => {
      throw new Error(`[invalid_argument] error starting process '/bin/bash -l -c ${short}'`)
    })
    const failed2 = await execSandboxCommand(
      { provider: "e2b", command: short },
      { resolveSandboxProvider: resolverFor(second.handle) },
    )
    expect(failed2.ok).toBe(false)
    if (!failed2.ok) {
      expect(failed2.message).toContain("…(1005 chars)")
      expect(failed2.message).not.toContain("b".repeat(300))
      expect(failed2.message).toContain("upload scripts via `files`")
    }
  })
})

describe("sandbox_exec size guard", () => {
  it("rejects an oversized command before booting, with an actionable message", async () => {
    const { handle, boot } = setup()
    const result = await execSandboxCommand(
      { provider: "e2b", command: "x".repeat(SANDBOX_EXEC_MAX_COMMAND_BYTES + 1000) },
      { resolveSandboxProvider: resolverFor(handle) },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("sandbox_exec_too_large")
      expect(result.message).toContain("command is 17 KB, over the 16 KB limit")
      expect(result.message).toContain("files: [{ path, content }]")
    }
    expect(boot).not.toHaveBeenCalled()
  })

  it("rejects an oversized total env, naming the largest variable but never a value", async () => {
    const { handle, boot } = setup()
    const result = await execSandboxCommand(
      { provider: "e2b", command: "true", env: { BIG_PAYLOAD: "v".repeat(SANDBOX_EXEC_MAX_ENV_BYTES + 10) } },
      { resolveSandboxProvider: resolverFor(handle) },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("sandbox_exec_too_large")
      expect(result.message).toContain("largest: BIG_PAYLOAD")
      expect(result.message).not.toContain("vvvv")
    }
    expect(boot).not.toHaveBeenCalled()
  })

  it("counts profile-resolved env toward the env ceiling", async () => {
    const { handle } = setup()
    const result = await execSandboxCommand(
      { provider: "e2b", command: "true", envProfiles: { OPENCODE_API_KEY: "opencode-zen-free" } },
      {
        ...profileDeps([plainProfile], { "slot/opencode-zen": "k".repeat(SANDBOX_EXEC_MAX_ENV_BYTES) }),
        resolveSandboxProvider: resolverFor(handle),
      },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("sandbox_exec_too_large")
      expect(result.message).not.toContain("kkkk")
    }
  })

  it("accepts a command/env just under the ceilings", async () => {
    const { handle } = setup()
    const result = await execSandboxCommand(
      { provider: "e2b", command: "x".repeat(SANDBOX_EXEC_MAX_COMMAND_BYTES), env: { A: "v".repeat(1000) } },
      { resolveSandboxProvider: resolverFor(handle) },
    )
    expect(result.ok).toBe(true)
  })
})

describe("sandbox_exec files", () => {
  function withWriteFile() {
    const writeFile = vi.fn(async (_path: string, _data: Uint8Array) => {})
    const stop = vi.fn(async () => {})
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }))
    const booted = { mcpUrl: "m", sandboxId: "sbx_f", exec, writeFile, stop } as unknown as BootedSandbox
    return { writeFile, stop, exec, handle: fakeHandle({ boot: vi.fn(async () => booted) }) }
  }

  it("writes each file (utf8 and base64) into the box BEFORE running the command", async () => {
    const w = withWriteFile()
    const order: string[] = []
    w.writeFile.mockImplementation(async p => void order.push(`write:${p}`))
    w.exec.mockImplementation(async () => (order.push("exec"), { exitCode: 0, stdout: "", stderr: "", durationMs: 1 }))
    const result = await execSandboxCommand(
      {
        provider: "e2b",
        command: "bash /home/user/run.sh",
        files: [
          { path: "/home/user/run.sh", content: "echo hi\n" },
          { path: "/home/user/blob.bin", content: Buffer.from([0, 1, 255]).toString("base64"), encoding: "base64" },
        ],
      },
      { resolveSandboxProvider: resolverFor(w.handle) },
    )
    expect(result.ok).toBe(true)
    expect(order).toEqual(["write:/home/user/run.sh", "write:/home/user/blob.bin", "exec"])
    expect(Buffer.from(w.writeFile.mock.calls[0]![1]).toString()).toBe("echo hi\n")
    expect(Array.from(w.writeFile.mock.calls[1]![1])).toEqual([0, 1, 255])
  })

  it("rejects relative paths, duplicates and bad base64 before booting", async () => {
    const w = withWriteFile()
    const run = (files: { path: string; content: string; encoding?: "utf8" | "base64" }[]) =>
      execSandboxCommand({ provider: "e2b", command: "x", files }, { resolveSandboxProvider: resolverFor(w.handle) })
    const rel = await run([{ path: "run.sh", content: "" }])
    const dup = await run([{ path: "/a", content: "" }, { path: "/a", content: "" }])
    const b64 = await run([{ path: "/a", content: "***", encoding: "base64" }])
    for (const r of [rel, dup, b64]) {
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe("sandbox_exec_invalid_input")
    }
    expect(w.writeFile).not.toHaveBeenCalled()
  })

  it("reports unsupported when the provider's box cannot write files, and stops the ephemeral box", async () => {
    const { procured, handle } = setup()
    const result = await execSandboxCommand(
      { provider: "e2b", command: "x", files: [{ path: "/a", content: "1" }] },
      { resolveSandboxProvider: resolverFor(handle) },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("sandbox_no_write_file")
    expect(procured.stop).toHaveBeenCalledTimes(1)
    expect(procured.exec).not.toHaveBeenCalled()
  })

  it("a failed write skips the command, stops the ephemeral box, and does not echo file content", async () => {
    const w = withWriteFile()
    w.writeFile.mockRejectedValue(new Error("disk full"))
    const result = await execSandboxCommand(
      { provider: "e2b", command: "x", files: [{ path: "/a", content: "TOPSECRETCONTENT" }] },
      { resolveSandboxProvider: resolverFor(w.handle) },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain("disk full")
      expect(result.message).not.toContain("TOPSECRETCONTENT")
    }
    expect(w.exec).not.toHaveBeenCalled()
    expect(w.stop).toHaveBeenCalledTimes(1)
  })
})

describe("sandbox_exec tool envProfiles/files wiring", () => {
  it("exposes envProfiles + files and returns a result with no secret in it", async () => {
    const { handle } = setup()
    const { server, tools } = fakeServer()
    registerSandboxExecTool(server, {
      resolveSandboxProvider: resolverFor(handle),
      envProfiles: profileDeps([plainProfile], { "slot/opencode-zen": SECRET }),
    })
    const tool = tools.find(t => t.name === "sandbox_exec")!
    expect(Object.keys(tool.shape)).toEqual(expect.arrayContaining(["envProfiles", "files"]))
    const result = await tool.handler({
      provider: "e2b",
      command: "env",
      envProfiles: { OPENCODE_API_KEY: "opencode-zen-free" },
    })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).not.toContain(SECRET)
  })
})
