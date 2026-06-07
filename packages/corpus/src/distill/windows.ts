/**
 * Conversation windowing — pure helpers + the windowed-source contract.
 *
 * Chat is append-only, so a single immutable slug per conversation would
 * collide once new turns arrive. The fix is WINDOWING: each (thread,
 * completed-UTC-day) slice is the unit that distils exactly once (a closed day
 * is immutable). These helpers compose / parse the window ref the importer
 * resolves and the provenance slug the distilled-scan dedups on.
 *
 * No transport, no chat-store, no model dependency — just string algebra over
 * `(threadId, day)` plus a structural source contract. A fake satisfying
 * `ConversationWindowSource` is all a test needs.
 */

import type { ConversationSourcePort } from "../ports/conversation-source.port.js"

const WINDOW_SEP = "::"

/** Compose the importer ref for one (thread, day) window. */
export function windowRef(threadId: string, day: string): string {
  return `${threadId}${WINDOW_SEP}${day}`
}

/** Parse a window ref back to its parts, or null when malformed. */
export function parseWindowRef(
  ref: string
): { threadId: string; day: string } | null {
  const i = ref.indexOf(WINDOW_SEP)
  if (i < 0) return null
  const threadId = ref.slice(0, i)
  const day = ref.slice(i + WINDOW_SEP.length)
  return threadId && day ? { threadId, day } : null
}

/** Slug base a window resolves to — also the `sources:` provenance id, so the
 *  distilled-scan can dedup windows across runs with no slug drift. */
export function windowSlug(threadId: string, day: string): string {
  return `${threadId}-${day}`
}

/** A thread the source owns — minimal shape the enumeration needs. */
export interface ConversationThreadRef {
  readonly id: string
  readonly threadId?: string
}

/**
 * The windowed source the distill pipeline drives: a `ConversationSourcePort`
 * that can also enumerate its threads and each thread's completed-day windows.
 * A fake satisfying this is all a test needs (no DB, no chat store).
 */
export interface ConversationWindowSource extends ConversationSourcePort {
  listThreads(): Promise<ConversationThreadRef[]>
  listWindows(threadId: string): Promise<string[]>
}

/**
 * Enumerate the window refs worth distilling for a windowed source: every
 * (thread, completed-day) window whose provenance slug isn't already distilled.
 * Generic over any `ConversationWindowSource`, so a binding never re-implements
 * the thread→window→skip loop.
 */
export async function enumerateWindowRefs(
  source: ConversationWindowSource,
  distilled: ReadonlySet<string>
): Promise<string[]> {
  const refs: string[] = []
  for (const thread of await source.listThreads()) {
    const threadId = thread.threadId ?? thread.id
    if (!threadId) continue
    for (const day of await source.listWindows(threadId)) {
      if (distilled.has(windowSlug(threadId, day))) continue
      refs.push(windowRef(threadId, day))
    }
  }
  return refs
}
