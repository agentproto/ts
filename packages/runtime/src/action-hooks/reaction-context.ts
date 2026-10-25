/**
 * Reaction context: carry the causation of a running reaction across the
 * asynchronous work its target starts, including a session spawn.
 *
 * The runner enters a context around every target invocation. A spawn made
 * inside that context is stamped with the binding id and the reaction depth the
 * new session carries, so the depth cap bounds every arm, not just the arm
 * that happened to start the session.
 */

import { AsyncLocalStorage } from "node:async_hooks"

export interface ReactionContext {
  bindingId: string
  /** The depth a session started inside this reaction carries (the running receipt's depth + 1). */
  reactionDepth: number
  /** The receipt key of the reaction whose target runs. */
  causedByEventId: string
}

const storage = new AsyncLocalStorage<ReactionContext>()

export function runInReactionContext<T>(ctx: ReactionContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn)
}

export function currentReactionContext(): ReactionContext | undefined {
  return storage.getStore()
}

/** Pure: what a spawn started inside a reaction must carry, or undefined outside one. */
export function reactionSpawnStamp(
  explicitOrigin: string | undefined,
): { origin: string; meta: { reactionDepth: number; causedByEventId: string } } | undefined {
  const ctx = storage.getStore()
  if (ctx === undefined) return undefined
  return {
    origin: explicitOrigin ?? `reaction:${ctx.bindingId}`,
    meta: { reactionDepth: ctx.reactionDepth, causedByEventId: ctx.causedByEventId },
  }
}
