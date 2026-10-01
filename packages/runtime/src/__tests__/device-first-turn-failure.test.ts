/**
 * Device-spawn first-turn failure surfacing (device-spawn UX fix 2).
 *
 * Field finding: a `device:<fp>` spawn with a model id that does not resolve
 * on the host lands, the adapter starts, and the FIRST turn completes EMPTY —
 * no assistant output, no structured error. The controller saw a
 * healthy-looking `running` session with `lastTurnEmpty: true`, while the
 * adapter's own "model not found"/"[warning] empty turn" line sat only in the
 * HOST's ring buffer and never crossed the E2E boundary.
 *
 * This exercises the whole controller path (spawn → proxy → runAgentTurn):
 * the proxy surfaces the host line as a `notice`, `projectEvent` renders it
 * into the controller ring (`agent_output`), and the descriptor is stamped
 * `firstTurnFailed: true`. A non-device sandbox is unaffected.
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

const HOST_ERROR_LINE =
  "\x1b[33m[warning] empty turn — no assistant output, no tool call. " +
  "Likely an invalid model id or a provider that returned nothing.\x1b[0m"

const hostOutputMock = vi.hoisted(() => vi.fn(async () => ""))
const startMock = vi.hoisted(() =>
  vi.fn(async (_args: Record<string, unknown>) => ({ id: "remote_sess_1", cwd: "/remote" })),
)
vi.mock("@agentproto/sandbox", async importOriginal => {
  const actual = await importOriginal<typeof import("@agentproto/sandbox")>()
  return {
    ...actual,
    createSandboxAgentSessionHost: vi.fn(async () => ({
      mcpUrl: "http://127.0.0.1:0/mcp",
      sandboxId: "sbx_fake_device_target",
      start: startMock,
      prompt: vi.fn(async () => {}),
      output: hostOutputMock,
      kill: vi.fn(async () => {}),
      waitForAny: vi.fn(async () => ({ event: "any" as const, timedOut: false })),
      currentEventsCursor: vi.fn(async () => 0),
      stop: vi.fn(async () => {}),
    })),
  }
})

import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"

/** Minimal SSE `Response` for `GET /sessions/:id/events/stream`. */
function emptyTurnSse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      controller.enqueue(enc.encode(": connected\n\n"))
      controller.enqueue(
        enc.encode(
          `data: ${JSON.stringify({
            seq: 1,
            ts: "t",
            kind: "user-prompt",
            sessionId: "remote_sess_1",
            text: "go",
          })}\n\n`,
        ),
      )
      controller.enqueue(
        enc.encode(
          `data: ${JSON.stringify({
            seq: 2,
            ts: "t",
            kind: "turn-end",
            sessionId: "remote_sess_1",
            reason: "completed",
          })}\n\n`,
        ),
      )
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

describe("device spawn — first-turn failure surfacing", () => {
  let registry: SessionsRegistry
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agentproto-device-firstturn-test-"))
    registry = createSessionsRegistry({ persist: false, transcriptDir: join(workspace, "transcripts") })
    startMock.mockClear()
    hostOutputMock.mockReset()
    hostOutputMock.mockResolvedValue(HOST_ERROR_LINE)
    vi.stubGlobal("fetch", vi.fn(async () => emptyTurnSse()))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
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

  it("marks the descriptor firstTurnFailed and renders the host error line into agent_output", async () => {
    const result = await spawnAgentSession(makeDeps(), {
      adapter: "pi",
      cwd: workspace,
      sandbox: "device:win-host",
      model: "lmstudio/ternary-bonsai-2-27b",
      prompt: "go",
      wait: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const id = result.descriptor.id

    const desc = registry.get(id)
    expect(desc?.remote).toBe(true)
    expect(desc?.sandboxProvider).toBe("device:win-host")
    expect(desc?.lastTurnEmpty).toBe(true)
    expect(desc?.firstTurnFailed).toBe(true)

    const lines: string[] = []
    const unsub = registry.attach(id, line => lines.push(line))
    unsub?.()
    expect(lines.some(l => l.includes("[notice]"))).toBe(true)
    expect(lines.some(l => l.includes("Likely an invalid model id"))).toBe(true)
  })

  it("does NOT stamp firstTurnFailed for a non-device sandbox (local/e2b/Box unchanged)", async () => {
    const result = await spawnAgentSession(makeDeps(), {
      adapter: "pi",
      cwd: workspace,
      sandbox: "fake",
      prompt: "go",
      wait: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const desc = registry.get(result.descriptor.id)
    expect(desc?.lastTurnEmpty).toBe(true)
    expect(desc?.firstTurnFailed).toBeUndefined()
    // The host line is not harvested for a non-device box.
    expect(hostOutputMock).not.toHaveBeenCalled()
  })
})
