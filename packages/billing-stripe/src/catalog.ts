/**
 * The Stripe catalog of a manifest: a pure projection (`toStripeCatalog`) and
 * its application (`applyStripeCatalog`, behind `syncCatalog`).
 *
 * Projection rules (AIP-74 Adapters, AIP-52): the manifest wins, the offer is
 * not mutated, and what Stripe cannot carry is a named degradation. One
 * product per offer under a stable id; one price per offer with a fixed
 * amount, found again by its `lookup_key`. An offer whose amount the buyer
 * chooses has a product and no price: its checkout sends `price_data`.
 *
 * Application rules: a price is never edited nor deleted. A price that no
 * longer matches the manifest is replaced by a new price that takes over its
 * lookup key (`transfer_lookup_key`); the old one stays, for the
 * subscriptions that still bill on it. A dry run only reads.
 */
import { createHash } from "node:crypto"
import { railsOfOffer, type BillingHandle, type CatalogDegradation, type CatalogSyncReport, type Offer } from "@agentproto/billing"
import { refId, type StripeLike, type StripePriceLike, type StripeProductLike } from "./client.js"

/** Metadata key of the product tag (`rails[].productTag`) on the products and prices this adapter writes. */
export const PRODUCT_TAG_KEY = "agentproto_product"

/** Stripe's longest trial, in days. */
const MAX_TRIAL_DAYS = 730
/** Stripe's longest billing interval: three years. */
const MAX_INTERVAL_DAYS: Record<"week" | "month" | "year", number> = { week: 156, month: 36, year: 3 }

export type StripeTaxBehavior = "inclusive" | "exclusive"

export interface StripeCatalogProduct {
  offerId: string
  /** Stable id, set at creation: the product is found again by it. */
  id: string
  name: string
  metadata: Record<string, string>
}

export interface StripeCatalogPrice {
  offerId: string
  lookupKey: string
  /** The product id. */
  product: string
  /** Lower case, as Stripe returns it. */
  currency: string
  unitAmount: number
  recurring?: { interval: "week" | "month" | "year"; interval_count: number }
  taxBehavior?: StripeTaxBehavior
  metadata: Record<string, string>
}

/** How one offer is sold on Stripe. */
export interface StripeOfferProjection {
  offerId: string
  mode: "payment" | "subscription"
  product: StripeCatalogProduct
  /** The price of an offer with a fixed amount. */
  price?: StripeCatalogPrice
  /** An offer whose amount the buyer chooses: its bounds (absent: unbounded). */
  buyer?: { currency: string; minMinor?: number; maxMinor?: number }
  /** Whole days of `subscription.trial`, when it has one that Stripe can carry. */
  trialDays?: number
  /** Set when the trial cannot be carried: a checkout of this offer is refused. */
  trialProblem?: string
  allowPromotionCodes: boolean
}

export interface StripeCatalog {
  /** The manifest rail this catalog is for. */
  rail: string
  offers: StripeOfferProjection[]
  degradations: CatalogDegradation[]
}

export interface ToStripeCatalogOptions {
  /** The manifest rail served by this provider. Default: the first rail whose provider is `stripe`. */
  rail?: string
  /** Tax behaviour set on every price (with automatic tax). Absent: left to the account's default. */
  taxBehavior?: StripeTaxBehavior
  /** Offers outside this prefix are not projected (their payments would give no fact). */
  offerNamespace?: string
}

/** The manifest rail served by the Stripe provider: `rail` when given, else the first whose provider (or id) is `stripe`. */
export function stripeRailOf(manifest: BillingHandle, rail?: string): string {
  const found = rail !== undefined ? manifest.rails.find(r => r.id === rail) : manifest.rails.find(r => (r.provider ?? r.id) === "stripe")
  if (!found) throw new Error(`billing '${manifest.name}': no rail ${rail !== undefined ? `'${rail}'` : "served by the 'stripe' provider"} in the manifest`)
  return found.id
}

/**
 * Whole days of an ISO 8601 duration, or the reason it has none: Stripe
 * counts a trial in days, so months, years and hours are not carried.
 */
export function trialDaysOf(duration: string): { days: number } | { problem: string } {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(duration)
  if (!m || duration === "P" || duration.endsWith("T")) return { problem: `'${duration}' is not an ISO 8601 duration` }
  const [, y, mo, w, d, h, mi, s] = m.map(v => (v === undefined ? 0 : Number(v)))
  if (y! > 0 || mo! > 0) return { problem: `'${duration}' counts months or years, which are not a whole number of days` }
  if (h! > 0 || mi! > 0 || s! > 0) return { problem: `'${duration}' is not a whole number of days` }
  const days = w! * 7 + d!
  if (days < 1) return { problem: `'${duration}' is shorter than a day` }
  if (days > MAX_TRIAL_DAYS) return { problem: `'${duration}' is longer than Stripe's ${MAX_TRIAL_DAYS} days` }
  return { days }
}

const slug = (v: string): string => v.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")

function projectOffer(manifest: BillingHandle, offer: Offer, rail: string, tag: string | undefined, opts: ToStripeCatalogOptions, out: CatalogDegradation[]): StripeOfferProjection | null {
  const degrade = (field: string, reason: string) => out.push({ offerId: offer.id, field, reason })
  const price = offer.price as Record<string, unknown> & { model: string }
  if (price.model.startsWith("x-")) {
    degrade("price.model", `the vendor model '${price.model}' is not sold on Stripe`)
    return null
  }
  if (opts.offerNamespace !== undefined && !offer.id.startsWith(opts.offerNamespace)) {
    degrade("id", `outside offerNamespace '${opts.offerNamespace}': its payments would give no fact`)
    return null
  }
  const metadata: Record<string, string> = { agentproto_offer: offer.id, ...(tag !== undefined ? { [PRODUCT_TAG_KEY]: tag } : {}) }
  const product: StripeCatalogProduct = { offerId: offer.id, id: tag !== undefined ? `ap_${slug(tag)}_${offer.id}` : `ap_${offer.id}`, name: offer.id, metadata }
  const currency = String(price.currency).toLowerCase()
  const proj: StripeOfferProjection = { offerId: offer.id, mode: price.model === "subscription" ? "subscription" : "payment", product, allowPromotionCodes: offer.discounts === "allow" }

  if (price.amountMinor === "buyer") {
    proj.buyer = { currency, ...(typeof price.minMinor === "number" ? { minMinor: price.minMinor } : {}), ...(typeof price.maxMinor === "number" ? { maxMinor: price.maxMinor } : {}) }
  } else {
    const lookupKey = offer.rail?.[rail]?.lookupKey ?? (tag !== undefined ? `${tag}:${offer.id}` : offer.id)
    const p: StripeCatalogPrice = { offerId: offer.id, lookupKey, product: product.id, currency, unitAmount: price.amountMinor as number, metadata: { ...metadata } }
    if (opts.taxBehavior !== undefined) p.taxBehavior = opts.taxBehavior
    if (price.model === "subscription") {
      const interval = price.interval as "week" | "month" | "year"
      const count = typeof price.intervalCount === "number" ? price.intervalCount : 1
      if (count > MAX_INTERVAL_DAYS[interval]) {
        degrade("price.intervalCount", `every ${count} ${interval}s is longer than Stripe's three years: the offer is not sold on Stripe`)
        return null
      }
      p.recurring = { interval, interval_count: count }
    }
    proj.price = p
  }

  for (const inc of offer.includes ?? []) {
    if (!("amountMinor" in inc)) continue
    degrade("includes", `Stripe sells the price only: the ${inc.amountMinor} included '${inc.feature}' credits are granted by the core from the payment fact`)
    if (inc.rollover === "unbounded") degrade("includes.rollover", `Stripe has no rollover: the core carries the unused '${inc.feature}' credits over`)
  }
  const bonus = offer.convert ? manifest.conversions?.find(c => c.id === offer.convert)?.bonus : undefined
  if (bonus) degrade("conversion.bonus", "Stripe sells the price only: the bonus lot is minted by the core")
  const sub = offer.subscription
  if (sub) {
    if (sub.anchor === "calendar") degrade("subscription.anchor", "Stripe bills from the payment date: only the payment anchor is projected")
    if (sub.onUpgrade === "prorate") degrade("subscription.onUpgrade", "a proration invoice is not the price: the core refuses it and lists it as owed")
    if (sub.trial !== undefined) {
      const t = trialDaysOf(sub.trial)
      if ("days" in t) proj.trialDays = t.days
      else {
        proj.trialProblem = t.problem
        degrade("subscription.trial", `${t.problem}: a checkout of this offer is refused`)
      }
    }
  }
  return proj
}

/**
 * The Stripe catalog of the offers sold on the manifest's Stripe rail. Pure:
 * no credentials, no call, the manifest is not mutated.
 */
export function toStripeCatalog(manifest: BillingHandle, opts: ToStripeCatalogOptions = {}): StripeCatalog {
  const rail = stripeRailOf(manifest, opts.rail)
  const tag = manifest.rails.find(r => r.id === rail)?.productTag
  const degradations: CatalogDegradation[] = []
  const offers: StripeOfferProjection[] = []
  for (const offer of manifest.derived.offers.values()) {
    if (!railsOfOffer(manifest, offer).includes(rail)) continue
    const p = projectOffer(manifest, offer, rail, tag, opts, degradations)
    if (p) offers.push(p)
  }
  return { rail, offers, degradations }
}

/** Does a Stripe price carry exactly what the projection asks? */
export function priceMatches(have: StripePriceLike, want: StripeCatalogPrice): boolean {
  if (!have.active || have.lookup_key !== want.lookupKey) return false
  if (refId(have.product) !== want.product || have.currency !== want.currency || have.unit_amount !== want.unitAmount) return false
  const r = have.recurring
  if (want.recurring === undefined ? r !== null && r !== undefined : !r || r.interval !== want.recurring.interval || r.interval_count !== want.recurring.interval_count) return false
  if (want.taxBehavior !== undefined && have.tax_behavior !== want.taxBehavior) return false
  // A price is immutable: metadata of an older projection is only refreshed by a new price.
  return Object.entries(want.metadata).every(([k, v]) => have.metadata?.[k] === v)
}

function productMatches(have: StripeProductLike, want: StripeCatalogProduct): boolean {
  if (!have.active || have.name !== want.name) return false
  return Object.entries(want.metadata).every(([k, v]) => have.metadata?.[k] === v)
}

const chunks = <T>(xs: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))

/** An idempotency key derived from what is written: a retried sync after a crash writes once. */
const idemKey = (what: string, body: unknown): string => `agentproto-catalog-${what}-${createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 32)}`

/** Read the products and prices of a catalog: `products.list` by ids, `prices.list` by lookup keys (ten per call, Stripe's limit). */
export async function readStripeCatalog(client: StripeLike, catalog: StripeCatalog): Promise<{ products: Map<string, StripeProductLike>; prices: Map<string, StripePriceLike> }> {
  const products = new Map<string, StripeProductLike>()
  for (const ids of chunks(catalog.offers.map(o => o.product.id), 100)) {
    for (const p of (await client.products.list({ ids, limit: 100 })).data) products.set(p.id, p)
  }
  const prices = new Map<string, StripePriceLike>()
  const keys = catalog.offers.flatMap(o => (o.price ? [o.price.lookupKey] : []))
  for (const lookup_keys of chunks(keys, 10)) {
    for (const p of (await client.prices.list({ lookup_keys, limit: 100 })).data) if (p.lookup_key) prices.set(p.lookup_key, p)
  }
  return { products, prices }
}

/** Apply a catalog: create what is missing, replace a price that changed, never delete. `dryRun` only reads. */
export async function applyStripeCatalog(client: StripeLike, catalog: StripeCatalog, opts: { dryRun?: boolean } = {}): Promise<CatalogSyncReport> {
  const report: CatalogSyncReport = { created: [], updated: [], unchanged: [], degradations: [...catalog.degradations] }
  const have = await readStripeCatalog(client, catalog)
  const write = !opts.dryRun
  for (const o of catalog.offers) {
    let created = false
    let updated = false
    const prod = have.products.get(o.product.id)
    if (!prod) {
      created = true
      if (write) {
        const body = { id: o.product.id, name: o.product.name, metadata: o.product.metadata }
        await client.products.create(body, { idempotencyKey: idemKey("product", body) })
      }
    } else if (!productMatches(prod, o.product)) {
      updated = true
      if (write) {
        const body = { name: o.product.name, active: true, metadata: o.product.metadata }
        await client.products.update(o.product.id, body, { idempotencyKey: idemKey("product-update", { id: o.product.id, ...body }) })
      }
    }
    if (o.price) {
      const current = have.prices.get(o.price.lookupKey)
      if (!current || !priceMatches(current, o.price)) {
        if (current) updated = true
        else created = true
        if (write) {
          const body = {
            product: o.price.product,
            currency: o.price.currency,
            unit_amount: o.price.unitAmount,
            lookup_key: o.price.lookupKey,
            // The new price takes the key over from the old one, atomically; the old one is kept.
            transfer_lookup_key: true,
            metadata: o.price.metadata,
            ...(o.price.recurring ? { recurring: o.price.recurring } : {}),
            ...(o.price.taxBehavior ? { tax_behavior: o.price.taxBehavior } : {}),
          }
          await client.prices.create(body, { idempotencyKey: idemKey("price", body) })
        }
      }
    }
    ;(created ? report.created : updated ? report.updated : report.unchanged).push(o.offerId)
  }
  return report
}
