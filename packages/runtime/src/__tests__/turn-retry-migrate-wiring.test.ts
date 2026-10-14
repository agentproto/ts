/**
 * `createGateway` must wire PR 2's in-process migration orchestration
 * (`migrateSandboxSession`) into the turn-retry controller. Without that
 * wiring every `turnRetry.action: "migrate"` decision falls back to a
 * same-box retry with "no migration orchestrator is configured" — the
 * feature is inert in production while the unit tests (which inject their
 * own `migrateSession`) stay green.
 *
 * This is the real daemon path, as close to production as a unit test gets:
 * the gateway builds the controller itself, a REAL failing turn runs through
 * the REAL registry (fake adapter agent yields a 429 turn-end), and only the
 * box-boot half (`migrateSandboxSession`) is mocked — asserting the wiring
 * delivers the failing session to the orchestration.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"

vi.mock("../session-migrate.js", async importOriginal => {
  const mod = await importOriginal<typeof import("../session-migrate.js")>()
  return { ...mod, migrateSandboxSession: vi.fn() }
})

import { createGateway, type GatewayHandle } from "../index.js"
import { migrateSandboxSession } from "../session-migrate.js"
import { resolveTurnRetryPolicy } from "../turn-retry-policy.js"
import type { AgentSessionLike, SessionDescriptor } from "../sessions.js"
import type { MigrateSandboxSessionResult } from "../session-migrate.js"

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

/** First turn fails with a rate limit; the continuation prompt (never sent —
 *  the migration mock lands the session on a fake id) would be turn two. */
const rateLimitedAgent = (): AgentSessionLike => ({
  sessionId: "fake-box-agent",
  async *send() {
    yield { kind: "error", error: { message: "429 status code" } } as never
    yield { kind: "turn-end", reason: "error" } as never
  },
  async cancel() {},
  async close() {},
})

describe("createGateway — turnRetry.action migrate is wired to the orchestration", () => {
  const dirs: string[] = []
  const gateways: GatewayHandle[] = []
  let prevHome: string | undefined

  beforeEach(async () => {
    prevHome = process.env.HOME
    const home = await mkdtemp(join(tmpdir(), "agentproto-tr-migrate-home-"))
    dirs.push(home)
    process.env.HOME = home
    vi.mocked(migrateSandboxSession).mockReset()
  })

  afterEach(async () => {
    for (const gw of gateways.splice(0)) await gw.stop().catch(() => {})
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  it("a rate-limited turn on a sandbox session reaches migrateSandboxSession", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agentproto-tr-migrate-ws-"))
    dirs.push(workspace)
    const gateway = await createGateway({
      workspace,
      specs: [],
      port: await freePort(),
      boot: false,
      persist: false,
      // The same gate the `session_migrate` tool uses: with no adapter
      // resolver no migration can ever boot a replacement box, so the
      // controller's `migrateSession` arm stays unwired. The daemon always
      // injects one (serve.ts), which is what makes this production wiring.
      resolveAgentAdapter: async () => null,
    })
    gateways.push(gateway)

    const migrated: SessionDescriptor = {
      id: "s_migrated",
      kind: "agent-cli",
      status: "running",
      remote: true,
    } as SessionDescriptor
    vi.mocked(migrateSandboxSession).mockResolvedValue({
      ok: true,
      descriptor: migrated,
      migratedFrom: "?",
      checkpoint: {} as MigrateSandboxSessionResult["checkpoint"],
      restore: { source: "live", snapshot: "any", branch: "wt/x", record: {} as never },
      oldSessionKilled: true,
    })

    const desc = gateway.sessions.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: rateLimitedAgent(),
      adapterSlug: "fake-cli",
      remote: true,
      turnRetry: resolveTurnRetryPolicy({
        on: ["rate-limit"],
        action: "migrate",
        maxMigrations: 2,
        baseDelayMs: 0,
        factor: 1,
        maxDelayMs: 0,
      }),
    })

    await gateway.sessions.enqueuePrompt(desc.id, "start the task")

    await vi.waitFor(() => expect(vi.mocked(migrateSandboxSession)).toHaveBeenCalled(), { timeout: 3000 })
    const call = vi.mocked(migrateSandboxSession).mock.calls[0]!
    const [deps, prev] = call
    expect(prev.id).toBe(desc.id)
    // The daemon's real spawn deps, not a stub: the registry itself and a
    // resolvable adapter (without it `migrateSandboxSession` can never boot
    // the replacement box).
    expect((deps as { registry: unknown }).registry).toBe(gateway.sessions)
    expect(typeof (deps as { resolveAgentAdapter: unknown }).resolveAgentAdapter).toBe("function")
    // The migration was booked against the row before it ran.
    expect(gateway.sessions.get(desc.id)?.turnMigrations).toBe(1)
  }, 15_000)
})
