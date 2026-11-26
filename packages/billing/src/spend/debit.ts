/**
 * `debit`: a direct spend with no reserve first (a short call, an after-the-fact
 * charge). The core EXECUTES it on the journal's own `burn` verb, one per lot
 * drawn, expiring first then oldest. Policy comes in as named, ordered, pure
 * `rules` that decide an amount or a refusal (see `rules.ts`); they never get
 * write access to the journal.
 *
 * Invariants no rule can lift:
 *  - one key charges once: a replay writes nothing and returns the first charge;
 *  - a rule can only LOWER the requested amount (never raise it); a rule that
 *    lowers it hands the lower amount to the next rule, a refusal stops the run
 *    (so a lowering rule placed first does not hide a cap placed after it);
 *  - a lot is never drawn below its `floor` (0 for a prepaid lot; a postpaid
 *    account holds a lot with a negative floor);
 *  - a rule that throws or answers badly refuses the spend.
 *
 * A shortfall is named by the caller (no default): `refuse` writes nothing when
 * the account cannot cover the amount; `absorb` charges what the account has
 * and reports the rest as `shortfall`. A debit that charges nothing writes
 * nothing, so it leaves no trace to replay. A replay of a key that charged
 * ignores the new amount and reports the charge with `shortfall: 0` and no rule
 * (the first outcome is not stored). The amount must be an integer. Lots are chosen by asset and the optional
 * `lotFilter` (restrictions and policies are the host's to apply there).
 */
import { fold, floorOf, type Lot, type WalletEvent } from "@agentproto/wallet"
import type { ClockPort, StoragePort } from "@agentproto/wallet/ports"
import type { CauseEvent } from "../ports.js"
import { serial } from "../payment.js"
import { ruleProblems, runRules, type Rule, type RuleTrace } from "./rules.js"

export interface DebitDeps {
  storage: StoragePort
  clock: ClockPort
}

/** What a rule sees: a frozen snapshot, never a handle on the journal. */
export interface DebitContext {
  accountId: string
  key: string
  asset: string
  /** The amount the caller asked for, minor units. */
  requested: number
  /** What the account could pay right now (sum over the eligible lots). */
  spendable: number
  now: number
  /** The account's journal so far, frozen. */
  history: readonly Readonly<WalletEvent>[]
}

/** `refuse` stops the spend; `amount` charges that much instead (an integer from 1 to the requested amount). */
export type DebitDecision = { refuse: string } | { amount: number }

export type DebitRule = Rule<DebitContext, DebitDecision>

export interface DebitOptions {
  asset: string
  /** Narrows which lots may be drawn (e.g. by partition or restriction). */
  lotFilter?: (lot: Lot) => boolean
  /** The host's policy, in the order they apply. */
  rules?: readonly DebitRule[]
}

export interface DebitRequest {
  accountId: string
  /** Idempotency key. Required. */
  key: string
  /** Minor units of the asset. */
  amount: number
  /** What to do when the account cannot cover the amount. No default. */
  shortfall: "absorb" | "refuse"
  /** The movement or action that caused this debit (journal `cause`). */
  cause?: string
}

export type DebitResult =
  | { ok: true; charged: number; shortfall: number; replayed: boolean; decidedBy?: string; trace: RuleTrace[] }
  | { ok: false; reason: "insufficient_funds" | "invalid_amount" | "invalid_key"; trace: RuleTrace[] }
  | { ok: false; reason: "refused_by_rule" | "rule_error" | "invalid_decision"; rule: string; detail?: string; trace: RuleTrace[] }

export interface DebitEngine {
  debit(req: DebitRequest): Promise<DebitResult>
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v)
  }
  return o
}

const isDecision = (d: unknown): d is DebitDecision =>
  typeof d === "object" && d !== null && (("refuse" in d && typeof (d as { refuse: unknown }).refuse === "string") || ("amount" in d && typeof (d as { amount: unknown }).amount === "number"))

const burnId = (key: string, lotId: string) => `${key}:burn:${lotId}`
const drawOrder = (a: Lot, b: Lot): number => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) || a.createdAt - b.createdAt

function available(lot: Lot, now: number): number {
  if (lot.status === "exhausted") return 0
  if (lot.expiresAt !== undefined && lot.expiresAt <= now) return 0
  return Math.max(0, lot.remaining - lot.reserved - floorOf(lot.floor))
}

export function createDebit(deps: DebitDeps, opts: DebitOptions): DebitEngine {
  const rules = opts.rules ?? []
  const problems = ruleProblems(rules as readonly Rule<never, unknown>[])
  if (problems.length > 0) throw new Error(`invalid debit rules: ${problems.join("; ")}`)
  return {
    async debit({ accountId, key, amount, shortfall, cause }) {
      if (typeof key !== "string" || key.length === 0) return { ok: false, reason: "invalid_key", trace: [] }
      if (!Number.isInteger(amount) || amount <= 0) return { ok: false, reason: "invalid_amount", trace: [] }
      const want = amount
      return serial(`spend:${accountId}`, async () => {
        const events = await deps.storage.loadEvents(accountId)
        const done = events.filter(e => e.kind === "burn" && e.correlationId === key && e.id.startsWith(`${key}:burn:`))
        if (done.length > 0) {
          // The first outcome is not stored: a replay reports the charge, no shortfall and no rule.
          const charged = done.reduce((s, e) => s + e.amount, 0)
          return { ok: true as const, charged, shortfall: 0, replayed: true, trace: [] }
        }
        const now = deps.clock.nowMs()
        const lots = fold(events, now)
          .filter(l => l.asset === opts.asset && available(l, now) > 0 && (opts.lotFilter?.(l) ?? true))
          .sort(drawOrder)
        const spendable = lots.reduce((s, l) => s + available(l, now), 0)

        let target = want
        let decidedBy: string | undefined
        let trace: RuleTrace[] = []
        if (rules.length > 0) {
          const ctx: DebitContext = Object.freeze({ accountId, key, asset: opts.asset, requested: want, spendable, now, history: deepFreeze(structuredClone(events)) })
          // A rule that lowers the amount passes the lowered amount to the next rule; a refusal stops the run.
          const run = runRules(rules, ctx, (c, d) => (isDecision(d) && "amount" in d && Number.isInteger(d.amount) && d.amount >= 1 && d.amount <= c.requested ? { ctx: Object.freeze({ ...c, requested: d.amount }), stop: false } : { ctx: c, stop: true }))
          trace = run.trace
          if (run.error) return { ok: false as const, reason: "rule_error" as const, rule: run.error.rule, detail: run.error.message, trace }
          if (run.decision !== undefined) {
            const d = run.decision
            if (!isDecision(d)) return { ok: false as const, reason: "invalid_decision" as const, rule: run.decidedBy!, detail: "a rule answers undefined, { refuse } or { amount }", trace }
            if ("refuse" in d) return { ok: false as const, reason: "refused_by_rule" as const, rule: run.decidedBy!, detail: d.refuse, trace }
            if (!Number.isInteger(d.amount) || d.amount < 1 || d.amount > run.ctx.requested) return { ok: false as const, reason: "invalid_decision" as const, rule: run.decidedBy!, detail: `a rule may only lower the amount to an integer between 1 and ${run.ctx.requested}, got ${d.amount}`, trace }
            decidedBy = run.decidedBy
            target = run.ctx.requested
          }
        }

        if (shortfall === "refuse" && spendable < target) return { ok: false as const, reason: "insufficient_funds" as const, trace }
        const take = Math.min(target, spendable)
        if (take === 0) return { ok: true as const, charged: 0, shortfall: target, replayed: false, ...(decidedBy ? { decidedBy } : {}), trace }
        let need = take
        const out: CauseEvent[] = []
        for (const l of lots) {
          if (need <= 0) break
          const part = Math.min(need, available(l, now))
          out.push({
            id: burnId(key, l.id), accountId, kind: "burn", asset: l.asset, partitionId: l.partitionId, restriction: l.restriction,
            amount: part, lotId: l.id, correlationId: key, intent: "passive", occurredAt: now, ...(cause ? { cause } : {}),
          } as WalletEvent & { cause?: string })
          need -= part
        }
        await deps.storage.commit(accountId, out)
        return { ok: true as const, charged: take, shortfall: target - take, replayed: false, ...(decidedBy ? { decidedBy } : {}), trace }
      })
    },
  }
}
