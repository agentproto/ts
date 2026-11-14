/**
 * The `auto` sandbox provider: a composite that boots on `computer` first and
 * overflows to `e2b` ONLY for a body-coded capacity refusal, when overflow is
 * explicitly enabled. Resume/reuse always follows the sandbox ledger.
 *
 * The last test exercises the REAL spawn path (in-process gateway as the box)
 * so the descriptor + ledger assertions cover the wiring in `session-spawn.ts`,
 * not just this module's return value.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import {
  SandboxBootCancelledError,
  type BootedSandbox,
  type SandboxBootOpts,
  type SandboxProvider,
  type SandboxSpec,
} from "@agentproto/sandbox"
import { ComputerApiError, ComputerSandboxError } from "@agentproto/sandbox-computer"

import { createGateway, type GatewayHandle } from "../index.js"
import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
  type SessionsRegistry,
} from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"
import { createAutoSandboxProviderHandle } from "../sandbox-providers/auto.js"
import { resolveSandboxProvider } from "../sandbox-providers/registry.js"
import { readSandboxLedger, type SandboxLedgerEntry } from "../sandbox-ledger.js"

const booted = (sandboxId: string): BootedSandbox => ({
  mcpUrl: "http://127.0.0.1:1/mcp",
  sandboxId,
  stop: async () => {},
})

const handle = (slug: string, provider: SandboxProvider): SandboxProviderHandle => ({
  provider,
  slug,
  name: slug,
  version: "test",
  description: `${slug} test double`,
  requiresSetup: false,
  capabilities: {
    networkEgress: true,
    mounts: false,
    lifecyclePause: true,
    readOnly: false,
    exec: true,
  },
  async check() {
    return true
  },
})

const spec = (config: Record<string, unknown> = {}, extra: Partial<SandboxSpec> = {}): SandboxSpec => ({
  provider: "auto",
  config,
  ...extra,
})

interface FakeLegs {
  computerBoot: ReturnType<typeof vi.fn>
  computerConnect: ReturnType<typeof vi.fn>
  e2bBoot: ReturnType<typeof vi.fn>
  e2bConnect: ReturnType<typeof vi.fn>
  auto: SandboxProviderHandle
}

function fakeLegs(opts: {
  computer?: (input: SandboxSpec, bootOpts: SandboxBootOpts) => Promise<BootedSandbox>
  e2b?: (input: SandboxSpec, bootOpts: SandboxBootOpts) => Promise<BootedSandbox>
  ledger?: readonly SandboxLedgerEntry[]
} = {}): FakeLegs {
  const computerBoot = vi.fn(opts.computer ?? (async () => booted("sbx_computer_1")))
  const computerConnect = vi.fn(async () => booted("sbx_computer_1"))
  const e2bBoot = vi.fn(opts.e2b ?? (async () => booted("sbx_e2b_1")))
  const e2bConnect = vi.fn(async () => booted("sbx_e2b_1"))
  const auto = createAutoSandboxProviderHandle({
    resolveProvider: async slug =>
      slug === "computer"
        ? handle("computer", { boot: computerBoot, connect: computerConnect })
        : handle("e2b", {
            boot: e2bBoot,
            connect: e2bConnect,
            usage: async () => [],
          }),
    ledger: () => opts.ledger ?? [],
  })
  return { computerBoot, computerConnect, e2bBoot, e2bConnect, auto }
}

describe("auto sandbox provider — resolution", () => {
  it("resolves through the registry (main returns null)", async () => {
    const resolved = await resolveSandboxProvider("auto")
    expect(resolved).not.toBeNull()
    expect(resolved?.slug).toBe("auto")
  })

  it("reports not-ready when the computer leg is not installed", async () => {
    const auto = createAutoSandboxProviderHandle({
      resolveProvider: async slug =>
        slug === "computer" ? null : handle("e2b", { boot: async () => booted("sbx_e2b_1") }),
    })

    await expect(auto.check()).resolves.toBe(false)
  })
})

describe("auto sandbox provider — boot", () => {
  it("boots computer when there is capacity", async () => {
    const legs = fakeLegs()
    const result = await legs.auto.provider.boot(spec({ overflow: { enabled: true } }), { env: {} })

    expect(result.provider).toBe("computer")
    expect(result.choice).toMatchObject({ requested: "auto", provider: "computer" })
    expect(legs.computerBoot).toHaveBeenCalledTimes(1)
    expect(legs.e2bBoot).not.toHaveBeenCalled()
  })

  it("overflows to e2b exactly once on a body-coded host-capacity refusal", async () => {
    const err = new ComputerSandboxError("sandbox_capacity", "host capacity exhausted")
    const legs = fakeLegs({ computer: async () => Promise.reject(err) })

    const result = await legs.auto.provider.boot(spec({ overflow: { enabled: true } }), { env: {} })

    expect(result.provider).toBe("e2b")
    expect(result.sandboxId).toBe("sbx_e2b_1")
    expect(result.choice).toMatchObject({
      requested: "auto",
      provider: "e2b",
      from: "computer",
    })
    expect(result.choice?.reason).toContain("sandbox_capacity")
    expect(legs.computerBoot).toHaveBeenCalledTimes(1)
    expect(legs.e2bBoot).toHaveBeenCalledTimes(1)
  })

  it("turns off the computer leg's fleet-capacity wait when overflow is on, so it overflows at once", async () => {
    const legs = fakeLegs()
    await legs.auto.provider.boot(spec({ overflow: { enabled: true } }), { env: {} })
    expect(legs.computerBoot.mock.calls[0]?.[0].config).toMatchObject({ fleetCapacityWaitMs: 0 })
  })

  it("keeps the computer leg's fleet-capacity wait when overflow is off or the wait is set", async () => {
    const off = fakeLegs()
    await off.auto.provider.boot(spec(), { env: {} })
    expect(off.computerBoot.mock.calls[0]?.[0].config).not.toHaveProperty("fleetCapacityWaitMs")

    const explicit = fakeLegs()
    await explicit.auto.provider.boot(
      spec({ overflow: { enabled: true }, computer: { fleetCapacityWaitMs: 60_000 } }),
      { env: {} },
    )
    expect(explicit.computerBoot.mock.calls[0]?.[0].config).toMatchObject({ fleetCapacityWaitMs: 60_000 })
  })

  it("returns the capacity error unchanged when overflow is off (the default)", async () => {
    const err = new ComputerSandboxError("sandbox_capacity", "host capacity exhausted")
    const legs = fakeLegs({ computer: async () => Promise.reject(err) })

    await expect(legs.auto.provider.boot(spec(), { env: {} })).rejects.toBe(err)

    expect(legs.computerBoot).toHaveBeenCalledTimes(1)
    expect(legs.e2bBoot).not.toHaveBeenCalled()
  })

  it.each([
    ["403", new ComputerApiError(403, "forbidden")],
    ["400", new ComputerApiError(400, "bad request")],
    ["boot timeout", new ComputerSandboxError("sandbox_boot_timeout", "timed out")],
    ["transport", new Error("fetch failed")],
  ])("never overflows on a %s failure", async (_label, err) => {
    const legs = fakeLegs({ computer: async () => Promise.reject(err) })

    await expect(
      legs.auto.provider.boot(spec({ overflow: { enabled: true } }), { env: {} }),
    ).rejects.toBe(err)

    expect(legs.e2bBoot).not.toHaveBeenCalled()
  })

  it("pins to computer for residency/egress constraints and never overflows", async () => {
    const err = new ComputerSandboxError("sandbox_capacity", "host capacity exhausted")
    const legs = fakeLegs({ computer: async () => Promise.reject(err) })

    await expect(
      legs.auto.provider.boot(spec({ residency: "eu-ovh", overflow: { enabled: true } }), { env: {} }),
    ).rejects.toBe(err)

    expect(legs.e2bBoot).not.toHaveBeenCalled()
  })

  it("fails safe: any other residency value pins to computer, never overflows", async () => {
    const err = new ComputerSandboxError("sandbox_capacity", "host capacity exhausted")
    const legs = fakeLegs({ computer: async () => Promise.reject(err) })

    await expect(
      legs.auto.provider.boot(spec({ residency: "us-east", overflow: { enabled: true } }), { env: {} }),
    ).rejects.toBe(err)

    expect(legs.e2bBoot).not.toHaveBeenCalled()
  })

  it("tags a cancelled computer boot with the concrete provider for the ledger", async () => {
    const cancel = new SandboxBootCancelledError("cancelled", "sbx_cancelled")
    const legs = fakeLegs({ computer: async () => Promise.reject(cancel) })

    await expect(legs.auto.provider.boot(spec(), { env: {} })).rejects.toMatchObject({
      sandboxId: "sbx_cancelled",
      provider: "computer",
    })

    expect(legs.e2bBoot).not.toHaveBeenCalled()
  })

  it("returns the e2b error with the computer error attached, never retrying computer", async () => {
    const computerErr = new ComputerSandboxError("sandbox_capacity", "host capacity exhausted")
    const e2bErr = new Error("e2b create failed")
    const legs = fakeLegs({
      computer: async () => Promise.reject(computerErr),
      e2b: async () => Promise.reject(e2bErr),
    })

    await expect(
      legs.auto.provider.boot(spec({ overflow: { enabled: true } }), { env: {} }),
    ).rejects.toMatchObject({ computerError: computerErr, cause: computerErr })

    expect(legs.computerBoot).toHaveBeenCalledTimes(1)
    expect(legs.e2bBoot).toHaveBeenCalledTimes(1)
  })

  it("forwards the allowlisted broker-resolved env to the overflow leg", async () => {
    const computerErr = new ComputerSandboxError("sandbox_capacity", "host capacity exhausted")
    const legs = fakeLegs({
      computer: async () => Promise.reject(computerErr),
      e2b: async () => booted("sbx_e2b_1"),
    })
    const env = { ANTHROPIC_API_KEY: "brokered-value" }

    await legs.auto.provider.boot(
      spec({
        overflow: {
          enabled: true,
          allowSecrets: true,
          secretAllowlist: ["ANTHROPIC_API_KEY"],
        },
      }),
      { env },
    )

    expect(legs.e2bBoot).toHaveBeenCalledTimes(1)
    expect(legs.e2bBoot.mock.calls[0]?.[1]).toMatchObject({ env })
  })
})

describe("auto sandbox provider — resume", () => {
  it("delegates to the ledger's provider and never overflows to e2b", async () => {
    const legs = fakeLegs({
      ledger: [
        {
          sandboxId: "sbx_resume_1",
          provider: "computer",
          state: "paused",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    })

    const resumed = await legs.auto.provider.connect?.("sbx_resume_1", spec(), { env: {} })

    expect(resumed?.provider).toBe("computer")
    expect(resumed?.choice).toMatchObject({ requested: "auto", provider: "computer", from: "ledger" })
    expect(legs.computerConnect).toHaveBeenCalledTimes(1)
    expect(legs.e2bConnect).not.toHaveBeenCalled()
    expect(legs.e2bBoot).not.toHaveBeenCalled()
  })

  it("does not overflow when the ledger provider refuses on resume", async () => {
    const capacity = new ComputerSandboxError("sandbox_capacity", "host capacity exhausted")
    const legs = fakeLegs({
      ledger: [
        {
          sandboxId: "sbx_resume_2",
          provider: "computer",
          state: "paused",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    })
    legs.computerConnect.mockRejectedValueOnce(capacity)

    await expect(
      legs.auto.provider.connect?.("sbx_resume_2", spec({ overflow: { enabled: true } }), { env: {} }),
    ).rejects.toBe(capacity)

    expect(legs.e2bConnect).not.toHaveBeenCalled()
    expect(legs.e2bBoot).not.toHaveBeenCalled()
  })
})

/* ─── descriptor + ledger integration through the real spawn path ─────────── */

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

const fakeCliResolver: AgentAdapterResolver = async slug => {
  if (slug !== "fake-cli") return null
  return {
    commandPreview: "fake-cli (test double)",
    async startSession(): Promise<AgentSessionLike> {
      return {
        sessionId: "remote_sess_auto",
        async *send(): AsyncIterable<AgentStreamEvent> {
          yield { kind: "turn-end", reason: "completed" }
        },
        async cancel() {},
        async close() {},
      }
    },
  }
}

describe("auto sandbox provider — descriptor and ledger", () => {
  let gateway: GatewayHandle | undefined
  let workspace: string
  let registry: SessionsRegistry
  let ledgerPath: string
  let savedLedger: string | undefined

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agentproto-auto-host-"))
    ledgerPath = join(workspace, "sandboxes.json")
    savedLedger = process.env.AGENTPROTO_SANDBOX_LEDGER
    process.env.AGENTPROTO_SANDBOX_LEDGER = ledgerPath
    registry = createSessionsRegistry({
      persist: false,
      transcriptDir: join(workspace, "transcripts"),
    })
  })

  afterEach(async () => {
    registry.shutdown()
    await gateway?.stop()
    gateway = undefined
    if (savedLedger === undefined) delete process.env.AGENTPROTO_SANDBOX_LEDGER
    else process.env.AGENTPROTO_SANDBOX_LEDGER = savedLedger
    await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  it("stamps the ACTUAL provider and the choice reason on the descriptor and ledger", async () => {
    const boxWorkspace = await mkdtemp(join(tmpdir(), "agentproto-auto-box-"))
    gateway = await createGateway({
      workspace: boxWorkspace,
      specs: [],
      port: await freePort(),
      boot: false,
      persist: false,
      persistPath: join(boxWorkspace, "sessions.json"),
      resolveAgentAdapter: fakeCliResolver,
    })

    const computerErr = new ComputerSandboxError("sandbox_capacity", "host capacity exhausted")
    const e2b = handle("e2b", {
      async boot() {
        return {
          mcpUrl: `${gateway!.url}/mcp`,
          sandboxId: "sbx_auto_e2b",
          stop: async () => {},
        }
      },
      usage: async () => [],
    })
    const computer = handle("computer", {
      async boot() {
        throw computerErr
      },
    })
    const auto = createAutoSandboxProviderHandle({
      resolveProvider: async slug => (slug === "computer" ? computer : e2b),
    })

    const deps: SpawnAgentSessionDeps = {
      registry,
      resolveAgentAdapter: vi.fn(async () => null),
      resolveSandboxProvider: vi.fn(async slug => (slug === "auto" ? auto : null)),
      loadDefaultsConfig: async () => undefined,
      loadRoleRegistry: async () => ({}),
    }

    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: workspace,
      sandbox: { provider: "auto", config: { overflow: { enabled: true } } },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.descriptor.sandboxProvider).toBe("e2b")
    expect(result.descriptor.sandboxProviderChoice).toMatchObject({
      requested: "auto",
      provider: "e2b",
      from: "computer",
    })
    expect(result.descriptor.sandboxProviderChoice?.reason).toContain("sandbox_capacity")

    const row = readSandboxLedger().find(entry => entry.sandboxId === "sbx_auto_e2b")
    expect(row?.provider).toBe("e2b")
    await rm(boxWorkspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  it("records the ACTUAL provider on a failed boot after the box was created", async () => {
    const deadPort = await freePort()
    const computerErr = new ComputerSandboxError("sandbox_capacity", "host capacity exhausted")
    const e2b = handle("e2b", {
      async boot() {
        return {
          mcpUrl: `http://127.0.0.1:${deadPort}/mcp`,
          sandboxId: "sbx_auto_failed",
          stop: async () => {},
        }
      },
      usage: async () => [],
    })
    const computer = handle("computer", {
      async boot() {
        throw computerErr
      },
    })
    const auto = createAutoSandboxProviderHandle({
      resolveProvider: async slug => (slug === "computer" ? computer : e2b),
    })

    const deps: SpawnAgentSessionDeps = {
      registry,
      resolveAgentAdapter: vi.fn(async () => null),
      resolveSandboxProvider: vi.fn(async slug => (slug === "auto" ? auto : null)),
      loadDefaultsConfig: async () => undefined,
      loadRoleRegistry: async () => ({}),
    }

    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: workspace,
      sandbox: { provider: "auto", config: { overflow: { enabled: true } } },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("sandbox_boot_failed")

    const row = readSandboxLedger().find(entry => entry.sandboxId === "sbx_auto_failed")
    expect(row?.provider).toBe("e2b")
  })
})
