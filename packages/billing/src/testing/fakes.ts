/**
 * In-memory stand-ins for the ports and a fake payment provider, for tests and
 * for a provider package's own conformance run. No network, no key, no model.
 */
import { fold, spendableBalance, type Lot, type WalletEvent } from "@agentproto/wallet"
import type { ClockPort, SettlementResult, StoragePort } from "@agentproto/wallet/ports"
import type { AccessRecord, BillingStateStore, DeferredFact, PeriodRecord } from "../ports.js"
import { createHmac, timingSafeEqual } from "node:crypto"
import type { SettlementEvents } from "../contract/settlement.js"
import type { BillingHandle } from "../define-billing-manifest.js"
import { assertKeyMatchesMode, type RailMode } from "../rails.js"
import { assertReturnUrl } from "../return-url.js"
import type {
  CatalogSyncReport,
  CheckoutOutcome,
  CheckoutRequest,
  PortalRequest,
  RailFact,
  SettlementCapabilities,
  SettlementProvider,
  WebhookRequest,
} from "../settlement.js"

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
  private deferred = new Map<string, Map<string, DeferredFact>>()
  async deferFact(paymentMovement: string, fact: DeferredFact): Promise<void> {
    const kept = this.deferred.get(paymentMovement) ?? new Map<string, DeferredFact>()
    kept.set(`${fact.type}:${fact.movement}:${fact.type === "dispute" ? fact.status : ""}`, { ...fact })
    this.deferred.set(paymentMovement, kept)
  }
  async takeDeferred(paymentMovement: string): Promise<DeferredFact[]> {
    const kept = [...(this.deferred.get(paymentMovement)?.values() ?? [])]
    this.deferred.delete(paymentMovement)
    return kept
  }
}

export interface FakeSettlementProviderOptions {
  /** Origins `createCheckout` and `createPortalSession` accept for their return URLs. Default: none. */
  allowedReturnOrigins?: readonly string[]
  /** The rail's secret key. `fk_test_...` or `fk_live_...` gives its mode, read by `check()`. */
  secretKey?: string
  /** The rail's mode. Default `test`. An event whose `livemode` disagrees throws. */
  mode?: RailMode
  /** Owner keys a checkout must carry. Default `["orgId"]`, the reference manifest's. */
  ownerKeys?: readonly string[]
  /** Override declared capabilities (to test a start-up check). */
  capabilities?: Partial<SettlementCapabilities>
}

const FAKE_CAPABILITIES: SettlementCapabilities = {
  oneTimePayments: true,
  buyerAmount: true,
  subscriptions: true,
  trials: true,
  discounts: true,
  moneyFacts: "self",
  refunds: "partial",
  refundReversals: true,
  disputes: true,
  checkout: true,
  portal: true,
  catalogSync: true,
  offSessionCharge: true,
  payouts: false,
  taxReported: true,
  balanceAuthority: "journal",
  remoteHolds: false,
}

/**
 * A payment provider with no network. Webhook bodies are JSON `{ type, ... }`;
 * the signature header is `x-fake-signature: hex(HMAC-SHA256(webhook secret, body))`.
 * Like a real rail it sends SEVERAL events for one money movement: both
 * `payment_intent.succeeded` and `charge.succeeded` normalise to the same movement.
 * `events()` is its factory of signed requests for `settlementProviderContractCases`.
 * Secrets live in private fields: `JSON.stringify` of the provider never shows them.
 */
export class FakeSettlementProvider implements SettlementProvider {
  readonly id: string
  readonly name = "Fake rail"
  readonly env: { secretKey: string; webhookSecret: string; mode: string }
  readonly capabilities: SettlementCapabilities
  readonly refunds: { movement: string; amountMinor: number; ref: string }[] = []
  readonly checkouts: { ref: string; offerId: string; owner: Record<string, string>; accountId: string }[] = []
  readonly portals: { accountId: string; returnUrl: string }[] = []
  /** Offer id to the projection pushed by `syncCatalog`. */
  readonly catalog = new Map<string, string>()
  /** Write calls made to the "rail" (refunds, checkouts, portal sessions, catalog writes). */
  railWrites = 0
  readonly #webhookSecret: string
  readonly #secretKey: string | undefined
  readonly #mode: RailMode
  readonly #allowedReturnOrigins: readonly string[]
  readonly #ownerKeys: readonly string[]
  constructor(webhookSecret: string, id = "fake", opts: FakeSettlementProviderOptions = {}) {
    this.id = id
    const up = id.toUpperCase()
    this.env = { secretKey: `${up}_SECRET_KEY`, webhookSecret: `${up}_WEBHOOK_SECRET`, mode: `${up}_MODE` }
    this.capabilities = { ...FAKE_CAPABILITIES, ...opts.capabilities }
    this.#webhookSecret = webhookSecret
    this.#secretKey = opts.secretKey
    this.#mode = opts.mode ?? "test"
    this.#allowedReturnOrigins = opts.allowedReturnOrigins ?? []
    this.#ownerKeys = opts.ownerKeys ?? ["orgId"]
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
    this.railWrites++
    return { ok: true, externalRef: `${this.id}:re_${this.refunds.length}` }
  }
  async check(): Promise<{ ok: boolean; reason?: string }> {
    if (this.#secretKey === undefined) return { ok: true }
    const keyMode: RailMode | null = this.#secretKey.startsWith("fk_live_") ? "live" : this.#secretKey.startsWith("fk_test_") ? "test" : null
    if (keyMode === null) return { ok: false, reason: `rail '${this.id}': the key is not a fake rail key` }
    try {
      assertKeyMatchesMode(this.#mode, keyMode, this.id)
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
    return { ok: true }
  }
  async createCheckout(req: CheckoutRequest): Promise<CheckoutOutcome> {
    assertReturnUrl(req.successUrl, this.#allowedReturnOrigins)
    assertReturnUrl(req.cancelUrl, this.#allowedReturnOrigins)
    for (const k of this.#ownerKeys) if (typeof req.owner[k] !== "string" || req.owner[k] === "") throw new Error(`checkout: owner key '${k}' is missing`)
    const ref = `cs_${this.checkouts.length + 1}_${req.accountId}`
    this.checkouts.push({ ref, offerId: req.offerId, owner: { ...req.owner }, accountId: req.accountId })
    this.railWrites++
    return { outcome: "redirect", url: `https://checkout.example.com/${ref}`, ref }
  }
  async createPortalSession(req: PortalRequest): Promise<{ url: string }> {
    assertReturnUrl(req.returnUrl, this.#allowedReturnOrigins)
    this.portals.push({ accountId: req.accountId, returnUrl: req.returnUrl })
    this.railWrites++
    return { url: `https://portal.example.com/${encodeURIComponent(req.accountId)}` }
  }
  async syncCatalog(manifest: BillingHandle, opts: { dryRun?: boolean } = {}): Promise<CatalogSyncReport> {
    const report: CatalogSyncReport = { created: [], updated: [], unchanged: [], degradations: [] }
    for (const offer of manifest.derived.offers.values()) {
      const projection = JSON.stringify(offer.price)
      const had = this.catalog.get(offer.id)
      const bucket = had === undefined ? report.created : had === projection ? report.unchanged : report.updated
      bucket.push(offer.id)
      if (!opts.dryRun && had !== projection) {
        this.catalog.set(offer.id, projection)
        this.railWrites++
      }
      // What the fake rail cannot carry, named.
      const conv = offer.convert ? manifest.derived.conversions.get(offer.convert) : undefined
      if (conv?.bonus) report.degradations.push({ offerId: offer.id, field: "conversion.bonus", reason: "the rail sells the price; the bonus lot is minted by the core" })
      if (offer.subscription?.anchor === "calendar") report.degradations.push({ offerId: offer.id, field: "subscription.anchor", reason: "the rail bills from the payment date" })
    }
    return report
  }
  #sign(body: string): string {
    return createHmac("sha256", this.#webhookSecret).update(body).digest("hex")
  }
  /** Build a signed request for an event. */
  signed(body: Record<string, unknown>): WebhookRequest {
    const text = JSON.stringify(body)
    return { body: text, headers: { "x-fake-signature": this.#sign(text) } }
  }
  /** The factory of signed requests the SET-* contract cases need. */
  events(): SettlementEvents {
    const intent = (paymentMovement: string) => paymentMovement.slice(`${this.id}:`.length)
    const live = this.#mode === "live"
    return {
      payment: s => this.signed({ type: "payment_intent.succeeded", intent: `pi_${s.ref}`, offerId: s.offerId, owner: s.owner, amountMinor: s.amountMinor, currency: s.currency, at: s.at, livemode: live }),
      paymentIncomplete: s => this.signed({ type: "charge.succeeded", intent: `pi_${s.ref}`, owner: s.owner, amountMinor: s.amountMinor, currency: s.currency, at: s.at, livemode: live }),
      checkoutCompleted: s => this.signed({ type: "checkout.completed", session: s.checkoutRef, amountMinor: s.amountMinor, currency: s.currency, at: s.at, livemode: live }),
      refund: s => this.signed({ type: "charge.refunded", intent: intent(s.paymentMovement), refund: `re_${s.ref}`, amountMinor: s.amountMinor, at: s.at }),
      refundPending: s => this.signed({ type: "refund.pending", intent: intent(s.paymentMovement), refund: `re_${s.ref}`, amountMinor: s.amountMinor, at: s.at }),
      refundFailed: s => this.signed({ type: "refund.failed", intent: intent(s.paymentMovement), refund: `re_${s.ref}`, amountMinor: s.amountMinor, at: s.at }),
      dispute: s => this.signed({ type: `dispute.${s.status}`, intent: intent(s.paymentMovement), dispute: `dp_${s.ref}`, amountMinor: s.amountMinor, currency: s.currency, at: s.at }),
      inquiry: s => this.signed({ type: "dispute.opened", status: "warning_needs_response", intent: intent(s.paymentMovement), dispute: `dp_${s.ref}`, amountMinor: s.amountMinor, currency: s.currency, at: s.at }),
      renewalFailed: s => this.signed({ type: "invoice.payment_failed", invoice: `in_${s.ref}`, offerId: s.offerId, owner: s.owner, at: s.at }),
      subscriptionEnded: s => this.signed({ type: "subscription.deleted", subscription: `sub_${s.ref}`, offerId: s.offerId, owner: s.owner, reason: s.reason, at: s.at }),
      noMoney: s => this.signed({ type: "customer.updated", id: s.ref, at: s.at }),
      badSignature: s => ({ body: JSON.stringify({ type: "payment_intent.succeeded", intent: `pi_${s.ref}`, at: s.at }), headers: { "x-fake-signature": "0".repeat(64) } }),
      wrongMode: s => this.signed({ type: "payment_intent.succeeded", intent: `pi_${s.ref}`, offerId: s.offerId, owner: s.owner, amountMinor: s.amountMinor, currency: s.currency, at: s.at, livemode: !live }),
    }
  }
  async verifyWebhook(raw: WebhookRequest): Promise<RailFact | null> {
    const given = Buffer.from(String(raw.headers["x-fake-signature"] ?? ""), "utf8")
    const expected = Buffer.from(this.#sign(raw.body), "utf8")
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error("webhook signature mismatch")
    const e = JSON.parse(raw.body) as Record<string, unknown> & { type: string; intent?: string; refund?: string; dispute?: string; status?: string }
    if (typeof e.livemode === "boolean" && e.livemode !== (this.#mode === "live")) throw new Error(`rail '${this.id}' is in ${this.#mode} mode: event of the other mode refused`)
    const at = Number(e.at ?? Date.now())
    switch (e.type) {
      case "payment_intent.succeeded":
      case "charge.succeeded":
      case "invoice.paid":
        return {
          type: "payment",
          movement: `${this.id}:${e.intent}`,
          rail: this.id,
          // An event without the offer is an incomplete fact: the core refuses it and lists the money as owed.
          offerId: e.offerId === undefined ? "" : String(e.offerId),
          owner: (e.owner ?? {}) as Record<string, string>,
          amountMinor: Number(e.amountMinor),
          taxMinor: Number(e.taxMinor ?? 0),
          ...(e.taxBehavior !== undefined ? { taxBehavior: e.taxBehavior as "inclusive" | "exclusive" } : {}),
          ...(e.discountMinor !== undefined ? { discountMinor: Number(e.discountMinor) } : {}),
          ...(typeof e.unsupported === "string" ? { unsupported: e.unsupported } : {}),
          currency: String(e.currency),
          paidAt: at,
        }
      case "checkout.completed": {
        const session = this.checkouts.find(c => c.ref === e.session)
        if (!session) return null
        return {
          type: "payment",
          movement: `${this.id}:pi_${session.ref}`,
          rail: this.id,
          offerId: session.offerId,
          owner: { ...session.owner },
          amountMinor: Number(e.amountMinor),
          taxMinor: 0,
          currency: String(e.currency),
          paidAt: at,
        }
      }
      case "charge.refunded":
        return { type: "refund", movement: `${this.id}:${e.refund}`, rail: this.id, paymentMovement: `${this.id}:${e.intent}`, amountMinor: Number(e.amountMinor), at }
      case "refund.pending":
        // A refund that may still fail is not a fact yet.
        return null
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
      case "invoice.payment_failed":
        return { type: "renewal_failed", movement: `${this.id}:${e.invoice}`, rail: this.id, offerId: String(e.offerId), owner: (e.owner ?? {}) as Record<string, string>, at }
      case "subscription.deleted":
        return {
          type: "subscription_ended",
          movement: `${this.id}:${e.subscription}`,
          rail: this.id,
          offerId: String(e.offerId),
          owner: (e.owner ?? {}) as Record<string, string>,
          reason: e.reason === "unpaid" ? "unpaid" : "canceled",
          at,
        }
      default:
        return null
    }
  }
}
