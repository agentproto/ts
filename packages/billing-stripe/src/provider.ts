/**
 * The Stripe `SettlementProvider`, webhook side.
 *
 * What this version does: verify the signature, guard the mode, turn the
 * money events into facts (`./translate.ts`). What it does not do yet, and
 * declares so in its capabilities: refunds, checkout, portal and catalog sync
 * (`false` / `none`), and off-session charges (`charge` answers
 * `unsupported`: the AIP-49 port gives it no offer and no payer).
 */
import { assertKeyMatchesMode, railMode, type CreateProviderContext, type RailFact, type RailMode, type SettlementCapabilities, type SettlementProvider, type WebhookRequest } from "@agentproto/billing"
import { STRIPE_API_VERSION } from "./api-version.js"
import type { StripeEventLike, StripeLike } from "./client.js"
import { DEFAULT_TOLERANCE_SEC, signatureHeader, verifyStripeSignature } from "./signature.js"
import { eventToFact } from "./translate.js"

/** Rail id of this provider, and the prefix of its movements (`stripe:pi_...`). */
export const STRIPE_RAIL = "stripe"

/** Variable names this provider reads. Names only, never values. */
export const STRIPE_ENV = { secretKey: "STRIPE_SECRET_KEY", webhookSecret: "STRIPE_WEBHOOK_SECRET", mode: "STRIPE_MODE" } as const

/** What this version can do. Each flag matches a method that exists, or its absence (SET-6). */
export const STRIPE_CAPABILITIES: SettlementCapabilities = Object.freeze({
  oneTimePayments: true,
  buyerAmount: true,
  subscriptions: true,
  trials: true,
  discounts: true,
  moneyFacts: "self",
  refunds: "none",
  refundReversals: true,
  disputes: true,
  checkout: false,
  portal: false,
  catalogSync: false,
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
  /** A Stripe client (`new Stripe(key)`) or a test double. Used only to read the payments of an invoice. */
  client: StripeLike
  /** The payer's owner keys (`payer.owner` of the manifest): each is read from `agentproto_owner_<key>`. */
  ownerKeys: readonly string[]
  /** Required: there is no silent default. */
  onUnhandled: OnUnhandled
  /** Only offers whose id starts with this prefix are ours; other payment events give no fact. */
  offerNamespace?: string
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

/** Build the provider from explicit values. Never logs nor exposes the key or the secret. */
export function createStripeProvider(cfg: StripeProviderConfig): SettlementProvider {
  if (typeof cfg.onUnhandled !== "function") throw new Error("billing-stripe: the 'onUnhandled' option is required (persist an alert there)")
  if (!cfg.client || typeof cfg.client.invoicePayments?.list !== "function") throw new Error("billing-stripe: the 'client' option is required (a Stripe client)")
  if (!Array.isArray(cfg.ownerKeys) || cfg.ownerKeys.length === 0) throw new Error("billing-stripe: the 'ownerKeys' option is required (the manifest's payer.owner keys)")
  const mode = cfg.mode
  const now = cfg.now ?? Date.now
  const tolerance = cfg.toleranceSec ?? DEFAULT_TOLERANCE_SEC
  // Kept in this closure only: JSON.stringify(provider) and the registry never see them.
  const secretKey = cfg.secretKey ?? ""
  const webhookSecret = cfg.webhookSecret ?? ""
  const client = cfg.client
  const onUnhandled = cfg.onUnhandled
  const translate = {
    rail: STRIPE_RAIL,
    ownerKeys: [...cfg.ownerKeys],
    ...(cfg.offerNamespace !== undefined ? { offerNamespace: cfg.offerNamespace } : {}),
    client,
    unhandled: async (event: StripeEventLike, reason: string) => {
      await onUnhandled(event, reason)
    },
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
      const problem = keyProblem()
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
  }
  return provider
}

/**
 * Registry entry point: reads `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
 * `STRIPE_MODE` from `ctx.env`, the rest from `ctx.options`
 * (`BillingRegistryOptions.providerOptions.stripe`). This version needs the
 * client in the options.
 */
export function createProvider(ctx: CreateProviderContext): SettlementProvider {
  const options = (ctx.options ?? {}) as Partial<StripeProviderOptions>
  return createStripeProvider({
    ...(options as StripeProviderOptions),
    secretKey: ctx.env[STRIPE_ENV.secretKey],
    webhookSecret: ctx.env[STRIPE_ENV.webhookSecret],
    mode: railMode(ctx.env[STRIPE_ENV.mode]),
  })
}
