import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { BootedSandbox, SandboxBootOpts, SandboxSpec } from "@agentproto/sandbox"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"
import type { SandboxProviderResolver } from "../sandbox-adapters.js"
import {
  SANDBOX_EXEC_STREAM_MAX_CHARS,
  execSandboxCommand,
  registerSandboxExecTool,
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
