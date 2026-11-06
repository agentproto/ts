import type { LedgerGrant } from "./ledger.js"

/** The two shadow permission checks a delivery observes. Neither can change
 *  what is delivered; the result is only recorded on the ledger line. */
export type DeliveryGrantAction = "delivery:publish" | "delivery:wake"

/** The capability facts a producer declares about itself. This mirrors the
 *  sentinel provider capabilities without depending on that package. */
export interface DeliveryGrantCapabilities {
  /** Subject schemes the producer may publish, for example `["github"]`.
   *  `["*"]` matches every subject. */
  readonly subjects: readonly string[]
}

/** A producer as the grant evaluator sees it. Accessing a capability may
 *  throw (a provider whose capabilities are unavailable); the evaluator
 *  treats that as `error`. */
export interface DeliveryGrantProducer {
  readonly capabilities?: DeliveryGrantCapabilities | null
}

export type DeliveryGrantDecision = "allow" | "deny" | "unknown"

/** A shadow decision function. Synchronous by contract: the delivery path
 *  never awaits it, so a slow decision cannot delay delivery. A throw is
 *  recorded as `error` and never escapes. */
export type DeliveryGrantDecider = (
  producer: DeliveryGrantProducer,
  action: DeliveryGrantAction,
  resource: string,
) => DeliveryGrantDecision

/** True when `subject` falls under a declared capability. A capability may
 *  name a scheme (`github`), a subject prefix (`github:acme`) or the `*`
 *  wildcard. The match requires a boundary so `github` does not match
 *  `githubfoo:...`. */
export function subjectMatchesCapability(subject: string, capability: string): boolean {
  if (capability === "*") return true
  if (capability.length === 0) return false
  if (subject === capability) return true
  if (!subject.startsWith(capability)) return false
  const next = subject.charAt(capability.length)
  return next === ":" || next === "/" || next === "#" || next === "."
}

/** The default shadow decider: a producer with no declared capabilities is
 *  `unknown`, never `deny`. A producer that declares subjects may publish a
 *  covered subject and wake the target it just routed to. */
export function capabilityGrantDecider(
  producer: DeliveryGrantProducer,
  action: DeliveryGrantAction,
  resource: string,
): DeliveryGrantDecision {
  const subjects = producer.capabilities?.subjects
  if (!subjects || subjects.length === 0) return "unknown"
  if (action === "delivery:publish") {
    return subjects.some(capability => subjectMatchesCapability(resource, capability)) ? "allow" : "deny"
  }
  return "allow"
}

/** Fold the per-action decisions into the single verdict written to the
 *  ledger. A deny always wins; then an error; `allow` only when every
 *  decision allowed. */
export function combineGrantDecisions(decisions: readonly LedgerGrant[]): LedgerGrant {
  if (decisions.includes("deny")) return "deny"
  if (decisions.includes("error")) return "error"
  if (decisions.length > 0 && decisions.every(decision => decision === "allow")) return "allow"
  return "unknown"
}

export interface ShadowDeliveryGrantInput {
  producer: DeliveryGrantProducer
  subject: string
  target: string
  /** Test seam: replace the capability decider, for example to simulate a
   *  throwing decision. */
  decide?: DeliveryGrantDecider
}

/** Observe both delivery permissions and return the shadow verdict. Never
 *  throws and never touches delivery. */
export function shadowDeliveryGrant(input: ShadowDeliveryGrantInput): LedgerGrant {
  try {
    const decide = input.decide ?? capabilityGrantDecider
    const publish = decide(input.producer, "delivery:publish", input.subject)
    const wake = decide(input.producer, "delivery:wake", input.target)
    return combineGrantDecisions([publish, wake])
  } catch {
    return "error"
  }
}
