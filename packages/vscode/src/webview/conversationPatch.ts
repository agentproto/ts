/**
 * Pure diff between two `PresentedConversation` snapshots — the piece that
 * turns "poll produced a new full timeline" into "here is what actually
 * changed" so the controller can post a small patch instead of the whole
 * conversation, and the webview can reconcile DOM instead of tearing it down.
 *
 * Diff granularity is TURN level, not segment level: during a live poll only
 * the most recent turn is actually changing (a streaming text delta, a tool
 * call opening/closing), so turn-level diffing already yields the same win —
 * one changed node instead of N. The webview then reconciles segments
 * *within* a changed turn by `data-seg-id`, which is where the fine-grained
 * "keep untouched nodes untouched" behavior (expand/collapse, selection)
 * actually comes from.
 *
 * Pure: no `vscode`, no DOM. Runs on the extension host, next to the reducer.
 */

import type { ConversationUsage, PresentedConversation, PresentedTurn } from "./conversation.js"

export interface ConversationPatch {
  /** Turns new-or-changed since the last present, in document order. */
  upsertTurns: PresentedTurn[]
  /** Turn ids no longer present (defensive — a re-reduce should not drop turns). */
  removeTurnIds: string[]
  /** Present only when it changed. */
  usage?: ConversationUsage
  /** True when nothing changed — caller must not post. */
  empty: boolean
}

/**
 * Turns and usage are built fresh by `presentConversation` on every call from
 * plain data (ids, strings, numbers) in a fixed field order, so two
 * presentations of the same underlying state serialize identically —
 * `JSON.stringify` is a safe, cheap equality check here without needing a
 * recursive deep-equal, and it isn't fooled by key order because nothing
 * reorders keys between calls.
 */
function serialize(value: unknown): string {
  return JSON.stringify(value) ?? "undefined"
}

export function diffConversation(
  prev: PresentedConversation | undefined,
  next: PresentedConversation,
): ConversationPatch {
  const prevTurns = new Map((prev?.turns ?? []).map(turn => [turn.id, turn]))
  const nextIds = new Set(next.turns.map(turn => turn.id))

  const upsertTurns: PresentedTurn[] = []
  for (const turn of next.turns) {
    const prevTurn = prevTurns.get(turn.id)
    if (!prevTurn || serialize(prevTurn) !== serialize(turn)) {
      upsertTurns.push(turn)
    }
  }

  const removeTurnIds = prev ? prev.turns.filter(turn => !nextIds.has(turn.id)).map(turn => turn.id) : []

  const usageChanged = serialize(prev?.usage) !== serialize(next.usage)

  return {
    upsertTurns,
    removeTurnIds,
    ...(usageChanged && next.usage !== undefined ? { usage: next.usage } : {}),
    empty: upsertTurns.length === 0 && removeTurnIds.length === 0 && !usageChanged,
  }
}
