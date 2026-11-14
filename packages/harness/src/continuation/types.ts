/**
 * AIP-45 ContinuationStrategy interface.
 *
 * A continuation strategy decides HOW prior conversation turns reach a
 * spawned CLI on subsequent invocations. Built-ins handle:
 *
 *   - `none`           — fresh session per call (current pre-AIP-45 behaviour)
 *   - `pinned-session` — keep the spawned child alive, reuse across turns
 *   - `transcript`     — caller-supplied preamble prepended to each turn
 *   - `native-resume`  — pass a session id to the CLI's own `--resume` flag
 *
 * Adapter packages MAY register custom strategies via the registry —
 * for example, a Goose-specific strategy that uses MCP-side session
 * load semantics. Custom strategy ids require a follow-up AIP that
 * opens the `ContinuationStrategyId` enum (so the manifest schema can
 * validate them).
 *
 * The strategy owns the SESSION LIFECYCLE: `acquire` returns a session
 * the caller can `send()` against, and `release` decides whether the
 * session lives on (pinned-session) or closes immediately (none). The
 * runner / generation strategy MUST go through `acquire`/`release` —
 * it MUST NOT call `runtime.start()` / `session.close()` directly when
 * a strategy is active.
 */

import type {
  AgentCliRuntime,
  AgentCliRuntimeSession,
  AgentCliStartOptions,
  ContinuationKeyScope,
  ContinuationStrategyId,
  RuntimeConfig,
  TurnContext,
} from "../types.js"

/**
 * Per-acquire context the strategy gets. The runner builds this from
 * the manifest, the operator config, and the current turn's identity.
 */
export interface AcquireContext {
  runtime: AgentCliRuntime
  /** Already-composed start options (cwd / env / signal / config /
   *  turnCtx). Strategies MAY override individual fields when they
   *  call `runtime.start(...)` themselves. */
  startOptions: AgentCliStartOptions
  /** Per-call config (already validated against the manifest). */
  config: RuntimeConfig
  /** Identity context for key derivation. */
  turnCtx: TurnContext
}

/**
 * Strategies can hint to the runner about how the turn played out so
 * the strategy can decide whether to keep the session alive (normal
 * end), reset its TTL but keep it (transient error), or evict it
 * (dead-process error).
 */
export type ReleaseOutcome =
  | { kind: "completed" }
  | { kind: "cancelled" }
  | { kind: "error"; reason: "transient" | "fatal"; message: string }

export interface ReleaseContext {
  session: AgentCliRuntimeSession
  outcome: ReleaseOutcome
  turnCtx: TurnContext
}

/**
 * The strategy contract. `acquire` returns a session ready for the
 * caller to `send()` against — fresh OR reused. `release` decides
 * the session's fate. Strategies MAY hold internal state (e.g.
 * the pinned-session map) keyed by `turnCtx`.
 */
export interface ContinuationStrategy {
  readonly id: ContinuationStrategyId
  acquire(ctx: AcquireContext): Promise<AgentCliRuntimeSession>
  release(ctx: ReleaseContext): Promise<void>
}

/**
 * Derive a stable pin key from `turnCtx` according to the manifest's
 * `pinned_session.key_scope`. Missing scope fields downgrade to a
 * less-specific key with a warning — pinning still works, it just
 * collides more.
 *
 * Returns `null` when EVERY scope field the manifest asked for is
 * missing (no key derivable; strategy falls back to per-spawn).
 */
export function deriveKeyFromScope(
  scope: ContinuationKeyScope[],
  turnCtx: TurnContext
): string | null {
  const parts: string[] = []
  for (const s of scope) {
    const v = turnCtx[s]
    if (v) parts.push(`${s}=${v}`)
  }
  return parts.length === 0 ? null : parts.join("|")
}
