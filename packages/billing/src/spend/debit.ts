/**
 * `debit`: a direct spend with no reserve first (a short call, an after-the-fact
 * charge). It writes the journal's own `burn` verb, one per lot drawn, expiring
 * first then oldest, and every event id derives from the caller's `key`, so a
 * replay writes nothing twice.
 *
 * A shortfall is a choice the caller names (there is no default): `refuse` writes nothing when the
 * account cannot cover the whole amount; `absorb` charges what the account has
 * and reports the rest as `shortfall` (the unrecovered part). A debit that
 * charges nothing writes nothing, so it leaves no trace to replay: the same key
 * retried later can charge. A replay of a key that charged returns the first
 * charge and ignores the new amount. Lots are chosen by asset and by the
 * optional `lotFilter`; restrictions and policies are the host's to apply
 * there (as for `selectLotsForSpend`). A postpaid
 * account is not a third mode: it holds a lot with a negative `floor`, so its
 * headroom counts as available.
 */
import { fold, floorOf, type Lot, type WalletEvent } from "@agentproto/wallet"
import type { ClockPort, StoragePort } from "@agentproto/wallet/ports"
import type { CauseEvent } from "../ports.js"
import { serial } from "../payment.js"

export interface DebitDeps {
  storage: StoragePort
  clock: ClockPort
}

export interface DebitOptions {
  asset: string
  /** Narrows which lots may be drawn (e.g. by partition or restriction). */
  lotFilter?: (lot: Lot) => boolean
  /** The order lots are drawn in. Default `defaultLotOrder` (expiring first, then oldest); a host injects its own. */
  order?: (a: Lot, b: Lot) => number
  /** The intent written on the burn events. Default `passive`. */
  intent?: WalletEvent["intent"]
}

/** Expiring first, then oldest. The default draw order; replaceable through `DebitOptions.order`. */
export const defaultLotOrder = (a: Lot, b: Lot): number => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) || a.createdAt - b.createdAt

export interface DebitRequest {
  accountId: string
  /** Idempotency key. Required: a debit with no key cannot be replayed safely. */
  key: string
  /** Minor units of the asset. */
  amount: number
  /** What to do when the account cannot cover the amount. No default: the caller names it. `refuse`: write nothing. `absorb`: charge what is there and report the rest. */
  shortfall: "absorb" | "refuse"
  /** The movement or action that caused this debit (journal `cause`). */
  cause?: string
}

export type DebitResult =
  | { ok: true; charged: number; shortfall: number; replayed: boolean }
  | { ok: false; reason: "insufficient_funds" | "invalid_amount" | "invalid_key" }

export interface DebitEngine {
  debit(req: DebitRequest): Promise<DebitResult>
}

const burnId = (key: string, lotId: string) => `${key}:burn:${lotId}`

function available(lot: Lot, now: number): number {
  if (lot.status === "exhausted") return 0
  if (lot.expiresAt !== undefined && lot.expiresAt <= now) return 0
  return Math.max(0, lot.remaining - lot.reserved - floorOf(lot.floor))
}

export function createDebit(deps: DebitDeps, opts: DebitOptions): DebitEngine {
  return {
    async debit({ accountId, key, amount, shortfall, cause }) {
      if (typeof key !== "string" || key.length === 0) return { ok: false, reason: "invalid_key" }
      if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "invalid_amount" }
      const want = Math.floor(amount)
      if (want <= 0) return { ok: false, reason: "invalid_amount" }
      return serial(`spend:${accountId}`, async () => {
        const events = await deps.storage.loadEvents(accountId)
        const done = events.filter(e => e.kind === "burn" && e.correlationId === key && e.id.startsWith(`${key}:burn:`))
        if (done.length > 0) {
          const charged = done.reduce((s, e) => s + e.amount, 0)
          return { ok: true as const, charged, shortfall: Math.max(0, want - charged), replayed: true }
        }
        const now = deps.clock.nowMs()
        const lots = fold(events, now)
          .filter(l => l.asset === opts.asset && available(l, now) > 0 && (opts.lotFilter?.(l) ?? true))
          .sort(opts.order ?? defaultLotOrder)
        const spendable = lots.reduce((s, l) => s + available(l, now), 0)
        if (shortfall === "refuse" && spendable < want) return { ok: false as const, reason: "insufficient_funds" as const }
        const take = Math.min(want, spendable)
        if (take === 0) return { ok: true as const, charged: 0, shortfall: want, replayed: false }
        let need = take
        const out: CauseEvent[] = []
        for (const l of lots) {
          if (need <= 0) break
          const part = Math.min(need, available(l, now))
          out.push({
            id: burnId(key, l.id), accountId, kind: "burn", asset: l.asset, partitionId: l.partitionId, restriction: l.restriction,
            amount: part, lotId: l.id, correlationId: key, intent: opts.intent ?? "passive", occurredAt: now, ...(cause ? { cause } : {}),
          } as WalletEvent & { cause?: string })
          need -= part
        }
        await deps.storage.commit(accountId, out)
        return { ok: true as const, charged: take, shortfall: want - take, replayed: false }
      })
    },
  }
}
