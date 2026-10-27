/**
 * Overflow safety rails in the `auto` sandbox provider. Each rail must refuse
 * BEFORE the e2b call: residency, daily box/EUR caps, the secret allowlist,
 * template CLI-version parity, and the `maxEurPerBox` timeout ceiling. A
 * refusal is typed, records the choice, and never logs a secret name/value.
 */

import { describe, expect, it, vi } from "vitest"
import type {
  BootedSandbox,
  SandboxBootOpts,
  SandboxProvider,
  SandboxSpec,
  SandboxUsageWindow,
} from "@agentproto/sandbox"
import {
  DEFAULT_E2B_PRICING,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  DEFAULT_SIZE,
  DEFAULT_TEMPLATE,
  SIZES,
  TEMPLATES,
} from "@agentproto/sandbox-e2b"
import { ComputerSandboxError } from "@agentproto/sandbox-computer"

import type { SandboxProviderHandle } from "../sandbox-providers/types.js"
import {
  createAutoSandboxProviderHandle,
  SandboxOverflowRefusedError,
  templateIdForParity,
  type E2bLimitsModule,
} from "../sandbox-providers/auto.js"
import type { SandboxLedgerEntry } from "../sandbox-ledger.js"

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

const spec = (
  config: Record<string, unknown> = {},
  extra: Partial<SandboxSpec> = {},
): SandboxSpec => ({ provider: "auto", config, ...extra })

const capacityError = (): ComputerSandboxError =>
  new ComputerSandboxError("sandbox_capacity", "host capacity exhausted")

const window = (id: string, costEur: number | null): SandboxUsageWindow => ({
  computer: id,
  tenantId: "unknown",
  provider: "e2b",
  from: "2026-10-27T00:00:00.000Z",
  to: "2026-10-27T01:00:00.000Z",
  activeSec: 3600,
  vcpuSec: 4 * 3600,
  gibSec: 8 * 3600,
  costEur,
})

interface FakeLegs {
  computerBoot: ReturnType<typeof vi.fn>
  e2bBoot: ReturnType<typeof vi.fn>
  e2bConnect: ReturnType<typeof vi.fn>
  usage: ReturnType<typeof vi.fn>
  auto: SandboxProviderHandle
}

function fakeLegs(opts: {
  computer?: (input: SandboxSpec, bootOpts: SandboxBootOpts) => Promise<BootedSandbox>
  e2b?: (input: SandboxSpec, bootOpts: SandboxBootOpts) => Promise<BootedSandbox>
  e2bConnect?: (
    sandboxId: string,
    input: SandboxSpec,
    bootOpts: SandboxBootOpts,
  ) => Promise<BootedSandbox>
  usage?: (opts: { from: string; to: string; endUser?: string }) => Promise<SandboxUsageWindow[]>
  usageMissing?: boolean
  ledger?: readonly SandboxLedgerEntry[]
  env?: NodeJS.ProcessEnv
  now?: () => Date
  loadE2bLimits?: () => Promise<E2bLimitsModule>
} = {}): FakeLegs {
  const computerBoot = vi.fn(opts.computer ?? (async () => booted("sbx_computer_1")))
  const e2bBoot = vi.fn(opts.e2b ?? (async () => booted("sbx_e2b_1")))
  const e2bConnect = vi.fn(opts.e2bConnect ?? (async () => booted("sbx_e2b_1")))
  const usage = vi.fn(opts.usage ?? (async () => []))
  const e2bProvider: SandboxProvider = {
    boot: e2bBoot,
    connect: e2bConnect,
    ...(opts.usageMissing === true ? {} : { usage }),
  }
  const auto = createAutoSandboxProviderHandle({
    resolveProvider: async slug =>
      slug === "computer"
        ? handle("computer", { boot: computerBoot })
        : handle("e2b", e2bProvider),
    ledger: () => opts.ledger ?? [],
    ...(opts.env ? { env: opts.env } : { env: {} }),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.loadE2bLimits ? { loadE2bLimits: opts.loadE2bLimits } : {}),
  })
  return { computerBoot, e2bBoot, e2bConnect, usage, auto }
}

const overflowSpec = (overflow: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  spec({ overflow: { enabled: true, ...overflow }, ...extra })

const rejectsRefusal = async (
  promise: Promise<unknown>,
  reason: string,
): Promise<SandboxOverflowRefusedError> => {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(SandboxOverflowRefusedError)
    const refusal = err as SandboxOverflowRefusedError
    expect(refusal.code).toBe("sandbox_overflow_refused")
    expect(refusal.reason).toContain(reason)
    expect(refusal.choice).toMatchObject({ requested: "auto", provider: "computer" })
    expect(refusal.choice?.reason).toContain("overflow refused")
    expect(refusal.cause).toBeInstanceOf(ComputerSandboxError)
    return refusal
  }
  throw new Error("expected the overflow to be refused")
}

const rejectsConnectRefusal = async (
  promise: Promise<unknown>,
  reason: string,
): Promise<SandboxOverflowRefusedError> => {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(SandboxOverflowRefusedError)
    const refusal = err as SandboxOverflowRefusedError
    expect(refusal.code).toBe("sandbox_overflow_refused")
    expect(refusal.reason).toContain(reason)
    expect(refusal.choice).toMatchObject({
      requested: "auto",
      provider: "e2b",
      from: "ledger",
    })
    return refusal
  }
  throw new Error("expected the resume to be refused")
}

const e2bLedger = (sandboxId: string): SandboxLedgerEntry[] => [
  {
    sandboxId,
    provider: "e2b",
    state: "paused",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
]

/** Synthetic e2b metadata whose named DEFAULT_TEMPLATE and the large size
 *  template bake DIFFERENT CLI versions, to prove parity follows the image
 *  the provider actually boots. */
const divergingLimits = (): E2bLimitsModule => ({
  DEFAULT_SIZE,
  DEFAULT_TEMPLATE,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  SIZES,
  TEMPLATES: {
    ...TEMPLATES,
    stable: { ...TEMPLATES.stable, baked: { cli: "2.0.0" } },
  },
  resolveE2bPricing: () => DEFAULT_E2B_PRICING,
})

const capMsFor = (maxEurPerBox: number): number => {
  const size = SIZES.large
  const eurPerMs =
    ((size.cpuCount * DEFAULT_E2B_PRICING.usdPerVcpuHour +
      (size.memoryMb / 1024) * DEFAULT_E2B_PRICING.usdPerGibHour) *
      DEFAULT_E2B_PRICING.eurPerUsd) /
    3_600_000
  return Math.floor(maxEurPerBox / eurPerMs)
}

describe("auto sandbox overflow rails", () => {
  it("residency eu-ovh from the host policy never calls e2b", async () => {
    const legs = fakeLegs({
      computer: async () => Promise.reject(capacityError()),
      env: { AGENTPROTO_TENANT_RESIDENCY: "eu-ovh" },
    })

    await expect(
      legs.auto.provider.boot(overflowSpec({}), { env: {} }),
    ).rejects.toMatchObject({ code: "sandbox_capacity" })

    expect(legs.e2bBoot).not.toHaveBeenCalled()
  })

  it("refuses on the daily box cap before the e2b call", async () => {
    const legs = fakeLegs({
      computer: async () => Promise.reject(capacityError()),
      usage: async () => [window("sbx_e2b_existing", 0.1)],
    })

    await rejectsRefusal(
      legs.auto.provider.boot(overflowSpec({ maxBoxesPerDay: 1 }), { env: {} }),
      "daily box cap",
    )

    expect(legs.e2bBoot).not.toHaveBeenCalled()
  })

  it("refuses on the daily EUR cap before the e2b call", async () => {
    const legs = fakeLegs({
      computer: async () => Promise.reject(capacityError()),
      usage: async () => [window("sbx_e2b_existing", 2)],
    })

    await rejectsRefusal(
      legs.auto.provider.boot(overflowSpec({ maxEurPerDay: 1 }), { env: {} }),
      "daily EUR cap",
    )

    expect(legs.e2bBoot).not.toHaveBeenCalled()
  })

  it("fails closed when the e2b cost source is missing", async () => {
    const legs = fakeLegs({
      computer: async () => Promise.reject(capacityError()),
      usageMissing: true,
    })

    await rejectsRefusal(
      legs.auto.provider.boot(overflowSpec({}), { env: {} }),
      "cost source",
    )

    expect(legs.e2bBoot).not.toHaveBeenCalled()
  })

  it("fails closed when a usage window has unknown cost", async () => {
    const legs = fakeLegs({
      computer: async () => Promise.reject(capacityError()),
      usage: async () => [window("sbx_e2b_existing", null)],
    })

    await rejectsRefusal(
      legs.auto.provider.boot(overflowSpec({}), { env: {} }),
      "cost is unknown",
    )

    expect(legs.e2bBoot).not.toHaveBeenCalled()
  })

  it("fails closed on a malformed cap", async () => {
    const legs = fakeLegs({
      computer: async () => Promise.reject(capacityError()),
    })

    await rejectsRefusal(
      legs.auto.provider.boot(overflowSpec({ maxEurPerDay: 0 }), { env: {} }),
      "maxEurPerDay",
    )

    expect(legs.e2bBoot).not.toHaveBeenCalled()
  })

  it("refuses an e2b secret that is not on the allowlist", async () => {
    const legs = fakeLegs({
      computer: async () => Promise.reject(capacityError()),
    })
    const logs: string[] = []

    await rejectsRefusal(
      legs.auto.provider.boot(
        overflowSpec({
          allowSecrets: true,
          secretAllowlist: ["ALLOWED_API_KEY"],
        }),
        {
          env: { ALLOWED_API_KEY: "allowed-value", DENIED_API_KEY: "denied-value" },
          log: line => logs.push(line),
        },
      ),
      "not on the allowlist",
    )

    expect(legs.e2bBoot).not.toHaveBeenCalled()
    const joined = logs.join("\n")
    expect(joined).not.toContain("ALLOWED_API_KEY")
    expect(joined).not.toContain("DENIED_API_KEY")
    expect(joined).not.toContain("allowed-value")
    expect(joined).not.toContain("denied-value")
  })

  it("forwards only the allowlisted secret and never logs its name or value", async () => {
    const legs = fakeLegs({
      computer: async () => Promise.reject(capacityError()),
    })
    const logs: string[] = []

    await legs.auto.provider.boot(
      overflowSpec({
        allowSecrets: true,
        secretAllowlist: ["ALLOWED_API_KEY"],
      }),
      {
        env: { ALLOWED_API_KEY: "allowed-value" },
        log: line => logs.push(line),
      },
    )

    expect(legs.e2bBoot).toHaveBeenCalledTimes(1)
    expect(legs.e2bBoot.mock.calls[0]?.[1]?.env).toEqual({
      ALLOWED_API_KEY: "allowed-value",
    })
    const joined = logs.join("\n")
    expect(joined).not.toContain("ALLOWED_API_KEY")
    expect(joined).not.toContain("allowed-value")
  })

  it("denies secrets by default", async () => {
    const legs = fakeLegs({
      computer: async () => Promise.reject(capacityError()),
    })

    await rejectsRefusal(
      legs.auto.provider.boot(overflowSpec({}), {
        env: { ANTHROPIC_API_KEY: "brokered-value" },
      }),
      "secrets are not allowed",
    )

    expect(legs.e2bBoot).not.toHaveBeenCalled()
  })

  it("refuses when the e2b template bake does not match the CLI pin", async () => {
    const legs = fakeLegs({
      computer: async () => Promise.reject(capacityError()),
    })

    await rejectsRefusal(
      legs.auto.provider.boot(
        overflowSpec({}, { e2b: { cliVersion: "9.9.9" } }),
        { env: {} },
      ),
      "CLI version",
    )

    expect(legs.e2bBoot).not.toHaveBeenCalled()
  })

  it("allows overflow when the template bake matches the CLI pin", async () => {
    const legs = fakeLegs({
      computer: async () => Promise.reject(capacityError()),
    })

    const result = await legs.auto.provider.boot(
      overflowSpec({}, { e2b: { cliVersion: TEMPLATES.stable.baked.cli } }),
      { env: {} },
    )

    expect(result.provider).toBe("e2b")
    expect(legs.e2bBoot).toHaveBeenCalledTimes(1)
  })

  it("caps e2b timeoutMs with maxEurPerBox", async () => {
    const legs = fakeLegs({
      computer: async () => Promise.reject(capacityError()),
    })
    const size = SIZES.large
    const maxEurPerBox = 0.01
    const eurPerMs =
      ((size.cpuCount * DEFAULT_E2B_PRICING.usdPerVcpuHour +
        (size.memoryMb / 1024) * DEFAULT_E2B_PRICING.usdPerGibHour) *
        DEFAULT_E2B_PRICING.eurPerUsd) /
      3_600_000
    const expectedMaxMs = Math.floor(maxEurPerBox / eurPerMs)

    await legs.auto.provider.boot(
      overflowSpec({ maxEurPerBox }, { e2b: { timeoutMs: DEFAULT_SANDBOX_TIMEOUT_MS } }),
      { env: {} },
    )

    const passed = legs.e2bBoot.mock.calls[0]?.[0] as SandboxSpec
    const timeoutMs = (passed.config as { timeoutMs?: number }).timeoutMs
    expect(timeoutMs).toBe(expectedMaxMs)
    expect(timeoutMs).toBeLessThan(DEFAULT_SANDBOX_TIMEOUT_MS)
  })

  it("applies the secret allowlist on resume and refuses an unknown name", async () => {
    const legs = fakeLegs({
      ledger: e2bLedger("sbx_e2b_resume"),
    })

    await rejectsConnectRefusal(
      legs.auto.provider.connect!("sbx_e2b_resume", overflowSpec({
        allowSecrets: true,
        secretAllowlist: ["ALLOWED_API_KEY"],
      }), {
        env: { ALLOWED_API_KEY: "allowed-value", DENIED_API_KEY: "denied-value" },
      }),
      "not on the allowlist",
    )

    expect(legs.e2bConnect).not.toHaveBeenCalled()
  })

  it("passes only allowlisted secrets to the e2b resume", async () => {
    const legs = fakeLegs({
      ledger: e2bLedger("sbx_e2b_resume"),
    })

    await legs.auto.provider.connect!("sbx_e2b_resume", overflowSpec({
      allowSecrets: true,
      secretAllowlist: ["ALLOWED_API_KEY"],
    }), {
      env: { ALLOWED_API_KEY: "allowed-value" },
    })

    expect(legs.e2bConnect).toHaveBeenCalledTimes(1)
    expect(legs.e2bConnect.mock.calls[0]?.[2]?.env).toEqual({
      ALLOWED_API_KEY: "allowed-value",
    })
  })

  it("caps the cumulative lifetime across resume and extendTimeout re-arms", async () => {
    let clock = Date.parse("2026-10-27T12:00:00.000Z")
    const extend = vi.fn(async () => {})
    const resumedBox: BootedSandbox = {
      ...booted("sbx_e2b_resume"),
      lifetimeMs: 123,
      extendTimeout: extend,
    }
    const legs = fakeLegs({
      ledger: e2bLedger("sbx_e2b_resume"),
      e2bConnect: async () => resumedBox,
      now: () => new Date(clock),
    })
    const maxEurPerBox = 0.01
    const maxMs = capMsFor(maxEurPerBox)

    const resumed = await legs.auto.provider.connect!(
      "sbx_e2b_resume",
      overflowSpec({ maxEurPerBox }),
      { env: {} },
    )

    expect(resumed.lifetimeMs).toBe(maxMs)
    await resumed.extendTimeout!(maxMs)
    expect(extend).toHaveBeenCalledWith(maxMs)

    clock += maxMs + 1
    await expect(resumed.extendTimeout!(1000)).rejects.toBeInstanceOf(
      SandboxOverflowRefusedError,
    )
    expect(extend).toHaveBeenCalledTimes(1)
  })

  it("checks the DEFAULT_TEMPLATE the provider boots, not the size template", async () => {
    const legs = fakeLegs({
      computer: async () => Promise.reject(capacityError()),
      loadE2bLimits: async () => divergingLimits(),
    })

    await rejectsRefusal(
      legs.auto.provider.boot(
        overflowSpec({}, { computer: { cliVersion: SIZES.large.baked.cli } }),
        { env: {} },
      ),
      "CLI version",
    )

    expect(legs.e2bBoot).not.toHaveBeenCalled()
    expect(templateIdForParity({}, divergingLimits())).toBe(DEFAULT_TEMPLATE)
  })
})
