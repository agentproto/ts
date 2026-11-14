/**
 * `pinned-session` strategy — keep the spawned child alive across
 * turns so the CLI's in-memory model context carries over.
 *
 * Suitable for manifests that declare `session.mode: persistent` AND
 * `context_carryover: true` (Claude Code, OpenCode, ...). Acquires
 * either reuse a live pinned session or spawn fresh and pin; releases
 * keep the session alive and reset its idle TTL. The strategy
 * auto-evicts after the manifest's `pinned_session.idle_timeout_ms`.
 *
 * The pin key is derived from `turnCtx` according to the manifest's
 * `pinned_session.key_scope` (default: `[conversation, operator]` —
 * different conversations and different operators each get their own
 * child process).
 *
 * Lost on process restart. DB-backed pin persistence is a follow-up
 * (track sessionId in `cli_sessions` table, then optionally fall back
 * to native-resume / transcript on restart).
 */

import type {
  AgentCliRuntimeSession,
  AgentCliRuntime,
  AgentCliStartOptions,
} from "../../types.js"
import type { ContinuationStrategy } from "../types.js"
import { deriveKeyFromScope } from "../types.js"

interface PinnedEntry {
  session: AgentCliRuntimeSession
  /** Cached so retry-after-eviction can recreate without re-resolving
   *  the runtime entry from outside. */
  runtime: AgentCliRuntime
  /** Cached so eviction-and-retry uses the same start options. */
  startOptions: AgentCliStartOptions
  idleTimer: ReturnType<typeof setTimeout> | null
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000

const pins = new Map<string, PinnedEntry>()

function clearIdleTimer(entry: PinnedEntry): void {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer)
    entry.idleTimer = null
  }
}

function scheduleIdleEviction(
  key: string,
  entry: PinnedEntry,
  idleTimeoutMs: number
): void {
  clearIdleTimer(entry)
  entry.idleTimer = setTimeout(() => {
    pins.delete(key)
    entry.session.close().catch(err => {
      console.warn(
        `[pinned-session] idle close failed for ${key}:`,
        err instanceof Error ? err.message : err
      )
    })
    console.log(
      `[pinned-session] ${key} idle ${idleTimeoutMs / 60_000}m → closed`
    )
  }, idleTimeoutMs)
  // Don't keep the event loop alive just for the idle close — the
  // child will be reaped on process exit anyway. Without `unref`
  // a stale pin would block graceful shutdown.
  entry.idleTimer.unref?.()
}

function evictPin(key: string): void {
  const entry = pins.get(key)
  if (!entry) return
  clearIdleTimer(entry)
  pins.delete(key)
  entry.session.close().catch(err => {
    console.warn(
      `[pinned-session] evict close failed for ${key}:`,
      err instanceof Error ? err.message : err
    )
  })
}

export const pinnedSessionStrategy: ContinuationStrategy = {
  id: "pinned-session",

  async acquire(ctx) {
    const tuning = ctx.runtime.definition.continuation?.pinned_session
    const scope = tuning?.key_scope ?? ["conversation", "operator"]
    const key = deriveKeyFromScope(scope, ctx.turnCtx)
    const idleTimeoutMs = tuning?.idle_timeout_ms ?? DEFAULT_IDLE_TIMEOUT_MS

    if (key === null) {
      // No identity to pin against — fall back to per-spawn behaviour.
      // Warn so the host learns to populate turnCtx.
      console.warn(
        `[pinned-session] turnCtx has no fields matching key_scope ${JSON.stringify(scope)}; falling back to per-spawn (no pin).`
      )
      return ctx.runtime.start(ctx.startOptions)
    }

    const existing = pins.get(key)
    if (existing) {
      // Cancel the idle timer — this turn is reusing the pin.
      clearIdleTimer(existing)
      return existing.session
    }

    const session = await ctx.runtime.start(ctx.startOptions)
    const entry: PinnedEntry = {
      session,
      runtime: ctx.runtime,
      startOptions: ctx.startOptions,
      idleTimer: null,
    }
    pins.set(key, entry)
    scheduleIdleEviction(key, entry, idleTimeoutMs)
    return session
  },

  async release(ctx) {
    // Find the entry by identity — ReleaseContext doesn't carry `runtime`,
    // so we match by session reference. Acceptable since the pin map is small.
    let foundKey: string | null = null
    for (const [k, e] of pins) {
      if (e.session === ctx.session) {
        foundKey = k
        break
      }
    }

    if (!foundKey) {
      // Session wasn't pinned (per-spawn fallback path) — close it
      // like the `none` strategy would.
      await ctx.session.close()
      return
    }

    const entry = pins.get(foundKey)!
    const tuning = entry.runtime.definition.continuation?.pinned_session
    const idleTimeoutMs = tuning?.idle_timeout_ms ?? DEFAULT_IDLE_TIMEOUT_MS

    // Fatal errors → evict so the next turn re-spawns. Transient
    // errors and normal completion → reset the idle TTL and keep.
    // Cancelled (user aborted) is treated like normal completion —
    // the user wanted to stop this turn, not the whole session.
    if (ctx.outcome.kind === "error" && ctx.outcome.reason === "fatal") {
      evictPin(foundKey)
      return
    }

    scheduleIdleEviction(foundKey, entry, idleTimeoutMs)
  },
}

/**
 * Test helper — drop all pinned entries and clear timers. Not part
 * of the public API; exposed under `__test__` so tests can reset the
 * module's singleton state between runs.
 */
export const __test__ = {
  resetPins(): void {
    for (const [k] of pins) evictPin(k)
  },
  pinCount(): number {
    return pins.size
  },
}
