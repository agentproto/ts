/**
 * The Stripe `SettlementProvider`.
 *
 * Webhook side: verify the signature, guard the mode, turn the money events
 * into facts (`./translate.ts`). Call side: checkout, billing portal, refund,
 * catalog sync (`./calls.ts`, `./catalog.ts`), and `check()` against the
 * expected account. Off-session charges are not served (`charge` answers
 * `unsupported`: the AIP-49 port gives it no offer and no payer).
 */
import { assertKeyMatchesMode, railMode, type BillingHandle, type CreateProviderContext, type RailFact, type RailMode, type SettlementCapabilities, type SettlementProvider, type WebhookRequest } from "@agentproto/billing"
import { STRIPE_API_VERSION } from "./api-version.js"
import { accountProblem, createStripeCheckout, createStripePortalSession, refundStripePayment, type CallContext } from "./calls.js"
import { applyStripeCatalog, toStripeCatalog, type StripeCatalog, type StripeTaxBehavior } from "./catalog.js"
import type { StripeEventLike, StripeLike } from "./client.js"
import { DEFAULT_TOLERANCE_SEC, signatureHeader, verifyStripeSignature } from "./signature.js"
import { eventToFact } from "./translate.js"

/** Rail id of this provider, and the prefix of its movements (`stripe:pi_...`). */
export const STRIPE_RAIL = "stripe"

/** Variable names this provider reads. Names only, never values. */
export const STRIPE_ENV = { secretKey: "STRIPE_SECRET_KEY", webhookSecret: "STRIPE_WEBHOOK_SECRET", mode: "STRIPE_MODE" } as const

/** What this provider can do. Each flag matches a method that exists, or its absence (SET-6). */
export const STRIPE_CAPABILITIES: SettlementCapabilities = Object.freeze({
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
  offSessionCharge: false,
  payouts: false,
  taxReported: true,
  balanceAuthority: "journal",
  remoteHolds: false,
})

/**
 * Called for every recognised money event that does not become an applicable
 * fact. Persist it (a table, a queue, a ticket): a log line is not enough,
 * since for some events it is the only trace. Throwing makes the webhook
 * fail, so Stripe delivers it again.
 */
export type OnUnhandled = (event: StripeEventLike, reason: string) => void | Promise<void>

export interface StripeProviderOptions {
  /** A Stripe client (`new Stripe(key, { apiVersion: STRIPE_API_VERSION })`) or a test double. */
  client: StripeLike
  /** The manifest: what each offer costs and how it is sold (checkout, catalog). It needs a rail served by `stripe`. */
  manifest: BillingHandle
  /** The payer's owner keys (`payer.owner` of the manifest): each is written to and read from `agentproto_owner_<key>`. */
  ownerKeys: readonly string[]
  /** Origins (`https://shop.example.com`) the return URLs of a checkout or a portal session must have. */
  allowedReturnOrigins: readonly string[]
  /** Required: there is no silent default. */
  onUnhandled: OnUnhandled
  /** Only offers whose id starts with this prefix are ours; other payment events give no fact. */
  offerNamespace?: string
  /** The Stripe account id (`acct_...`) the key of each mode must belong to; `check()` reads it. */
  expectAccount?: { test?: string; live?: string }
  /** Stripe Tax: enabled on every checkout, with this tax behaviour on the prices. Absent: no automatic tax. */
  automaticTax?: { taxBehavior: StripeTaxBehavior }
  /** The manifest rail this provider serves. Default: the first rail whose provider is `stripe`. */
  rail?: string
  /** Signature timestamp tolerance, in seconds. Default 300. */
  toleranceSec?: number
  /** Clock in epoch ms. Default `Date.now`. */
  now?: () => number
}

export interface StripeProviderConfig extends StripeProviderOptions {
  /** `sk_test_...`, `rk_test_...`, `sk_live_...` or `rk_live_...`. */
  secretKey: string | undefined
  /** The endpoint signing secret (`whsec_...`). */
  webhookSecret: string | undefined
  mode: RailMode
}

/** The mode of a Stripe key from its prefix, or null when it is not a secret or restricted key. */
export function stripeKeyMode(key: string): RailMode | null {
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return "test"
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return "live"
  return null
}

export class StripeEventError extends Error {
  override name = "StripeEventError"
}

const UNSUPPORTED = { ok: false, error: "unsupported" } as const

const CLIENT_METHODS: [string, (c: StripeLike) => unknown][] = [
  ["invoicePayments.list", c => c.invoicePayments?.list],
  ["accounts.retrieveCurrent", c => c.accounts?.retrieveCurrent],
  ["refunds.create", c => c.refunds?.create],
  ["checkout.sessions.create", c => c.checkout?.sessions?.create],
  ["billingPortal.sessions.create", c => c.billingPortal?.sessions?.create],
  ["products.list", c => c.products?.list],
  ["products.create", c => c.products?.create],
  ["products.update", c => c.products?.update],
  ["prices.list", c => c.prices?.list],
  ["prices.create", c => c.prices?.create],
]

/** Stripe metadata keys are at most 40 characters: `agentproto_owner_` leaves 23 for the owner key. */
const MAX_OWNER_KEY = 40 - "agentproto_owner_".length

/** Build the provider from explicit values. Never logs nor exposes the key or the secret. */
export function createStripeProvider(cfg: StripeProviderConfig): SettlementProvider {
  if (typeof cfg.onUnhandled !== "function") throw new Error("billing-stripe: the 'onUnhandled' option is required (persist an alert there)")
  if (!cfg.client || typeof cfg.client !== "object") throw new Error("billing-stripe: the 'client' option is required (a Stripe client)")
  const lacking = CLIENT_METHODS.filter(([, get]) => typeof get(cfg.client) !== "function").map(([name]) => name)
  if (lacking.length > 0) throw new Error(`billing-stripe: the 'client' option lacks ${lacking.join(", ")} (a Stripe client)`)
  if (!Array.isArray(cfg.ownerKeys) || cfg.ownerKeys.length === 0) throw new Error("billing-stripe: the 'ownerKeys' option is required (the manifest's payer.owner keys)")
  const long = cfg.ownerKeys.filter(k => typeof k !== "string" || k === "" || k.length > MAX_OWNER_KEY)
  if (long.length > 0) throw new Error(`billing-stripe: owner keys must be 1 to ${MAX_OWNER_KEY} characters (Stripe metadata keys): ${long.map(k => `'${String(k)}'`).join(", ")}`)
  if (!Array.isArray(cfg.allowedReturnOrigins) || cfg.allowedReturnOrigins.length === 0) throw new Error("billing-stripe: the 'allowedReturnOrigins' option is required (the origins return URLs must have)")
  if (!cfg.manifest || typeof cfg.manifest !== "object" || !cfg.manifest.derived) throw new Error("billing-stripe: the 'manifest' option is required (a loaded billing manifest)")
  const mode = cfg.mode
  const now = cfg.now ?? Date.now
  const tolerance = cfg.toleranceSec ?? DEFAULT_TOLERANCE_SEC
  // Kept in this closure only: JSON.stringify(provider) and the registry never see them.
  const secretKey = cfg.secretKey ?? ""
  const webhookSecret = cfg.webhookSecret ?? ""
  const client = cfg.client
  const onUnhandled = cfg.onUnhandled
  const expected = cfg.expectAccount?.[mode]
  // Pure, computed once; throws now when the manifest has no Stripe rail.
  const catalog: StripeCatalog = toStripeCatalog(cfg.manifest, {
    ...(cfg.rail !== undefined ? { rail: cfg.rail } : {}),
    ...(cfg.automaticTax ? { taxBehavior: cfg.automaticTax.taxBehavior } : {}),
    ...(cfg.offerNamespace !== undefined ? { offerNamespace: cfg.offerNamespace } : {}),
  })
  const translate = {
    rail: STRIPE_RAIL,
    ownerKeys: [...cfg.ownerKeys],
    ...(cfg.offerNamespace !== undefined ? { offerNamespace: cfg.offerNamespace } : {}),
    client,
    unhandled: async (event: StripeEventLike, reason: string) => {
      await onUnhandled(event, reason)
    },
  }
  const calls: CallContext = {
    rail: STRIPE_RAIL,
    client,
    catalog: () => catalog,
    ownerKeys: [...cfg.ownerKeys],
    allowedReturnOrigins: [...cfg.allowedReturnOrigins],
    ...(cfg.offerNamespace !== undefined ? { offerNamespace: cfg.offerNamespace } : {}),
    ...(cfg.automaticTax ? { automaticTax: { ...cfg.automaticTax } } : {}),
    secrets: () => [secretKey, webhookSecret],
  }

  const keyProblem = (): string | null => {
    if (secretKey === "") return `rail '${STRIPE_RAIL}': ${STRIPE_ENV.secretKey} is not set`
    // Without it every webhook fails closed: the rail must not read healthy.
    if (webhookSecret === "") return `rail '${STRIPE_RAIL}': ${STRIPE_ENV.webhookSecret} is not set`
    const keyMode = stripeKeyMode(secretKey)
    if (keyMode === null) return `rail '${STRIPE_RAIL}': ${STRIPE_ENV.secretKey} is not a secret or restricted key (sk_ or rk_)`
    try {
      assertKeyMatchesMode(mode, keyMode, STRIPE_RAIL)
    } catch (e) {
      return (e as Error).message
    }
    return null
  }

  const provider: SettlementProvider = {
    id: STRIPE_RAIL,
    name: "Stripe",
    env: { ...STRIPE_ENV },
    capabilities: { ...STRIPE_CAPABILITIES },
    async charge() {
      // Off-session charges need the offer and the payer, which the AIP-49 port does not carry.
      return { ...UNSUPPORTED }
    },
    async pay() {
      return { ...UNSUPPORTED }
    },
    async check() {
      const problem = keyProblem() ?? (expected !== undefined ? await accountProblem(calls, expected) : null)
      return problem === null ? { ok: true } : { ok: false, reason: problem }
    },
    async verifyWebhook(raw: WebhookRequest): Promise<RailFact | null> {
      verifyStripeSignature(raw.body, signatureHeader(raw.headers), webhookSecret, now(), tolerance)
      let event: StripeEventLike
      try {
        event = JSON.parse(raw.body) as StripeEventLike
      } catch {
        throw new StripeEventError("stripe webhook: the body is not JSON")
      }
      if (!event || typeof event !== "object" || typeof event.type !== "string" || !event.data || typeof event.data.object !== "object" || typeof event.created !== "number") {
        throw new StripeEventError("stripe webhook: the body is not a Stripe event")
      }
      if (event.api_version !== STRIPE_API_VERSION) {
        throw new StripeEventError(`stripe webhook: event ${event.id} has API version '${String(event.api_version)}', this adapter reads '${STRIPE_API_VERSION}': set the endpoint to that version`)
      }
      if (event.livemode !== (mode === "live")) {
        throw new StripeEventError(`rail '${STRIPE_RAIL}' is in ${mode} mode: event ${event.id} of the other mode refused`)
      }
      return eventToFact(event, translate)
    },
    refund: (movement, amountMinor, ref) => refundStripePayment(calls, movement, amountMinor, ref),
    createCheckout: req => createStripeCheckout(calls, req),
    createPortalSession: req => createStripePortalSession(calls, req),
    async syncCatalog(manifest, opts = {}) {
      const target =
        manifest === cfg.manifest
          ? catalog
          : toStripeCatalog(manifest, {
              ...(cfg.rail !== undefined ? { rail: cfg.rail } : {}),
              ...(cfg.automaticTax ? { taxBehavior: cfg.automaticTax.taxBehavior } : {}),
              ...(cfg.offerNamespace !== undefined ? { offerNamespace: cfg.offerNamespace } : {}),
            })
      return applyStripeCatalog(client, target, opts)
    },
  }
  return provider
}

/** What `createProvider` reads from `providerOptions.stripe`: the options, with the client optional. */
export type StripeRegistryOptions = Omit<StripeProviderOptions, "client"> & { client?: StripeLike }

type StripeSdk = new (key: string, config: { apiVersion: string }) => StripeLike

/** Import the `stripe` SDK (an optional peer), with a clear message when it is not installed. */
export async function loadStripeSdk(importer: () => Promise<unknown> = () => import("stripe")): Promise<StripeSdk> {
  let mod: unknown
  try {
    mod = await importer()
  } catch (cause) {
    throw new Error("billing-stripe: the 'stripe' package is not installed; install stripe@>=23 next to @agentproto/billing-stripe, or pass a 'client' in providerOptions.stripe", { cause })
  }
  const m = mod as { default?: unknown; Stripe?: unknown }
  const Sdk = typeof m.default === "function" ? m.default : typeof m.Stripe === "function" ? m.Stripe : typeof mod === "function" ? mod : null
  if (Sdk === null) throw new Error("billing-stripe: the 'stripe' package exports no Stripe class")
  return Sdk as StripeSdk
}

/**
 * Registry entry point: reads `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
 * `STRIPE_MODE` from `ctx.env`, the rest from `ctx.options`
 * (`BillingRegistryOptions.providerOptions.stripe`). Without a `client`, the
 * `stripe` SDK is imported and built with the key, at `STRIPE_API_VERSION`.
 */
export async function createProvider(ctx: CreateProviderContext): Promise<SettlementProvider> {
  const options = (ctx.options ?? {}) as Partial<StripeRegistryOptions>
  const secretKey = ctx.env[STRIPE_ENV.secretKey]
  const mode = railMode(ctx.env[STRIPE_ENV.mode])
  let client = options.client
  if (client === undefined) {
    const Sdk = await loadStripeSdk()
    // Without a key there is nothing to call with; check() names the missing variable.
    client = secretKey ? new Sdk(secretKey, { apiVersion: STRIPE_API_VERSION }) : unconfiguredClient()
  }
  return createStripeProvider({
    ...(options as StripeProviderOptions),
    client,
    secretKey,
    webhookSecret: ctx.env[STRIPE_ENV.webhookSecret],
    mode,
  })
}

/** A client whose every call rejects, naming the missing key. */
function unconfiguredClient(): StripeLike {
  const fail = async (): Promise<never> => {
    throw new Error(`billing-stripe: ${STRIPE_ENV.secretKey} is not set`)
  }
  return {
    invoicePayments: { list: fail },
    accounts: { retrieveCurrent: fail },
    refunds: { create: fail },
    checkout: { sessions: { create: fail } },
    billingPortal: { sessions: { create: fail } },
    products: { list: fail, create: fail, update: fail },
    prices: { list: fail, create: fail },
  }
}
