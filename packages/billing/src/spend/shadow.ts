/**
 * `shadow`: price an event and write the result to a sink WITHOUT touching the
 * journal. For a BYOK call, a trial period, or the shadow mode that proves a
 * new pricing path against the old one before it debits anything.
 *
 * Two guarantees: building a shadow without a pricer or a sink throws at start
 * (a missing engine is an error, never a silent zero), and `record` never
 * throws because of a price problem: an unpriced event is written as
 * `unpriced` and raised through `alert`, so a free action cannot hide.
 */
import { UnpricedUsageError, type PriceResult, type UsageEvent } from "./types.js"
import type { Pricer } from "./price.js"

export type ShadowEntry =
  | { status: "priced"; event: UsageEvent; price: PriceResult }
  | { status: "unpriced"; event: UsageEvent; reason: UnpricedUsageError["reason"] | "error"; message: string }

export interface ShadowSink {
  /** Write one entry. Idempotent by `entry.event.key` is the sink's job. */
  write(entry: ShadowEntry): Promise<void> | void
}

export interface ShadowDeps {
  pricer: Pricer
  sink: ShadowSink
  alert?: (entry: Extract<ShadowEntry, { status: "unpriced" }>) => void
}

export interface ShadowEngine {
  record(event: UsageEvent): Promise<ShadowEntry>
}

export function createShadow(deps: ShadowDeps): ShadowEngine {
  if (!deps?.pricer) throw new Error("createShadow: a pricer is required (no engine means no metering)")
  if (!deps.sink || typeof deps.sink.write !== "function") throw new Error("createShadow: a sink is required (no sink means no record)")
  return {
    async record(event) {
      let entry: ShadowEntry
      try {
        entry = { status: "priced", event, price: deps.pricer.price(event) }
      } catch (e) {
        entry = {
          status: "unpriced", event,
          reason: e instanceof UnpricedUsageError ? e.reason : "error",
          message: e instanceof Error ? e.message : String(e),
        }
        deps.alert?.(entry)
      }
      await deps.sink.write(entry)
      return entry
    },
  }
}
