/**
 * F2 — single-dial device spawn.
 *
 * Field defect: `agent_start` over the device bridge was TWO concurrent
 * `forwardHttpStream` dials — the MCP `agent_start` call, then the initial
 * prompt POST (`agent_prompt`). On a flapping E2E channel the SECOND dial
 * failed at ~15s (`device_unreachable` / `transport closed during
 * handshake`), so the session was created on the host but its prompt was
 * never delivered ("sessions appear on Windows but never get talked to").
 *
 * Fix: for a `device:<fp>` spawn the controller-composed initial prompt is
 * carried INSIDE the inner `agent_start` (as a content block, so the target
 * sends it verbatim), and the sandbox proxy does NOT re-send it as a second
 * `agent_prompt` dial. Local / e2b / Box sandboxes keep the two-dial shape.
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

/** Text carried in `host.start`'s `prompt` block (F2). */
function carriedPromptText(call = 0): string {
  const args = startMock.mock.calls[call]?.[0] as Record<string, unknown> | undefined
  const prompt = args?.prompt
  const blocks = Array.isArray(prompt) ? prompt : [prompt]
  return blocks
    .filter((b): b is { text?: unknown } => typeof b === "object" && b !== null)
    .map(b => (typeof b.text === "string" ? b.text : ""))
    .join("\n")
}

describe("F2 — single-dial device spawn (prompt carried in agent_start)", () => {
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

  it("carries the prompt in the SPAWN dial and never makes a second prompt dial", async () => {
    const result = await spawnAgentSession(makeDeps(), {
      adapter: "opencode-cli",
      cwd: workspace,
      sandbox: "device:win-host",
      prompt: "do the single-dial thing",
      wait: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // The prompt rode the spawn dial, wrapped as a content block (verbatim
    // delivery on the target — no recomposition).
    const carried = carriedPromptText()
    expect(carried).toContain("do the single-dial thing")
    const args = startMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(Array.isArray(args.prompt)).toBe(true)
    expect(args.prompt).toMatchObject([{ type: "text" }])

    // …and the second `agent_prompt` dial was NOT made.
    expect(hostPromptMock).not.toHaveBeenCalled()
    // Only ONE device-bridge dial carried the spawn+prompt.
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
