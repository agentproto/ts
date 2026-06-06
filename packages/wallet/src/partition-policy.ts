/**
 * Partition policy — the unified lifecycle runtime for a tranche.
 *
 * `restriction`, `expiry`, `decay`, `vesting`, `transfer-scope` are not five
 * special-cased fields: each is a RULE KIND in one declarative `PartitionPolicy`
 * (an ordered list of rules), evaluated by one pure folder. A partition carries
 * its policy; a lot carries only raw `remaining` + `grantedAt`, and its
 * *effective* spendable + eligibility are computed by folding the policy.
 *
 * Two orthogonal effects a rule can contribute:
 *   - quantity transform — how much of `remaining` is spendable NOW
 *     (expire → ×0 past the cliff, decay → ×factor(t), vest → ×unlocked(t)).
 *   - eligibility gate — may this value be spent for a category / sent to a
 *     counterparty (spendOn, transfer-scope). `restrict` only stamps lattice
 *     tags (consumed by convert/coalesce), it never gates a spend by itself.
 *
 * Rules are pure DATA (JSON-serialisable → DB rows, on-chain partition modules);
 * evaluators are CODE keyed by kind. Adding a kind = extend the union + add one
 * evaluator entry; the compiler points at the single dispatch site until it is
 * handled. This is the off-chain twin of an ERC-1400 transfer-restriction module
 * plus rebasing math.
 */

import type { Restriction } from "./restriction-lattice.js"
import { canonical, UNRESTRICTED } from "./restriction-lattice.js"

/** A point in time, relative to the lot's grant or absolute (epoch ms). */
export type TimeSpec =
  | { kind: "afterGrant"; ms: number }
  | { kind: "absolute"; at: number }

/** Resolve a TimeSpec to an absolute epoch-ms instant. */
export function resolveTime(spec: TimeSpec, grantedAt: number): number {
  return spec.kind === "afterGrant" ? grantedAt + spec.ms : spec.at
}

/** One lifecycle rule. The `kind` discriminates; rules are serialisable data. */
export type PartitionRule =
  /** Narrows the categories this value may pay for (∩ with the asset's). */
  | { kind: "spendOn"; categories: readonly string[] }
  /** Stamps lattice restriction tags onto the value (lineage / no-laundering). */
  | { kind: "restrict"; tags: Restriction }
  /** Hard cliff: spendable drops to 0 once `at` passes. */
  | { kind: "expire"; at: TimeSpec }
  /** Continuous write-down: spendable = remaining × factor(elapsed). */
  | {
      kind: "decay"
      curve: "linear" | "exponential"
      /** Fraction lost per day (0..1). linear hits 0 at 1/rate days. */
      ratePerDay: number
    }
  /** Inverse of decay: unlocks over time after an optional cliff. */
  | {
      kind: "vest"
      /** No value unlocks before this instant. */
      cliff?: TimeSpec
      /** Linear unlock completes this many ms after grant (or after cliff). */
      durationMs: number
    }
  /** Restricts movement between wallets (does not affect spend). */
  | { kind: "transfer"; scope: "soulbound" | "account" | "open" }

/** An ordered list of rules — the partition's full lifecycle behaviour. */
export type PartitionPolicy = readonly PartitionRule[]

/** What the caller knows when evaluating: time, the lot's anchor + amount, ctx. */
export interface PolicyContext {
  /** Wall-clock now (epoch ms). */
  now: number
  /** The lot's grant instant — the anchor for every relative TimeSpec. */
  grantedAt: number
  /** Raw remaining (minor units) before any quantity transform. */
  remaining: number
  /** Spend category under test; undefined for a pure balance read. */
  category?: string
  /** Transfer counterparty under test; undefined for a spend. */
  counterparty?: string
}

/** One rule's contribution to the fold. */
interface RuleEffect {
  /** Multiplier on remaining (1 = unchanged, 0 = none). Composed multiplicatively. */
  factor: number
  /** Hard gate for the requested context. AND-ed across rules. */
  eligible: boolean
  /** Restriction tags this rule stamps (folded via lattice union). */
  restriction?: Restriction
  /** Next instant this rule's output changes — for the sweep projection. */
  nextTransitionAt?: number
}

/** The folded result of a whole policy. */
export interface PolicyEvaluation {
  /** Effective spendable now (minor units, floored to an integer). */
  spendable: number
  /** Whether the value is usable for the requested category / counterparty. */
  eligible: boolean
  /** Canonical restriction tags carried by the value. */
  restriction: Restriction
  /** Earliest instant the spendable amount changes on its own (sweep hint). */
  nextTransitionAt?: number
}

const DAY_MS = 86_400_000

/**
 * Per-kind evaluators. Each receives its narrowed rule. Adding a `PartitionRule`
 * member without an entry here is a compile error (mapped type), so the registry
 * stays exhaustive without a central switch to forget.
 */
type RuleEvaluators = {
  [K in PartitionRule["kind"]]: (
    rule: Extract<PartitionRule, { kind: K }>,
    ctx: PolicyContext,
  ) => RuleEffect
}

const NEUTRAL: RuleEffect = { factor: 1, eligible: true }

const EVALUATORS: RuleEvaluators = {
  spendOn: (rule, ctx) => {
    if (ctx.category === undefined) return NEUTRAL
    const ok =
      rule.categories.includes("*") || rule.categories.includes(ctx.category)
    return { factor: 1, eligible: ok }
  },

  restrict: rule => ({ factor: 1, eligible: true, restriction: rule.tags }),

  expire: (rule, ctx) => {
    const deadline = resolveTime(rule.at, ctx.grantedAt)
    const live = ctx.now < deadline
    return {
      factor: live ? 1 : 0,
      eligible: live,
      nextTransitionAt: deadline,
    }
  },

  decay: (rule, ctx) => {
    const days = Math.max(0, (ctx.now - ctx.grantedAt) / DAY_MS)
    let factor: number
    let zeroAt: number | undefined
    if (rule.curve === "linear") {
      factor = Math.max(0, 1 - rule.ratePerDay * days)
      // Linear decay reaches 0 at grant + (1/rate) days — a real transition.
      if (rule.ratePerDay > 0) {
        zeroAt = ctx.grantedAt + (DAY_MS / rule.ratePerDay)
      }
    } else {
      // Daily-compounded exponential: asymptotic, never a hard zero.
      factor = Math.pow(1 - rule.ratePerDay, days)
    }
    return {
      factor: Math.max(0, Math.min(1, factor)),
      eligible: factor > 0,
      nextTransitionAt: zeroAt,
    }
  },

  vest: (rule, ctx) => {
    const start = rule.cliff
      ? resolveTime(rule.cliff, ctx.grantedAt)
      : ctx.grantedAt
    if (ctx.now < start) {
      return { factor: 0, eligible: false, nextTransitionAt: start }
    }
    const end = start + rule.durationMs
    if (ctx.now >= end) return NEUTRAL
    const fraction = (ctx.now - start) / rule.durationMs
    return { factor: fraction, eligible: fraction > 0, nextTransitionAt: end }
  },

  transfer: (rule, ctx) => {
    if (ctx.counterparty === undefined) return NEUTRAL
    return { factor: 1, eligible: rule.scope !== "soulbound" }
  },
}

/** Dispatch one rule to its evaluator. Type-safe: the union member matches its slot. */
function evaluateRule(rule: PartitionRule, ctx: PolicyContext): RuleEffect {
  switch (rule.kind) {
    case "spendOn":
      return EVALUATORS.spendOn(rule, ctx)
    case "restrict":
      return EVALUATORS.restrict(rule, ctx)
    case "expire":
      return EVALUATORS.expire(rule, ctx)
    case "decay":
      return EVALUATORS.decay(rule, ctx)
    case "vest":
      return EVALUATORS.vest(rule, ctx)
    case "transfer":
      return EVALUATORS.transfer(rule, ctx)
    default: {
      const _exhaustive: never = rule
      return _exhaustive
    }
  }
}

/**
 * Fold a policy over a context into its effective spendable + eligibility.
 *
 * factor   composes multiplicatively (decay × vest × expire-gate)
 * eligible AND-s across all rules
 * restriction folds via the lattice union (accumulates, never launders)
 * nextTransitionAt is the EARLIEST upcoming self-change (sweep schedules on it)
 */
export function evaluatePolicy(
  policy: PartitionPolicy,
  ctx: PolicyContext,
): PolicyEvaluation {
  let factor = 1
  let eligible = true
  let restriction: Restriction = UNRESTRICTED
  let nextTransitionAt: number | undefined

  for (const rule of policy) {
    const eff = evaluateRule(rule, ctx)
    factor *= eff.factor
    eligible = eligible && eff.eligible
    if (eff.restriction && eff.restriction.length > 0) {
      restriction = canonical([...restriction, ...eff.restriction])
    }
    if (
      eff.nextTransitionAt !== undefined &&
      eff.nextTransitionAt > ctx.now &&
      (nextTransitionAt === undefined || eff.nextTransitionAt < nextTransitionAt)
    ) {
      nextTransitionAt = eff.nextTransitionAt
    }
  }

  return {
    spendable: Math.floor(ctx.remaining * factor),
    eligible,
    restriction,
    nextTransitionAt,
  }
}
