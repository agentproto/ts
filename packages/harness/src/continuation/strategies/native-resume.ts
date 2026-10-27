/**
 * `native-resume` strategy — reattach to the agent's own session by id
 * (ACP `loadSession`, MCP equivalent, or argv-style `--resume`).
 *
 * Two-step lifecycle:
 *   1. **acquire**: look up a persisted sessionId for `turnCtx` via
 *      `loadHook`. If found, pass it to `runtime.start` as
 *      `resumeSessionId` so the protocol arm reattaches. If not, spawn
 *      fresh — and after the session is up, capture the new id from
 *      `session.sessionId` and persist it via `saveHook`.
 *   2. **release**: close the spawned process. The session lives in
 *      the agent's storage layer (e.g. Claude Code's JSONL files);
 *      cold-start resume on the next acquire reads from that store.
 *
 * Hooks are registered once per host process via
 * `configureNativeResume({ load, save })`. Without hooks the strategy
 * degrades to per-spawn behaviour with a one-line warning — it's not
 * fatal because the spawn still works, just without continuity.
 *
 * Requires the manifest to declare `capabilities.resumable: true`
 * AND the agent to advertise the matching protocol capability (e.g.
 * ACP `loadSession: true`). The schema enforces the manifest side at
 * validation; runtime capability mismatch surfaces from the protocol
 * arm as the agent's own error.
 */

import type { ContinuationStrategy, AcquireContext } from "../types.js"
import { deriveKeyFromScope } from "../types.js"
import type { TurnContext } from "../../types.js"

export interface NativeResumeHooks {
  /** Look up a persisted sessionId for the given identity scope. Return
   *  undefined when no prior session exists — strategy spawns fresh. */
  load: (turnCtx: TurnContext) => Promise<string | undefined>
  /** Persist a freshly-established sessionId so the next cold start
   *  can resume. Called once per "fresh spawn" acquire (not per turn).
   *  Idempotent / upsert semantics expected on the host side. */
  save: (turnCtx: TurnContext, sessionId: string) => Promise<void>
  /** Optional: drop the persisted entry when a session is detected as
   *  unresumable (agent rejected loadSession with a hard error). */
  forget?: (turnCtx: TurnContext) => Promise<void>
}

let _hooks: NativeResumeHooks | null = null

/**
 * Register the host's session-id load/save callbacks. Call once at
 * boot. Subsequent calls overwrite — useful in tests; in prod treat
 * the registration as exclusive.
 */
export function configureNativeResume(hooks: NativeResumeHooks): void {
  _hooks = hooks
}

/** Reset to no-hooks. Test helper; not part of public API. */
export function __resetNativeResumeForTests(): void {
  _hooks = null
}

export const nativeResumeStrategy: ContinuationStrategy = {
  id: "native-resume",
  async acquire(ctx: AcquireContext) {
    if (!_hooks) {
      console.warn(
        "[native-resume] no hooks registered (call configureNativeResume at boot); falling back to per-spawn — no continuity."
      )
      return ctx.runtime.start(ctx.startOptions)
    }
    // Use the same key-derivation as pinned-session so a host can
    // declare its scope ONCE in the manifest (`continuation.pinned_session.key_scope`)
    // and have both strategies key off the same identity. Native-resume
    // doesn't have its own key_scope today; it inherits.
    const scope =
      ctx.runtime.definition.continuation?.pinned_session?.key_scope ?? [
        "conversation",
        "operator",
      ]
    const key = deriveKeyFromScope(scope, ctx.turnCtx)
    if (key === null) {
      console.warn(
        `[native-resume] turnCtx has no fields matching key_scope ${JSON.stringify(scope)}; falling back to per-spawn (no resume).`
      )
      return ctx.runtime.start(ctx.startOptions)
    }

    const existingId = await _hooks.load(ctx.turnCtx).catch(err => {
      console.warn(
        `[native-resume] load hook failed for ${key}:`,
        err instanceof Error ? err.message : err
      )
      return undefined
    })

    let session
    let resumed = false
    if (existingId) {
      try {
        session = await ctx.runtime.start({
          ...ctx.startOptions,
          resumeSessionId: existingId,
        })
        resumed = true
      } catch (err) {
        // Most likely the agent rejected the id (session expired,
        // wiped, mismatched cwd). Drop the stale pin and spawn fresh
        // so the user gets continuity going forward instead of being
        // stuck on a dead reference.
        console.warn(
          `[native-resume] resume failed for ${key} (id=${existingId.slice(0, 12)}…), starting fresh:`,
          err instanceof Error ? err.message : err
        )
        if (_hooks.forget) {
          await _hooks.forget(ctx.turnCtx).catch(() => undefined)
        }
        session = await ctx.runtime.start(ctx.startOptions)
      }
    } else {
      session = await ctx.runtime.start(ctx.startOptions)
    }

    // Persist the established id when this is a NEW session (resume
    // path keeps the same id we already have, no need to re-save).
    // The runtime guarantees session.sessionId reflects the protocol
    // session id when the arm exposes it.
    if (!resumed && session.sessionId) {
      await _hooks.save(ctx.turnCtx, session.sessionId).catch(err => {
        console.warn(
          `[native-resume] save hook failed for ${key}:`,
          err instanceof Error ? err.message : err
        )
      })
    }
    return session
  },

  async release(ctx) {
    // The protocol session lives in the agent's own storage; closing
    // the spawned subprocess is fine — `loadSession` on the next
    // acquire reattaches via the persisted id.
    await ctx.session.close()
  },
}
