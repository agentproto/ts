/**
 * Holds on the AIP-49 journal: reserve before a metered action, settle at the
 * real cost capped to what was reserved, release when the action fails or the
 * process dies. Verbs are the journal's own: `reserve`, `capture`, `release`.
 *
 *   hold        -> `reserve` on the lots that can pay (expiring first, oldest first)
 *   settle      -> `capture` min(actual, reserved), `release` the rest (one commit)
 *   release     -> `release` everything that is still held
 *   sweep       -> release the holds a crash left open
 *
 * Invariants the host's rules cannot bypass (the host decides amounts, this executes):
 *   - a hold never takes more than the account can spend (no negative balance);
 *   - settle never captures more than was reserved, whatever the caller passes;
 *     the reserved amounts are read from the journal, not from the `HoldRef`;
 *   - one key, one effect: replaying hold, settle or release writes nothing twice.
 *
 * Every event id derives from the caller's `key`, so a replay of any step
 * writes nothing twice. Nothing here prices anything: the caller converts
 * usage into minor units of the asset.
 */
import { fold, floorOf, type Lot, type WalletEvent } from "@agentproto/wallet"
import type { ClockPort, StoragePort } from "@agentproto/wallet/ports"
import { serial } from "../payment.js"

export interface HoldDeps {
  storage: StoragePort
  clock: ClockPort
}

export interface HoldOptions {
  /** The asset the hold draws on (minor units). */
  asset: string
  /** Narrows which lots may be held (e.g. by partition). Default: every live lot of the asset. */
  lotFilter?: (lot: Lot) => boolean
  /** Share of the reserve spent from which `checkpoint` answers `warn`. Default: never warns (the policy is the host's). */
  warnAt?: number
  /** Share of the reserve spent from which `checkpoint` answers `cutoff`. Default 1: the reserve is spent. */
  cutoffAt?: number
  /** When the account cannot cover the whole amount, hold what it has if that is at least this much. Default: all or nothing. */
  minToStart?: number
  /** Which lots are drawn first. Default: soonest to expire, then oldest. */
  lotOrder?: (a: Lot, b: Lot) => number
}

/** The default draw order: soonest to expire first, then oldest. */
export const defaultLotOrder = (a: Lot, b: Lot): number => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) || a.createdAt - b.createdAt

export interface HoldDraw {
  lotId: string
  partitionId: string
  restriction: WalletEvent["restriction"]
  amount: number
}

/** What the caller keeps between `hold` and `settle`. Serializable. */
export interface HoldRef {
  holdId: string
  accountId: string
  asset: string
  reserved: number
  draws: HoldDraw[]
  createdAt: number
}

export type HoldResult = { ok: true; hold: HoldRef; replayed: boolean } | { ok: false; reason: "insufficient_funds" | "invalid_amount" | "key_conflict" }

export interface SettleResult {
  /** Captured: min(actual, reserved). */
  charged: number
  /** Given back to the account. */
  released: number
  /** Usage above the reserve, never captured here: the caller debits it (or absorbs it) through its own path. */
  overrun: number
  replayed: boolean
}

export type CheckpointAction = "continue" | "warn" | "cutoff"

export interface HoldEngine {
  /** `key` must be unique per hold (it is the idempotency key): the same key again replays the first hold, on another asset it is refused with `key_conflict`. */
  hold(req: { accountId: string; key: string; amount: number }): Promise<HoldResult>
  /** Pure: where `spent` stands against what is reserved. A hold of 0 never warns or cuts. */
  checkpoint(hold: HoldRef, spent: number): { action: CheckpointAction; spent: number; reserved: number }
  settle(hold: HoldRef, actual: number): Promise<SettleResult>
  release(hold: HoldRef): Promise<SettleResult>
  /** Release every hold on the account that is still open and older than `olderThanMs`. Returns their keys. */
  sweep(accountId: string, opts: { olderThanMs: number }): Promise<string[]>
}

const reserveId = (key: string, lotId: string) => `${key}:reserve:${lotId}`
const captureId = (key: string, lotId: string) => `${key}:capture:${lotId}`
const releaseId = (key: string, lotId: string) => `${key}:release:${lotId}`

function available(lot: Lot, now: number): number {
  if (lot.status === "exhausted") return 0
  if (lot.expiresAt !== undefined && lot.expiresAt <= now) return 0
  return Math.max(0, lot.remaining - lot.reserved - floorOf(lot.floor))
}

function drawsOf(events: WalletEvent[], key: string): HoldDraw[] {
  return events
    .filter(e => e.kind === "reserve" && e.correlationId === key)
    .map(e => ({ lotId: e.lotId, partitionId: e.partitionId, restriction: e.restriction, amount: e.amount }))
}

export function createHolds(deps: HoldDeps, opts: HoldOptions): HoldEngine {
  const warnAt = opts.warnAt
  const cutoffAt = opts.cutoffAt ?? 1
  const order = opts.lotOrder ?? defaultLotOrder
  // A metered action is the cost of the agent existing, never a chosen payment: always passive.
  const intent = "passive" as const
  const lane = (accountId: string) => `spend:${accountId}`

  async function close(hold: HoldRef, actual: number): Promise<SettleResult> {
    // Invariant: never guess an amount. A non-number would capture 0 or everything.
    if (typeof actual !== "number" || Number.isNaN(actual)) throw new RangeError("settle: actual must be a number")
    return serial(lane(hold.accountId), async () => {
      const events = await deps.storage.loadEvents(hold.accountId)
      const mine = events.filter(e => e.correlationId === hold.holdId)
      const done = mine.filter(e => e.kind === "capture" || e.kind === "release")
      if (done.length > 0) {
        const charged = done.filter(e => e.kind === "capture").reduce((s, e) => s + e.amount, 0)
        const released = done.filter(e => e.kind === "release").reduce((s, e) => s + e.amount, 0)
        return { charged, released, overrun: Math.max(0, Math.max(0, actual) - charged), replayed: true }
      }
      const reserved = drawsOf(mine, hold.holdId)
      const total = reserved.reduce((s, d) => s + d.amount, 0)
      if (total === 0) return { charged: 0, released: 0, overrun: Math.max(0, actual), replayed: false }
      const now = deps.clock.nowMs()
      let toCapture = Math.min(Math.max(0, Math.floor(actual)), total)
      const out: WalletEvent[] = []
      for (const d of reserved) {
        const cap = Math.min(toCapture, d.amount)
        toCapture -= cap
        const rel = d.amount - cap
        const base = { accountId: hold.accountId, asset: hold.asset, partitionId: d.partitionId, restriction: d.restriction, lotId: d.lotId, correlationId: hold.holdId, intent, occurredAt: now }
        if (cap > 0) out.push({ ...base, id: captureId(hold.holdId, d.lotId), kind: "capture", amount: cap })
        if (rel > 0) out.push({ ...base, id: releaseId(hold.holdId, d.lotId), kind: "release", amount: rel })
      }
      await deps.storage.commit(hold.accountId, out)
      const charged = out.filter(e => e.kind === "capture").reduce((s, e) => s + e.amount, 0)
      return { charged, released: total - charged, overrun: Math.max(0, Math.floor(actual) - charged), replayed: false }
    })
  }

  return {
    async hold({ accountId, key, amount }) {
      if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "invalid_amount" }
      const want = Math.floor(amount)
      return serial(lane(accountId), async () => {
        const events = await deps.storage.loadEvents(accountId)
        const have = events.filter(e => e.kind === "reserve" && e.correlationId === key)
        if (have.length > 0) {
          // One key, one hold: a key already used for another asset is a caller bug, never a replay.
          if (have.some(e => e.asset !== opts.asset)) return { ok: false as const, reason: "key_conflict" as const }
          const draws = drawsOf(have, key)
          return { ok: true as const, replayed: true, hold: { holdId: key, accountId, asset: opts.asset, reserved: draws.reduce((s, d) => s + d.amount, 0), draws, createdAt: have[0]!.occurredAt } }
        }
        const now = deps.clock.nowMs()
        const lots = fold(events, now)
          .filter(l => l.asset === opts.asset && available(l, now) > 0 && (opts.lotFilter?.(l) ?? true))
          .sort(order)
        const spendable = lots.reduce((s, l) => s + available(l, now), 0)
        const take = spendable >= want ? want : opts.minToStart !== undefined && spendable >= opts.minToStart && spendable > 0 ? spendable : 0
        if (take === 0) return { ok: false as const, reason: "insufficient_funds" as const }
        let need = take
        const out: WalletEvent[] = []
        for (const l of lots) {
          if (need <= 0) break
          const part = Math.min(need, available(l, now))
          out.push({ id: reserveId(key, l.id), accountId, kind: "reserve", asset: l.asset, partitionId: l.partitionId, restriction: l.restriction, amount: part, lotId: l.id, correlationId: key, intent, occurredAt: now })
          need -= part
        }
        await deps.storage.commit(accountId, out)
        const draws = drawsOf(out, key)
        return { ok: true as const, replayed: false, hold: { holdId: key, accountId, asset: opts.asset, reserved: take, draws, createdAt: now } }
      })
    },

    checkpoint(hold, spent) {
      const reserved = hold.reserved
      if (reserved <= 0) return { action: "continue", spent, reserved }
      if (spent >= reserved * cutoffAt) return { action: "cutoff", spent, reserved }
      if (warnAt !== undefined && spent >= reserved * warnAt) return { action: "warn", spent, reserved }
      return { action: "continue", spent, reserved }
    },

    settle: (hold, actual) => close(hold, actual),
    release: hold => close(hold, 0),

    async sweep(accountId, { olderThanMs }) {
      const now = deps.clock.nowMs()
      const events = await deps.storage.loadEvents(accountId)
      const closed = new Set(events.filter(e => e.kind === "capture" || e.kind === "release").map(e => e.correlationId))
      const open = new Map<string, WalletEvent[]>()
      for (const e of events) {
        if (e.kind !== "reserve" || !e.correlationId || closed.has(e.correlationId)) continue
        open.set(e.correlationId, [...(open.get(e.correlationId) ?? []), e])
      }
      const swept: string[] = []
      for (const [key, evs] of open) {
        if (now - evs[0]!.occurredAt < olderThanMs) continue
        const draws = drawsOf(evs, key)
        const r = await close({ holdId: key, accountId, asset: evs[0]!.asset, reserved: draws.reduce((s, d) => s + d.amount, 0), draws, createdAt: evs[0]!.occurredAt }, 0)
        // A hold its owner settled between our read and the close is not ours to report.
        if (!r.replayed) swept.push(key)
      }
      return swept
    },
  }
}
