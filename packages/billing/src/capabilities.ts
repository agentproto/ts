/**
 * Start-up check of what the manifest sells against what its rails can do
 * (SET-7). A manifest that sells an offer its rail cannot serve refuses to
 * start, naming the offer, the rail and the capability, instead of failing at
 * the first checkout or, worse, at the first refund.
 */
import type { BillingHandle } from "./define-billing-manifest.js"
import type { SettlementCapabilities, SettlementProvider } from "./settlement.js"
import type { Offer } from "./types.js"

/** The rails an offer is sold on: the rail of its conversion for `prepaid-pool`, every declared rail otherwise. */
export function railsOfOffer(manifest: BillingHandle, offer: Offer): string[] {
  if (offer.price.model === "prepaid-pool") {
    const rail = offer.convert ? manifest.derived.conversions.get(offer.convert)?.rail : undefined
    return rail ? [rail] : []
  }
  return manifest.rails.map(r => r.id)
}

/** What an offer needs from a rail, as `[capability, why]` pairs. Vendor models (`x-...`) need nothing the core knows. */
function needs(offer: Offer): [keyof SettlementCapabilities, string][] {
  const out: [keyof SettlementCapabilities, string][] = []
  const model = offer.price.model
  if (model.startsWith("x-")) return out
  if (model === "subscription") {
    out.push(["subscriptions", "a subscription offer"])
    if (offer.subscription?.trial !== undefined) out.push(["trials", "subscription.trial"])
  } else {
    out.push(["oneTimePayments", `a ${model} offer`])
  }
  if (offer.price.amountMinor === "buyer") out.push(["buyerAmount", "amountMinor: buyer"])
  if (offer.discounts === "allow") out.push(["discounts", "discounts: allow"])
  return out
}

/** Every offer a rail does not serve, one line each. Empty when the manifest can start. */
export function railCapabilityProblems(manifest: BillingHandle, providers: readonly SettlementProvider[]): string[] {
  const byId = new Map(providers.map(p => [p.id, p]))
  const problems: string[] = []
  const missing = new Set<string>()
  for (const offer of manifest.derived.offers.values()) {
    for (const railId of railsOfOffer(manifest, offer)) {
      const rail = manifest.rails.find(r => r.id === railId)
      const provider = byId.get(rail?.provider ?? railId)
      if (!provider) {
        if (!missing.has(railId)) problems.push(`rail '${railId}' has no provider ('${rail?.provider ?? railId}')`)
        missing.add(railId)
        continue
      }
      const caps = provider.capabilities
      if (!caps) {
        problems.push(`rail '${railId}': provider '${provider.id}' declares no capabilities`)
        continue
      }
      for (const [flag, why] of needs(offer)) {
        if (caps[flag] !== true) problems.push(`offer '${offer.id}' on rail '${railId}' needs '${flag}' (${why})`)
      }
      if (offer.price.model.startsWith("x-")) continue
      // AIP-74: a product MUST NOT sell an offer whose refund path it cannot run.
      if (caps.refunds === "none") {
        if (caps.moneyFacts !== "delegated") {
          problems.push(`offer '${offer.id}' on rail '${railId}' has no refund path: 'refunds' is 'none' and the money facts are not delegated`)
        } else {
          const from = caps.moneyFactsFrom
          const delegate = from ? byId.get(from) : undefined
          if (!delegate) problems.push(`offer '${offer.id}' on rail '${railId}' delegates its money facts to '${from ?? ""}', which is not a provider here ('refunds' is 'none')`)
          else if (delegate.capabilities?.refunds === "none") problems.push(`offer '${offer.id}' on rail '${railId}': its delegate '${from}' cannot refund either ('refunds' is 'none')`)
        }
      }
    }
  }
  return problems
}

/** Throws, naming every offer, rail and capability that does not match. Call it at start-up, after the providers resolve. */
export function assertRailCapabilities(manifest: BillingHandle, providers: readonly SettlementProvider[]): void {
  const problems = railCapabilityProblems(manifest, providers)
  if (problems.length > 0) throw new Error(`billing '${manifest.name}': the rails do not serve every offer: ${problems.join("; ")}`)
}
