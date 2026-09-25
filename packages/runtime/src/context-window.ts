/**
 * Which `usage_update` frame gets to set a session's context-window size.
 *
 * Adapters don't all KNOW the window when they report it. claude-agent-acp
 * seeds `usage_update.size` from a text heuristic over the model id
 * (`immediateContextWindow` → `inferContextWindowFromModel`: "1m" token in
 * the id → 1M, else 200k) and only learns the real window from the first
 * `result.modelUsage` — the cost-bearing, end-of-turn frame. Its cache of the
 * learned value is in-process, so every fresh wrapper (new session, daemon
 * restart, resume) streams `size: 200000` through its whole first turn for a
 * model that actually runs on 1M (claude-opus-5-5, claude-sonnet-5, …).
 * Taking "latest frame wins" made `contextSize` read 200k mid-turn, so
 * occupancy looked 5x too high and context-continuity compacted / continued
 * fresh far too early.
 *
 * Precedence, highest first:
 *   1. `"adapter"` — a frame with a `cost` block (the adapter's authoritative
 *      turn result). Sticky: no later non-authoritative frame downgrades it.
 *      A newer authoritative frame still replaces it (the window can change
 *      for real, e.g. after a model switch the daemon didn't see).
 *   2. `"reported"` — a cost-less frame's `size`, when the adapter doesn't
 *      flag it as a guess. Other adapters' in-turn sizes are real (a hermes
 *      session can run a model below its catalog window), so they outrank
 *      the catalog and replace a spawn-time catalog seed.
 *   3. `"catalog"` — `@agentproto/model-catalog`'s window for the model the
 *      frame belongs to (the wrapper's `_meta["_claude/model"]`) or the
 *      session's own model id, including an explicit `[1m]` lane hint. Used
 *      at spawn and in place of a frame flagged `sizeInferred` (the ACP
 *      client flags claude-agent-acp's cost-less frames); an inferred frame
 *      only stands when the catalog doesn't know the model either.
 *
 * A model switch resets the source (see {@link resetContextWindowForModel}):
 * the sticky value belonged to the previous model.
 */
import { resolveContextWindow, splitContextWindowHint } from "@agentproto/model-catalog/llm"
import { stripRouteSuffix } from "@agentproto/model-catalog/route-identity"

/** Where a session's `contextSize` came from — see the module doc. */
export type ContextSizeSource = "adapter" | "catalog" | "reported"

/** The slice of a session descriptor this fold reads and writes. */
export interface ContextWindowState {
  contextSize?: number
  contextSizeSource?: ContextSizeSource
}

/** The slice of a `usage_update` event this fold reads. */
export interface UsageFrameWindow {
  size?: number
  cost?: { amount: number; currency: string }
  /** The model the adapter says this usage belongs to, when it reports one. */
  model?: string
  /** The adapter's `size` is a guess it corrects later — see the module doc. */
  sizeInferred?: boolean
}

/**
 * Catalog context window for a model id, or undefined when the catalog
 * doesn't know it. An explicit lane hint (`claude-opus-5-5[1m]`) answers on
 * its own. Session model ids come in several spellings — bare
 * (`claude-opus-5-5`), canonical (`anthropic/claude-opus-5-5`), routed
 * (`…@openrouter`) — while the catalog is keyed on the provider's bare live
 * id, so each reduction is tried in turn.
 */
export function catalogContextWindow(modelId: string | undefined): number | undefined {
  if (!modelId) return undefined
  const { id, contextWindow: hinted } = splitContextWindowHint(modelId)
  if (hinted !== undefined) return hinted
  const routeless = stripRouteSuffix(id)
  const product = routeless.slice(routeless.lastIndexOf("/") + 1)
  for (const candidate of new Set([id, routeless, product])) {
    const size = resolveContextWindow(candidate)?.contextWindow
    if (typeof size === "number" && size > 0) return size
  }
  return undefined
}

/** True when the frame is the adapter's authoritative, cost-bearing one. */
export function isAuthoritativeUsageFrame(frame: UsageFrameWindow): boolean {
  return frame.cost !== undefined && typeof frame.size === "number" && frame.size > 0
}

/**
 * Fold one `usage_update` frame into `state` (mutated in place) and return
 * the effective window after it — the value the frame SHOULD have carried.
 * `sessionModel` is the session's own model id (`activeModel ?? model`), the
 * fallback when the frame names none. Idempotent: folding the returned size
 * back in yields the same state.
 */
export function foldUsageFrameWindow(
  state: ContextWindowState,
  frame: UsageFrameWindow,
  sessionModel?: string,
): number | undefined {
  const size = typeof frame.size === "number" && frame.size > 0 ? frame.size : undefined
  if (size === undefined) return state.contextSize
  if (isAuthoritativeUsageFrame(frame)) {
    state.contextSize = size
    state.contextSizeSource = "adapter"
    return size
  }
  if (state.contextSizeSource === "adapter" && state.contextSize !== undefined) {
    return state.contextSize
  }
  if (frame.sizeInferred !== true) {
    state.contextSize = size
    state.contextSizeSource = "reported"
    return size
  }
  // An explicit lane hint on the session's model ("…[1m]") is the caller's
  // own statement of the window — the wrapper's `_claude/model` is the bare
  // id and would lose it. Otherwise `frame.model` first: it's the model that
  // actually answered, which matters when the session runs on an alias
  // ("default", "opus") or was switched by a typed `/model`.
  const catalog =
    (sessionModel ? splitContextWindowHint(stripRouteSuffix(sessionModel)).contextWindow : undefined) ??
    catalogContextWindow(frame.model) ??
    catalogContextWindow(sessionModel)
  if (catalog !== undefined) {
    state.contextSize = catalog
    state.contextSizeSource = "catalog"
    return catalog
  }
  state.contextSize = size
  state.contextSizeSource = "reported"
  return size
}

/**
 * Re-seed the window for a (new) model: drop any sticky adapter value that
 * belonged to the previous model and take the catalog's, when it knows the
 * model. Without a catalog entry the old size is kept but demoted to
 * `"reported"`, so the next frame of the new model replaces it.
 */
export function resetContextWindowForModel(
  state: ContextWindowState,
  modelId: string | undefined,
): void {
  const catalog = catalogContextWindow(modelId)
  if (catalog !== undefined) {
    state.contextSize = catalog
    state.contextSizeSource = "catalog"
  } else if (state.contextSize !== undefined) {
    state.contextSizeSource = "reported"
  }
}
