/**
 * In-memory stand-ins for the ports and a fake payment provider, for tests and
 * for a provider package's own conformance run. No network, no key, no model.
 */
import { fold, spendableBalance, type Lot, type WalletEvent } from "@agentproto/wallet"
import type { ClockPort, SettlementResult, StoragePort } from "@agentproto/wallet/ports"
import type { AccessRecord, BillingStateStore, PeriodRecord } from "../ports.js"
import type { RailFact, SettlementProvider, WebhookRequest } from "../settlement.js"

/** A clock the test moves by hand. */
export class ManualClock implements ClockPort {
  constructor(private t: number) {}
  now(): Date {
    return new Date(this.t)
  }
  nowMs(): number {
    return this.t
  }
  set(t: number): void {
    this.t = t
  }
  advance(ms: number): void {
    this.t += ms
  }
}

/** Journal in memory: folds on every read and refuses a commit that would overdraw a lot (what the Postgres adapter must do). */
export class InMemoryStorage implements StoragePort {
  private journals = new Map<string, WalletEvent[]>()
  constructor(private readonly clock: ClockPort) {}
  async loadEvents(accountId: string): Promise<WalletEvent[]> {
    return [...(this.journals.get(accountId) ?? [])]
  }
  async loadLots(accountId: string): Promise<Lot[]> {
    return fold(this.journals.get(accountId) ?? [], this.clock.nowMs())
  }
  async commit(accountId: string, events: readonly WalletEvent[]): Promise<void> {
    const have = this.journals.get(accountId) ?? []
    const ids = new Set(have.map(e => e.id))
    for (const e of events) if (ids.has(e.id)) throw new Error(`duplicate event id ${e.id}`)
    const next = [...have, ...events]
    for (const lot of fold(next, this.clock.nowMs())) {
      if (lot.remaining - lot.reserved < (lot.floor === undefined ? 0 : (lot.floor ?? -Infinity))) throw new Error(`overdraw on lot ${lot.id}`)
      if (lot.reserved < 0) throw new Error(`negative hold on lot ${lot.id}`)
    }
    this.journals.set(accountId, next)
  }
  async spendableBalance(accountId: string, asset: string): Promise<number> {
    return spendableBalance(fold(this.journals.get(accountId) ?? [], this.clock.nowMs()), asset, this.clock.nowMs())
  }
  /** Spend `amount` of `asset` from the account's lots, oldest expiry first (a test helper, not the coalescing policy). */
  async spend(accountId: string, asset: string, amount: number, id: string): Promise<void> {
    const now = this.clock.nowMs()
    let need = amount
    const events: WalletEvent[] = []
    const lots = (await this.loadLots(accountId))
      .filter(l => l.asset === asset && !(l.expiresAt !== undefined && l.expiresAt <= now) && l.remaining - l.reserved > 0)
      .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) || a.createdAt - b.createdAt)
    for (const l of lots) {
      if (need <= 0) break
      const take = Math.min(need, l.remaining - l.reserved)
      events.push({ id: `${id}:${l.id}`, accountId, kind: "burn", asset, partitionId: l.partitionId, restriction: l.restriction, amount: take, lotId: l.id, occurredAt: now })
      need -= take
    }
    if (need > 0) throw new Error(`cannot spend ${amount}, ${need} short`)
    await this.commit(accountId, events)
  }
}

export class InMemoryBillingState implements BillingStateStore {
  private periods = new Map<string, PeriodRecord>()
  private access = new Map<string, AccessRecord>()
  private payments = new Map<string, string>()
  async putPeriod(p: PeriodRecord): Promise<void> {
    this.periods.set(p.id, { ...p, given: [...p.given], features: [...p.features] })
  }
  async getPeriod(id: string): Promise<PeriodRecord | null> {
    const p = this.periods.get(id)
    return p ? { ...p, given: [...p.given] } : null
  }
  async listPeriods(filter?: { accountId?: string; offerId?: string }): Promise<PeriodRecord[]> {
    return [...this.periods.values()]
      .filter(p => (!filter?.accountId || p.accountId === filter.accountId) && (!filter?.offerId || p.offerId === filter.offerId))
      .map(p => ({ ...p, given: [...p.given] }))
  }
  async putPayment(movement: string, accountId: string): Promise<void> {
    this.payments.set(movement, accountId)
  }
  async paymentAccount(movement: string): Promise<string | null> {
    return this.payments.get(movement) ?? null
  }
  async putAccess(a: AccessRecord): Promise<void> {
    this.access.set(a.id, { ...a })
  }
  async getAccess(id: string): Promise<AccessRecord | null> {
    return this.access.get(id) ?? null
  }
  async listAccess(accountId: string): Promise<AccessRecord[]> {
    return [...this.access.values()].filter(a => a.accountId === accountId)
  }
}

/**
 * A payment provider with no network. Webhook bodies are JSON `{ type, id,
 * movement, ... }`; the signature header is `x-fake-signature: <webhook secret>`.
 * Like a real rail it sends SEVERAL events for one money movement: both
 * `payment_intent.succeeded` and `charge.succeeded` normalise to the same movement.
 */
export class FakeSettlementProvider implements SettlementProvider {
  readonly id: string
  readonly name = "Fake rail"
  readonly env: { secretKey: string; webhookSecret: string; mode: string }
  readonly refunds: { movement: string; amountMinor: number; ref: string }[] = []
  readonly catalogs: unknown[] = []
  constructor(
    private readonly webhookSecret: string,
    id = "fake",
  ) {
    this.id = id
    const up = id.toUpperCase()
    this.env = { secretKey: `${up}_SECRET_KEY`, webhookSecret: `${up}_WEBHOOK_SECRET`, mode: `${up}_MODE` }
  }
  async charge(p: { accountId: string; amountMinor: number; asset: string; ref: string }): Promise<SettlementResult> {
    return { ok: true, externalRef: `${this.id}:pi_${p.ref}`, network: this.id }
  }
  async pay(): Promise<SettlementResult> {
    return { ok: false, error: "the fake rail does not pay out" }
  }
  async refund(movement: string, amountMinor: number, ref: string): Promise<SettlementResult> {
    // `ref` is the idempotency key, as at a real rail: the same ref is the same refund.
    const known = this.refunds.findIndex(r => r.ref === ref)
    if (known >= 0) return { ok: true, externalRef: `${this.id}:re_${known + 1}` }
    this.refunds.push({ movement, amountMinor, ref })
    return { ok: true, externalRef: `${this.id}:re_${this.refunds.length}` }
  }
  async syncCatalog(projection: unknown): Promise<void> {
    this.catalogs.push(projection)
  }
  /** Build a signed request for a payment event. */
  signed(body: Record<string, unknown>): WebhookRequest {
    return { body: JSON.stringify(body), headers: { "x-fake-signature": this.webhookSecret } }
  }
  async verifyWebhook(raw: WebhookRequest): Promise<RailFact | null> {
    if (raw.headers["x-fake-signature"] !== this.webhookSecret) throw new Error("webhook signature mismatch")
    const e = JSON.parse(raw.body) as Record<string, unknown> & { type: string; intent?: string; refund?: string; dispute?: string; status?: string }
    const at = Number(e.at ?? Date.now())
    switch (e.type) {
      case "payment_intent.succeeded":
      case "charge.succeeded":
      case "invoice.paid":
        return {
          type: "payment",
          movement: `${this.id}:${e.intent}`,
          rail: this.id,
          offerId: String(e.offerId),
          owner: e.owner as Record<string, string>,
          amountMinor: Number(e.amountMinor),
          taxMinor: Number(e.taxMinor ?? 0),
          ...(e.taxBehavior !== undefined ? { taxBehavior: e.taxBehavior as "inclusive" | "exclusive" } : {}),
          ...(e.discountMinor !== undefined ? { discountMinor: Number(e.discountMinor) } : {}),
          currency: String(e.currency),
          paidAt: at,
        }
      case "charge.refunded":
        return { type: "refund", movement: `${this.id}:${e.refund}`, rail: this.id, paymentMovement: `${this.id}:${e.intent}`, amountMinor: Number(e.amountMinor), at }
      case "refund.failed":
        return { type: "refund_reversed", movement: `${this.id}:${e.refund}`, rail: this.id, paymentMovement: `${this.id}:${e.intent}`, amountMinor: Number(e.amountMinor), at }
      case "dispute.opened":
      case "dispute.won":
      case "dispute.lost":
        // An inquiry moves no money: no fact, so nothing is frozen.
        if (typeof e.status === "string" && e.status.startsWith("warning_")) return null
        return {
          type: "dispute",
          movement: `${this.id}:${e.dispute}`,
          rail: this.id,
          paymentMovement: `${this.id}:${e.intent}`,
          status: e.type.slice("dispute.".length) as "opened" | "won" | "lost",
          amountMinor: Number(e.amountMinor),
          currency: String(e.currency),
          at,
        }
      default:
        return null
    }
  }
}
