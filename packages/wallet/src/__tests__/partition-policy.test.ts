import { describe, it, expect } from "vitest"
import {
  evaluatePolicy,
  resolveTime,
  type PartitionPolicy,
  type PolicyContext,
} from "../partition-policy.js"
import {
  spendableLotUnderPolicy,
  spendableBalanceUnderPolicy,
  type Lot,
  type PolicyResolver,
} from "../fold.js"
import { defineAsset } from "../define-asset.js"
import { verifyNoArbitrage } from "../convert.js"
import { UNRESTRICTED } from "../restriction-lattice.js"

const DAY = 86_400_000
const GRANT = 1_000_000_000_000 // arbitrary fixed epoch ms anchor

function ctx(p: Partial<PolicyContext> = {}): PolicyContext {
  return {
    now: GRANT,
    grantedAt: GRANT,
    remaining: 1000,
    ...p,
  }
}

describe("evaluatePolicy — per-kind effects", () => {
  it("spendOn gates by category, passes a bare balance read", () => {
    const policy: PartitionPolicy = [{ kind: "spendOn", categories: ["image"] }]
    expect(evaluatePolicy(policy, ctx()).eligible).toBe(true) // no category
    expect(evaluatePolicy(policy, ctx({ category: "image" })).eligible).toBe(true)
    expect(evaluatePolicy(policy, ctx({ category: "text" })).eligible).toBe(false)
  })

  it("expire is a hard cliff: full before, zero + ineligible after", () => {
    const policy: PartitionPolicy = [
      { kind: "expire", at: { kind: "afterGrant", ms: 21 * DAY } },
    ]
    const before = evaluatePolicy(policy, ctx({ now: GRANT + 20 * DAY }))
    expect(before.spendable).toBe(1000)
    expect(before.eligible).toBe(true)
    expect(before.nextTransitionAt).toBe(GRANT + 21 * DAY)

    const after = evaluatePolicy(policy, ctx({ now: GRANT + 22 * DAY }))
    expect(after.spendable).toBe(0)
    expect(after.eligible).toBe(false)
  })

  it("linear decay writes the spendable down over time, projects its zero", () => {
    const policy: PartitionPolicy = [
      { kind: "decay", curve: "linear", ratePerDay: 0.1 }, // -10%/day → 0 at day 10
    ]
    expect(evaluatePolicy(policy, ctx({ now: GRANT })).spendable).toBe(1000)
    expect(evaluatePolicy(policy, ctx({ now: GRANT + 5 * DAY })).spendable).toBe(500)
    expect(evaluatePolicy(policy, ctx({ now: GRANT + 10 * DAY })).spendable).toBe(0)
    expect(evaluatePolicy(policy, ctx({ now: GRANT + 20 * DAY })).spendable).toBe(0)
    expect(
      evaluatePolicy(policy, ctx({ now: GRANT })).nextTransitionAt,
    ).toBe(GRANT + 10 * DAY)
  })

  it("exponential decay is asymptotic — never a hard zero", () => {
    const policy: PartitionPolicy = [
      { kind: "decay", curve: "exponential", ratePerDay: 0.5 }, // halves daily
    ]
    expect(evaluatePolicy(policy, ctx({ now: GRANT + 1 * DAY })).spendable).toBe(500)
    expect(evaluatePolicy(policy, ctx({ now: GRANT + 2 * DAY })).spendable).toBe(250)
    expect(
      evaluatePolicy(policy, ctx({ now: GRANT + 1 * DAY })).nextTransitionAt,
    ).toBeUndefined()
  })

  it("vest unlocks linearly after a cliff", () => {
    const policy: PartitionPolicy = [
      {
        kind: "vest",
        cliff: { kind: "afterGrant", ms: 10 * DAY },
        durationMs: 10 * DAY,
      },
    ]
    expect(evaluatePolicy(policy, ctx({ now: GRANT + 5 * DAY })).spendable).toBe(0) // pre-cliff
    expect(evaluatePolicy(policy, ctx({ now: GRANT + 15 * DAY })).spendable).toBe(500) // half
    expect(evaluatePolicy(policy, ctx({ now: GRANT + 25 * DAY })).spendable).toBe(1000) // full
  })

  it("transfer:soulbound blocks a counterparty move, allows a spend", () => {
    const policy: PartitionPolicy = [{ kind: "transfer", scope: "soulbound" }]
    expect(evaluatePolicy(policy, ctx()).eligible).toBe(true) // spend (no counterparty)
    expect(
      evaluatePolicy(policy, ctx({ counterparty: "acct-2" })).eligible,
    ).toBe(false)
  })

  it("restrict stamps canonical lattice tags", () => {
    const policy: PartitionPolicy = [{ kind: "restrict", tags: ["promo", "image"] }]
    expect(evaluatePolicy(policy, ctx()).restriction).toEqual(["image", "promo"])
  })
})

describe("evaluatePolicy — composition", () => {
  it("decay × expire compose; eligibility is AND; transition is earliest", () => {
    const policy: PartitionPolicy = [
      { kind: "decay", curve: "linear", ratePerDay: 0.05 }, // zero at day 20
      { kind: "expire", at: { kind: "afterGrant", ms: 8 * DAY } },
      { kind: "spendOn", categories: ["image"] },
    ]
    const at4d = evaluatePolicy(policy, ctx({ now: GRANT + 4 * DAY, category: "image" }))
    expect(at4d.spendable).toBe(800) // 1000 × (1 − 0.05×4)
    expect(at4d.eligible).toBe(true)
    // earliest self-change is the expire cliff (day 8), not the decay zero (day 20)
    expect(at4d.nextTransitionAt).toBe(GRANT + 8 * DAY)

    // after the cliff: expire forces 0 even though decay alone would leave value
    const at10d = evaluatePolicy(policy, ctx({ now: GRANT + 10 * DAY, category: "image" }))
    expect(at10d.spendable).toBe(0)
    expect(at10d.eligible).toBe(false)

    // wrong category fails the AND regardless of amount
    expect(
      evaluatePolicy(policy, ctx({ now: GRANT + 4 * DAY, category: "text" })).eligible,
    ).toBe(false)
  })
})

describe("resolveTime", () => {
  it("relative anchors on grant, absolute is itself", () => {
    expect(resolveTime({ kind: "afterGrant", ms: 5 * DAY }, GRANT)).toBe(GRANT + 5 * DAY)
    expect(resolveTime({ kind: "absolute", at: 42 }, GRANT)).toBe(42)
  })
})

// ── fold integration ──

function lot(p: Partial<Lot> & Pick<Lot, "remaining">): Lot {
  const base = {
    id: "L1",
    accountId: "acct-1",
    asset: "GUILDE_CREDITS",
    partitionId: "GUILDE_CREDITS:general",
    restriction: UNRESTRICTED,
    reserved: 0,
    sourceEventId: "e1",
    status: "active" as const,
    createdAt: GRANT,
  }
  return { ...base, ...p, original: p.original ?? p.remaining }
}

describe("spendableBalanceUnderPolicy — policy-aware fold", () => {
  it("applies decay per lot and removes reserved", () => {
    const lots = [
      lot({ id: "L1", remaining: 1000, reserved: 100, partitionId: "GUILDE_CREDITS:decay" }),
    ]
    const resolve: PolicyResolver = pid =>
      pid === "GUILDE_CREDITS:decay"
        ? [{ kind: "decay", curve: "linear", ratePerDay: 0.1 }]
        : undefined
    // day 5: 1000 × 0.5 = 500 spendable, minus 100 reserved → 400
    const total = spendableBalanceUnderPolicy(
      lots,
      "GUILDE_CREDITS",
      GRANT + 5 * DAY,
      resolve,
    )
    expect(total).toBe(400)
  })

  it("falls back to the legacy expiresAt path when a partition has no policy", () => {
    const lots = [
      lot({ id: "L1", remaining: 300, expiresAt: GRANT + 1 * DAY }),
      lot({ id: "L2", remaining: 200, expiresAt: GRANT + 10 * DAY }),
    ]
    const resolve: PolicyResolver = () => undefined
    // at day 5: L1 expired, L2 alive → 200
    expect(
      spendableBalanceUnderPolicy(lots, "GUILDE_CREDITS", GRANT + 5 * DAY, resolve),
    ).toBe(200)
  })

  it("single-lot helper returns 0 when the policy makes it ineligible", () => {
    const l = lot({ remaining: 500, partitionId: "GUILDE_CREDITS:image" })
    const policy: PartitionPolicy = [{ kind: "spendOn", categories: ["image"] }]
    expect(spendableLotUnderPolicy(l, policy, GRANT, "text")).toBe(0)
    expect(spendableLotUnderPolicy(l, policy, GRANT, "image")).toBe(500)
  })
})

describe("qualify — caller-asserted spend qualifier", () => {
  const APP_ONLY: PartitionPolicy = [
    { kind: "qualify", key: "channel", allow: ["app"] },
  ]

  it("an allowed qualifier is eligible and leaves the quantity untouched", () => {
    const ev = evaluatePolicy(
      APP_ONLY,
      ctx({ category: "chat", qualifiers: { channel: "app" } }),
    )
    expect(ev.eligible).toBe(true)
    expect(ev.spendable).toBe(1000)
    expect(ev.restriction).toEqual(UNRESTRICTED)
    expect(ev.nextTransitionAt).toBeUndefined()
  })

  it("another value is ineligible", () => {
    const ev = evaluatePolicy(
      APP_ONLY,
      ctx({ category: "chat", qualifiers: { channel: "telegram" } }),
    )
    expect(ev.eligible).toBe(false)
    expect(ev.spendable).toBe(1000) // gate only — never a quantity transform
  })

  it("fails closed: a spend with no qualifiers, or without the key, is ineligible", () => {
    expect(evaluatePolicy(APP_ONLY, ctx({ category: "chat" })).eligible).toBe(false)
    expect(
      evaluatePolicy(APP_ONLY, ctx({ category: "chat", qualifiers: {} })).eligible,
    ).toBe(false)
    expect(
      evaluatePolicy(APP_ONLY, ctx({ category: "chat", qualifiers: { region: "eu" } }))
        .eligible,
    ).toBe(false)
  })

  it("does not read inherited object properties as qualifiers", () => {
    const policy: PartitionPolicy = [
      { kind: "qualify", key: "constructor", allow: ["*"] },
    ]
    expect(
      evaluatePolicy(policy, ctx({ category: "chat", qualifiers: {} })).eligible,
    ).toBe(false)
  })

  it("qualifiers alone (no category) also count as a spend context", () => {
    expect(
      evaluatePolicy(APP_ONLY, ctx({ qualifiers: { channel: "web" } })).eligible,
    ).toBe(false)
    expect(
      evaluatePolicy(APP_ONLY, ctx({ qualifiers: { channel: "app" } })).eligible,
    ).toBe(true)
  })

  it("a pure balance read is neutral", () => {
    const ev = evaluatePolicy(APP_ONLY, ctx())
    expect(ev.eligible).toBe(true)
    expect(ev.spendable).toBe(1000)
  })

  it('"*" allows any value but the qualifier must still be present', () => {
    const policy: PartitionPolicy = [{ kind: "qualify", key: "channel", allow: ["*"] }]
    expect(
      evaluatePolicy(policy, ctx({ category: "chat", qualifiers: { channel: "whatsapp" } }))
        .eligible,
    ).toBe(true)
    expect(evaluatePolicy(policy, ctx({ category: "chat" })).eligible).toBe(false)
    expect(evaluatePolicy(policy, ctx()).eligible).toBe(true) // balance read
  })

  it("an empty allow list admits no spend", () => {
    const policy: PartitionPolicy = [{ kind: "qualify", key: "channel", allow: [] }]
    expect(
      evaluatePolicy(policy, ctx({ qualifiers: { channel: "app" } })).eligible,
    ).toBe(false)
  })

  it("composes (AND) with spendOn and expire", () => {
    const policy: PartitionPolicy = [
      { kind: "spendOn", categories: ["chat"] },
      { kind: "qualify", key: "channel", allow: ["app", "web"] },
      { kind: "expire", at: { kind: "afterGrant", ms: 10 * DAY } },
    ]
    const live = (p: Partial<PolicyContext>) =>
      evaluatePolicy(policy, ctx({ now: GRANT + 5 * DAY, ...p }))

    expect(live({ category: "chat", qualifiers: { channel: "web" } }).eligible).toBe(true)
    expect(live({ category: "image", qualifiers: { channel: "web" } }).eligible).toBe(false)
    expect(live({ category: "chat", qualifiers: { channel: "telegram" } }).eligible).toBe(false)
    expect(live({ category: "chat" }).eligible).toBe(false)

    const expired = evaluatePolicy(
      policy,
      ctx({ now: GRANT + 11 * DAY, category: "chat", qualifiers: { channel: "web" } }),
    )
    expect(expired.eligible).toBe(false)
    expect(expired.spendable).toBe(0)
  })

  it("round-trips through JSON and still evaluates", () => {
    const revived = JSON.parse(JSON.stringify(APP_ONLY)) as PartitionPolicy
    expect(revived).toEqual(APP_ONLY)
    expect(
      evaluatePolicy(revived, ctx({ category: "chat", qualifiers: { channel: "app" } }))
        .eligible,
    ).toBe(true)
  })

  it("flows through the fold helpers", () => {
    const l = lot({ remaining: 500, partitionId: "GUILDE_CREDITS:app-only" })
    expect(spendableLotUnderPolicy(l, APP_ONLY, GRANT, "chat", { channel: "app" })).toBe(500)
    expect(spendableLotUnderPolicy(l, APP_ONLY, GRANT, "chat", { channel: "web" })).toBe(0)
    expect(spendableLotUnderPolicy(l, APP_ONLY, GRANT, "chat")).toBe(0)
    expect(spendableLotUnderPolicy(l, APP_ONLY, GRANT)).toBe(500) // balance read

    const resolve: PolicyResolver = () => APP_ONLY
    const lots = [l]
    expect(
      spendableBalanceUnderPolicy(lots, "GUILDE_CREDITS", GRANT, resolve, "chat", {
        channel: "app",
      }),
    ).toBe(500)
    expect(
      spendableBalanceUnderPolicy(lots, "GUILDE_CREDITS", GRANT, resolve, "chat", {
        channel: "web",
      }),
    ).toBe(0)
    expect(spendableBalanceUnderPolicy(lots, "GUILDE_CREDITS", GRANT, resolve)).toBe(500)
  })

  it("is accepted by defineAsset's schema; malformed rules are rejected", () => {
    const base = {
      ref: "SIMONE_CREDITS",
      name: "Simone Credits",
      symbol: "SMC",
      decimals: 2,
      standard: "internal" as const,
      ruleSet: {
        settleOut: false as const,
        spendableOn: ["*"],
        convertEdges: [],
        transfer: "none" as const,
      },
    }
    const withPolicy = (policy: unknown) =>
      defineAsset({
        ...base,
        partitions: [
          { id: "SIMONE_CREDITS:app", asset: "SIMONE_CREDITS", restriction: [], policy },
        ],
      } as never)

    const ok = withPolicy([{ kind: "qualify", key: "channel", allow: ["app"] }])
    expect(ok.partitions?.[0]?.policy?.[0]).toEqual({
      kind: "qualify",
      key: "channel",
      allow: ["app"],
    })
    expect(() => withPolicy([{ kind: "qualify", key: "", allow: ["app"] }])).toThrow()
    expect(() => withPolicy([{ kind: "qualify", key: "channel" }])).toThrow()
    expect(() =>
      withPolicy([{ kind: "qualify", key: "channel", allow: ["app"], extra: 1 }]),
    ).toThrow()
  })
})

// ── GUILD_X end-to-end: a guild-minted token with a decaying loyalty tranche ──

describe("GUILD_X — guild-minted token, decay + collateralized convert", () => {
  const CREDITS = defineAsset({
    ref: "GUILDE_CREDITS",
    name: "Guilde Credits",
    symbol: "GCR",
    decimals: 2,
    standard: "internal",
    ruleSet: {
      settleOut: "stripe",
      spendableOn: ["*"],
      convertEdges: [],
      transfer: "internal",
    },
  })

  // A guild mints GUILD_X freely (settleOut:false — closed economy). Its only
  // governed boundary is a collateralized convert edge to credits.
  const GUILD_X = defineAsset({
    ref: "GUILD_ACME_X",
    name: "Acme Guild Token",
    symbol: "AX",
    decimals: 2,
    standard: "internal",
    ruleSet: {
      settleOut: false,
      spendableOn: ["*"],
      // 1 AX → 0.5 credits, capped. No reverse edge → no round-trip to arbitrage.
      convertEdges: [
        { to: "GUILDE_CREDITS", rate: { kind: "fixed", ratio: 0.5 } },
      ],
      transfer: "internal",
    },
    partitions: [
      {
        id: "GUILD_ACME_X:loyalty",
        asset: "GUILD_ACME_X",
        restriction: UNRESTRICTED,
        policy: [{ kind: "decay", curve: "linear", ratePerDay: 0.05 }], // -5%/day
      },
    ],
  })

  it("the catalog carries the partition + its policy on the asset", () => {
    expect(GUILD_X.partitions?.[0]?.id).toBe("GUILD_ACME_X:loyalty")
    expect(GUILD_X.partitions?.[0]?.policy?.[0]).toEqual({
      kind: "decay",
      curve: "linear",
      ratePerDay: 0.05,
    })
  })

  it("a loyalty lot decays toward its spend", () => {
    const policy = GUILD_X.partitions![0]!.policy!
    const l = lot({
      remaining: 2000,
      asset: "GUILD_ACME_X",
      partitionId: "GUILD_ACME_X:loyalty",
    })
    expect(spendableLotUnderPolicy(l, policy, GRANT)).toBe(2000)
    expect(spendableLotUnderPolicy(l, policy, GRANT + 10 * DAY)).toBe(1000) // half gone
  })

  it("the convert graph has no arbitrage cycle (one-way, collateralized)", () => {
    const result = verifyNoArbitrage([GUILD_X, CREDITS], (edge, from) => {
      if (edge.rate.kind === "fixed") return edge.rate.ratio
      throw new Error(`unexpected oracle edge from ${from}`)
    })
    expect(result.ok).toBe(true)
  })

  it("catches arbitrage if a careless reverse edge over-prices the round-trip", () => {
    // Deliberately broken: AX→CR 0.5 and CR→AX 2.5 ⇒ round-trip ×1.25 > 1.
    const CREDITS_BAD = defineAsset({
      ...CREDITS,
      ruleSet: {
        ...CREDITS.ruleSet,
        convertEdges: [
          { to: "GUILD_ACME_X", rate: { kind: "fixed", ratio: 2.5 } },
        ],
      },
    })
    const result = verifyNoArbitrage([GUILD_X, CREDITS_BAD], edge => {
      if (edge.rate.kind === "fixed") return edge.rate.ratio
      throw new Error("oracle")
    })
    expect(result.ok).toBe(false)
    expect(result.cycle).toBeDefined()
  })
})
