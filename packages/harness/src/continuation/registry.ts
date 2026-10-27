/**
 * Continuation strategy registry.
 *
 * Module-scoped singleton — all built-ins are registered at import
 * time, custom strategies (from adapter packages) register via
 * `registerContinuationStrategy`. The runner looks up by id;
 * unregistered ids throw at acquire-time so the caller fails fast
 * with a clear "this strategy id isn't registered" message.
 */

import type { ContinuationStrategyId } from "../types.js"
import type { ContinuationStrategy } from "./types.js"
import { noneStrategy } from "./strategies/none.js"
import { pinnedSessionStrategy } from "./strategies/pinned-session.js"
import { transcriptStrategy } from "./strategies/transcript.js"
import { nativeResumeStrategy } from "./strategies/native-resume.js"

const registry = new Map<ContinuationStrategyId, ContinuationStrategy>()

/**
 * Register (or replace) a continuation strategy. Adapter packages
 * MAY register custom strategies on import — but they MUST first
 * land an AIP that opens the `ContinuationStrategyId` enum so the
 * manifest schema accepts the new id.
 */
export function registerContinuationStrategy(
  strategy: ContinuationStrategy
): void {
  registry.set(strategy.id, strategy)
}

export function getContinuationStrategy(
  id: ContinuationStrategyId
): ContinuationStrategy {
  const s = registry.get(id)
  if (!s) {
    throw new Error(
      `[agent-cli] No continuation strategy registered for id '${id}'. Built-ins: ${Array.from(registry.keys()).join(", ")}.`
    )
  }
  return s
}

export function listContinuationStrategies(): ContinuationStrategyId[] {
  return Array.from(registry.keys())
}

// Register built-ins eagerly at module load so any importer of the
// registry sees them. Custom strategies layer on top.
registerContinuationStrategy(noneStrategy)
registerContinuationStrategy(pinnedSessionStrategy)
registerContinuationStrategy(transcriptStrategy)
registerContinuationStrategy(nativeResumeStrategy)
