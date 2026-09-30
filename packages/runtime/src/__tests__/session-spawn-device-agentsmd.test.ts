/**
 * Device-spawn workspace-contract suppression (BOOTSTRAP P5 /
 * agentproto/ts #1637). Field-verified cross-device leak: for an
 * `agent_start({ sandbox: "device:<fp>" })`, the controller's
 * `spawnAgentSession` resolved AGENTS.md at the CONTROLLER's cwd and
 * composed it into `effectivePrompt` BEFORE `bootSandboxAgentSession`
 * updated cwd to the remote `booted.cwd`. The composed pointer rode to the
 * remote session, whose agent tried to read the Mac path `/Volumes/...` as
 * `C:\Volumes\...` → File not found.
 *
 * The fix: for a device-sandboxed spawn the controller skips
 * workspace-contract resolution entirely (AGENTS.md + the same-class
 * controller RULES.md + the pointer read-grant), stamps the descriptor
 * `agentsMdMode: "absent"` with NO controller path, and composes the first
 * prompt from transportable text only (role preamble, promptAppend, the
 * caller's own ask) plus the path-free `deviceContractLine`. The TARGET
 * device's own daemon resolves its own contract. Local (non-device) spawn
 * behavior is unchanged — asserted here and covered by the pre-existing
 * session-spawn.test.ts AGENTS.md blocks.
 *
 * Mocks `@agentproto/sandbox`'s `createSandboxAgentSessionHost` exactly as
 * `sandbox-omit-cwd-when-implicit.test.ts` does, so the remote-facing side
 * is a controlled double, and keeps the sandbox ledger in-memory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const wsConfigState = vi.hoisted(() => ({
  value: { version: 1, workspaces: [] } as import("../workspaces-config.js").WorkspacesConfig,
}))
vi.mock("../workspaces-config.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../workspaces-config.js")>()
  return { ...actual, loadWorkspacesConfig: vi.fn(async () => wsConfigState.value) }
})

const ledgerMocks = vi.hoisted(() => ({
  recordBoot: vi.fn(),
  recordState: vi.fn(),
  recordOrigin: vi.fn(),
  recordLiveness: vi.fn(),
}))
vi.mock("../sandbox-ledger.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../sandbox-ledger.js")>()
  return {
    ...actual,
    recordSandboxBoot: ledgerMocks.recordBoot,
    recordSandboxState: ledgerMocks.recordState,
    recordSandboxOrigin: ledgerMocks.recordOrigin,
    recordSandboxLiveness: ledgerMocks.recordLiveness,
  }
})

const startMock = vi.hoisted(() =>
  vi.fn(async (_args: Record<string, unknown>) => ({
    id: "remote_sess_1",
    cwd: "C:\\Users\\win\\workspace",
  })),
)
const hostPromptMock = vi.hoisted(() => vi.fn(async (_remoteSessionId: string, _prompt: string) => {}))
vi.mock("@agentproto/sandbox", async importOriginal => {
  const actual = await importOriginal<typeof import("@agentproto/sandbox")>()
  return {
    ...actual,
    createSandboxAgentSessionHost: vi.fn(async () => ({
      mcpUrl: "http://127.0.0.1:0/mcp",
      sandboxId: "sbx_fake_device_target",
      start: startMock,
      prompt: hostPromptMock,
      output: vi.fn(async () => ""),
      kill: vi.fn(async () => {}),
      waitForAny: vi.fn(async () => ({ event: "any" as const, timedOut: false })),
      currentEventsCursor: vi.fn(async () => 0),
      stop: vi.fn(async () => {}),
    })),
  }
})

import {
  spawnAgentSession,
  deviceContractLine,
  type SpawnAgentSessionDeps,
} from "../session-spawn.js"
import type { AgentAdapterResolver } from "../http-server.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"
import { isDeviceSandboxTarget } from "../sandbox-providers/device.js"
import { cdContractLine, resolveAgentsMd } from "../agents-md.js"

const CONTROLLER_CWD = "/Volumes/SSDExternalMacStudio/Code/products/agentik/agentik-studio/projects/agentproto/ts"
const CONTROLLER_AGENTS_MD_PATH = `${CONTROLLER_CWD}/AGENTS.md`
const CONTROLLER_AGENTS_MD_BLOCK =
  `--- AGENTS.md (${CONTROLLER_AGENTS_MD_PATH}) ---\ncontroller contract content\n--- end AGENTS.md ---`
const POINTER_PATH_TMP = "/controller/repo/AGENTS.md"

describe("isDeviceSandboxTarget (BOOTSTRAP P5 detector)", () => {
  it("classifies the device slug family and nothing else", () => {
    expect(isDeviceSandboxTarget("device:work-mac")).toBe(true)
    expect(isDeviceSandboxTarget("device:f0f0f1")).toBe(true)
    expect(isDeviceSandboxTarget({ provider: "device:work-mac" })).toBe(true)
    expect(isDeviceSandboxTarget(undefined)).toBe(false)
    expect(isDeviceSandboxTarget("e2b")).toBe(false)
    expect(isDeviceSandboxTarget("local")).toBe(false)
    expect(isDeviceSandboxTarget("box")).toBe(false)
    expect(isDeviceSandboxTarget("modal")).toBe(false)
    expect(isDeviceSandboxTarget("daytona")).toBe(false)
    expect(isDeviceSandboxTarget("operator:large")).toBe(false)
  })
})

describe("deviceContractLine", () => {
  it("names the device and never leaks a controller absolute path", () => {
    const line = deviceContractLine("work-mac")
    expect(line).toContain("work-mac")
    expect(line).not.toContain("/Volumes")
    expect(line).not.toContain("C:\\")
  })
})

describe("spawnAgentSession — device sandbox: controller workspace contracts suppressed", () => {
  let registry: SessionsRegistry
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agentproto-device-agentsmd-test-"))
    registry = createSessionsRegistry({ persist: false, transcriptDir: join(workspace, "transcripts") })
    startMock.mockClear()
    hostPromptMock.mockClear()
    wsConfigState.value = {
      version: 1,
      active: "controller-repo",
      workspaces: [
        {
          slug: "controller-repo",
          path: CONTROLLER_CWD,
          addedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }
  })

  afterEach(async () => {
    registry.shutdown()
    await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  /** Deps for a spawn whose controller-side stack WOULD resolve contract A.
   *  The stubs are wired to the OUTER registry so the afterEach's shutdown
   *  covers the session. */
  function makeDeps(overrides: Partial<SpawnAgentSessionDeps> = {}): SpawnAgentSessionDeps {
    return {
      registry,
      resolveAgentAdapter: async () => null,
      resolveSandboxProvider: async (slug: string) => {
        if (slug !== "device:win-host") return null
        return {
          provider: {
            async boot() {
              return {
                mcpUrl: "http://127.0.0.1:0/mcp",
                sandboxId: "sbx_fake_device_target",
                async stop() {},
              }
            },
          },
          slug: "device:win-host",
          name: "win-host",
          version: "builtin",
          description: "test double",
          requiresSetup: false,
          capabilities: { networkEgress: true, mounts: false, lifecyclePause: false, readOnly: false },
          omitCwdWhenImplicit: true,
          async check() {
            return true
          },
        }
      },
      loadDefaultsConfig: async () => undefined,
      // Controller contract A — inline, pointing at the CONTROLLER's status
      // path: exactly the shape that leaked in the field report.
      resolveAgentsMd: async () => ({
        mode: "inline",
        path: CONTROLLER_AGENTS_MD_PATH,
        content: "controller content",
        block: CONTROLLER_AGENTS_MD_BLOCK,
        contractLine: "CONTROLLER_CONTRACT_LINE",
      }),
      resolveWorkspaceRules: async () => ({
        path: join(workspace, "RULES.md"),
        block: "--- RULES.md ---\nrules content\n--- end RULES.md ---",
      }),
      loadRoleRegistry: async () => ({}),
      ...overrides,
    }
  }

  it("matrix 1 — controller contract A, remote cwd applies B: no pointer to A in the prompt the remote receives", async () => {
    const resolveAgentsMdSpy = vi.fn(async () => ({
      mode: "inline" as const,
      path: CONTROLLER_AGENTS_MD_PATH,
      content: "controller content",
      block: CONTROLLER_AGENTS_MD_BLOCK,
      contractLine: "CONTROLLER_CONTRACT_LINE",
    }))
    resolveAgentsMdSpy.mockClear()
    const deps = makeDeps({
      resolveAgentsMd: resolveAgentsMdSpy as never,
    })
    const sendPrompt = vi.spyOn(registry, "sendPrompt").mockResolvedValue(undefined)

    const result = await spawnAgentSession(deps, {
      adapter: "opencode-cli",
      cwd: CONTROLLER_CWD,
      prompt: "do the remote thing",
      sandbox: "device:win-host",
      wait: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")

    // The CONTROLLER resolver was never invoked — resolution is skipped,
    // not merely recomposed after the boot.
    expect(resolveAgentsMdSpy).not.toHaveBeenCalled()

    // The composed prompt applies the TARGET'S contract stance (the
    // device contract line) and carries nothing controller-local.
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    const prompt = sendPrompt.mock.calls[0]?.[1] as string
    expect(prompt).toContain("do the remote thing")
    expect(prompt).toContain('device "win-host"')
    expect(prompt).not.toContain("/Volumes")
    expect(prompt).not.toContain("AGENTS.md (")
    expect(prompt).not.toContain("controller content")
    expect(prompt).not.toContain("CONTROLLER_CONTRACT_LINE")
    expect(prompt).not.toContain("rules content")

    // Descriptor: suppressed resolution stamps "absent" with NO path.
    expect(result.descriptor.agentsMdMode).toBe("absent")
    expect(result.descriptor.agentsMd).toBeUndefined()
  })

  it("matrix 1b — end to end: the prompt actually forwarded to the device (host.prompt) is path-free", async () => {
    const resolveAgentsMdSpy = vi.fn(async () => ({
      mode: "inline" as const,
      path: CONTROLLER_AGENTS_MD_PATH,
      content: "controller content",
      block: CONTROLLER_AGENTS_MD_BLOCK,
      contractLine: "CONTROLLER_CONTRACT_LINE",
    }))
    resolveAgentsMdSpy.mockClear()
    const deps = makeDeps({ resolveAgentsMd: resolveAgentsMdSpy as never })

    const result = await spawnAgentSession(deps, {
      adapter: "opencode-cli",
      cwd: CONTROLLER_CWD,
      prompt: "do the remote thing",
      sandbox: "device:win-host",
      wait: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(resolveAgentsMdSpy).not.toHaveBeenCalled()
    expect(hostPromptMock).toHaveBeenCalledTimes(1)
    const crossed = String(hostPromptMock.mock.calls[0]?.[1] ?? "")
    expect(crossed).toContain("do the remote thing")
    expect(crossed).not.toContain("/Volumes")
    expect(crossed).not.toContain("controller content")
  })

  it("matrix 2 — target without an AGENTS.md: no contract, no error, prompt still delivered", async () => {
    const resolveAgentsMdSpy = vi.fn(async () => {
      throw new Error("resolver should not run on the controller side")
    })
    const deps = makeDeps({ resolveAgentsMd: resolveAgentsMdSpy as never })
    const result = await spawnAgentSession(deps, {
      adapter: "opencode-cli",
      cwd: "/somewhere/on/the/controller",
      prompt: "remote task",
      sandbox: "device:win-host",
      wait: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(resolveAgentsMdSpy).not.toHaveBeenCalled()
    expect(hostPromptMock).toHaveBeenCalledTimes(1)
    const crossed = String(hostPromptMock.mock.calls[0]?.[1] ?? "")
    expect(crossed).toContain("remote task")
    expect(result.descriptor.agentsMdMode).toBe("absent")
  })

  it("matrix 3 — Mac→Windows path shapes: no controller absolute path appears in the forwarded initial prompt", async () => {
    const deps = makeDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "opencode-cli",
      cwd: CONTROLLER_CWD,
      prompt: "run the windows task",
      sandbox: "device:win-host",
      wait: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    const crossed = String(hostPromptMock.mock.calls[0]?.[1] ?? "")
    expect(crossed).not.toContain("/Volumes/SSDExternalMacStudio")
    expect(crossed).not.toContain("C:\\Volumes")
    // The remote's OWN cwd is fine to appear — it does not.
    expect(crossed).not.toContain("C:\\Users\\win\\workspace")
  })

  it("matrix 4 — explicitly inherited controller content: promptAppend rides verbatim (transportable, distinct from workspace-local resolution)", async () => {
    const deps = makeDeps()
    const result = await spawnAgentSession(deps, {
      adapter: "opencode-cli",
      prompt: "the actual ask",
      promptAppend: "Explicit inherited instruction: follow repo conventions A/B/C.",
      sandbox: "device:win-host",
      wait: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    const crossed = String(hostPromptMock.mock.calls[0]?.[1] ?? "")
    expect(crossed).toContain("Explicit inherited instruction: follow repo conventions A/B/C.")
    expect(crossed).toContain("the actual ask")
  })

  it("matrix 5 — local (non-device) spawn unchanged: controller resolution composes as before, pointer grant included", async () => {
    const resolveLocal = vi.fn(async () => ({
      mode: "pointer" as const,
      path: POINTER_PATH_TMP,
      block: `This repo has an AGENTS.md at "${POINTER_PATH_TMP}" — read it first.`,
      contractLine: cdContractLine,
    }))
    const resolveWorkspaceRulesSpy = vi.fn(async () => ({}))
    const startSession = vi.fn(async (_opts?: { additionalReadPaths?: string[] }) => ({
      sessionId: "acp_local",
      async *send(): AsyncIterableIterator<unknown> {
        return
      },
      async cancel() {},
      async close() {},
    }))
    const localResolver: AgentAdapterResolver = async () =>
      ({ startSession: startSession as never, commandPreview: "mock" }) as never

    const result = await spawnAgentSession(
      makeDeps({
        resolveAgentAdapter: localResolver,
        resolveAgentsMd: resolveLocal as never,
        resolveWorkspaceRules: resolveWorkspaceRulesSpy as never,
        resolveSandboxProvider: undefined,
      }),
      // cwd OUTSIDE the pointer's repo — the read-grant path (the pointer
      // file is not covered by the session cwd).
      { adapter: "opencode-cli", cwd: "/somewhere-else/on/the/controller", prompt: "local ask" },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected success")
    expect(resolveLocal).toHaveBeenCalledTimes(1)
    expect(resolveWorkspaceRulesSpy).toHaveBeenCalledTimes(1)
    expect(result.descriptor.agentsMdMode).toBe("pointer")
    expect(result.descriptor.agentsMd).toBe(POINTER_PATH_TMP)
    expect(startSession.mock.calls[0]?.[0]?.additionalReadPaths).toContain(
      POINTER_PATH_TMP,
    )
  })

  it("the standing real resolver is untouched by the skip: a plain non-repo cwd still resolves 'absent'", async () => {
    const realRun = await resolveAgentsMd(join(workspace), 8, {
      exists: async () => false,
      read: async () => Buffer.from(""),
      gitToplevel: async () => undefined,
    })
    expect(realRun.mode).toBe("absent")
    expect(realRun.contractLine).toBe(cdContractLine)
  })
})
