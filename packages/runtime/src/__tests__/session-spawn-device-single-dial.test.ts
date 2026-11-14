/**
 * Box spawn returns before the first turn.
 *
 * Field defect (2026-10-29): the initial prompt rode the box's `agent_start`,
 * so a cold box that installs an adapter before answering held the spawn dial
 * open past the request timeout (`MCP error -32001: Request timed out`) and
 * the box was torn down. The fix is to spawn WITHOUT the prompt, then deliver
 * it over the box's `agent_prompt`, which is exactly what worked by hand.
 *
 * `@agentproto/sandbox`'s `createSandboxAgentSessionHost` is mocked (same
 * seam the other device tests use) so both remote-facing dials are counted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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
  vi.fn(async (_args: Record<string, unknown>) => ({ id: "remote_sess_1", cwd: "/remote" })),
)
const hostPromptMock = vi.hoisted(() => vi.fn(async (_id: string, _prompt: unknown) => {}))
vi.mock("@agentproto/sandbox", async importOriginal => {
  const actual = await importOriginal<typeof import("@agentproto/sandbox")>()
  return {
    ...actual,
    createSandboxAgentSessionHost: vi.fn(async () => ({
      mcpUrl: "http://127.0.0.1:0/mcp",
      sandboxId: "sbx_fake_device_target",
      start: startMock,
      prompt: hostPromptMock,
      interrupt: vi.fn(async () => ({ wasBusy: false })),
      output: vi.fn(async () => ""),
      kill: vi.fn(async () => {}),
      waitForAny: vi.fn(async () => ({ event: "any" as const, timedOut: false })),
      currentEventsCursor: vi.fn(async () => 0),
      stop: vi.fn(async () => {}),
    })),
  }
})

import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"

describe("box spawn returns as soon as the session exists", () => {
  let registry: SessionsRegistry
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agentproto-device-single-dial-test-"))
    registry = createSessionsRegistry({ persist: false, transcriptDir: join(workspace, "transcripts") })
    startMock.mockClear()
    hostPromptMock.mockClear()
  })

  afterEach(async () => {
    registry.shutdown()
    await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  function makeDeps(): SpawnAgentSessionDeps {
    const makeHandle = (slug: string) => ({
      provider: {
        async boot() {
          return { mcpUrl: "http://127.0.0.1:0/mcp", sandboxId: "sbx_fake", async stop() {} }
        },
      },
      slug,
      name: slug,
      version: "builtin",
      description: "test double",
      requiresSetup: false,
      capabilities: { networkEgress: true, mounts: false, lifecyclePause: false, readOnly: false },
      omitCwdWhenImplicit: true,
      async check() {
        return true
      },
    })
    return {
      registry,
      resolveAgentAdapter: async () => null,
      resolveSandboxProvider: async (slug: string) =>
        slug === "device:win-host" || slug === "fake" ? (makeHandle(slug) as never) : null,
      loadDefaultsConfig: async () => undefined,
      loadRoleRegistry: async () => ({}),
    }
  }

  it("spawns the device session WITHOUT the prompt, then delivers it over the box's agent_prompt", async () => {
    const result = await spawnAgentSession(makeDeps(), {
      adapter: "opencode-cli",
      cwd: workspace,
      sandbox: "device:win-host",
      prompt: "do the two-dial thing",
      wait: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // The spawn dial carries no prompt, so a cold box's install/first-session
    // work cannot hold it past the request timeout.
    const args = startMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(args.prompt).toBeUndefined()

    // The prompt is delivered separately, exactly like the hand-worked case.
    expect(hostPromptMock).toHaveBeenCalledTimes(1)
    expect(String(hostPromptMock.mock.calls[0]?.[1] ?? "")).toContain("do the two-dial thing")
    expect(startMock).toHaveBeenCalledTimes(1)
  })

  it("a NON-device sandbox keeps the two-dial shape (spawn without prompt, then agent_prompt)", async () => {
    const result = await spawnAgentSession(makeDeps(), {
      adapter: "opencode-cli",
      cwd: workspace,
      sandbox: "fake",
      prompt: "keep two dials",
      wait: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const args = startMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(args.prompt).toBeUndefined()
    expect(hostPromptMock).toHaveBeenCalledTimes(1)
    expect(String(hostPromptMock.mock.calls[0]?.[1] ?? "")).toContain("keep two dials")
  })

  it("tears the adopted session down when the follow-up prompt dial throws", async () => {
    vi.spyOn(registry, "sendPrompt").mockRejectedValueOnce(new Error("device_unreachable"))

    const result = await spawnAgentSession(makeDeps(), {
      adapter: "opencode-cli",
      cwd: workspace,
      sandbox: "device:win-host",
      prompt: "deliver this",
      wait: true,
    })

    expect(result.ok).toBe(false)
    // The failed second dial must not leave a live-looking row behind.
    expect(
      registry.list().filter(s => s.status === "running" || s.status === "starting"),
    ).toHaveLength(0)
  })

  it("a device spawn with NO prompt makes neither a carried prompt nor a prompt dial", async () => {
    const result = await spawnAgentSession(makeDeps(), {
      adapter: "opencode-cli",
      cwd: workspace,
      sandbox: "device:win-host",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const args = startMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(args.prompt).toBeUndefined()
    expect(hostPromptMock).not.toHaveBeenCalled()
  })
})
