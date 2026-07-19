/**
 * The ONE source of truth for a session's human-facing display name (SPEC-3
 * FIX D). Three surfaces used to answer "what do we call this session?" with
 * three different final fallbacks — `formatTitle` → id, `labelFor` → command,
 * the transcript header's inline script → id — so the tree, the tab, and the
 * header could disagree about the same session. They now all route through
 * `sessionDisplayName`, with one consistent chain and one friendly fallback.
 *
 * The webview's inline `updateHeader` can't import this module (it's a string
 * with no module system), so it hand-mirrors the SAME precedence + fallback;
 * keep the two in sync — see transcriptPanel.ts's `updateHeader`.
 */

import type { SessionDescriptor } from "./types.js"

/**
 * A short, stable tail of a session id for the fallback name — enough to tell
 * two same-adapter sessions apart without printing the full `sess_…` handle.
 * Short ids (test fixtures like `s1`) are returned whole; longer real ids
 * collapse to their last 6 chars.
 */
export function shortSessionId(id: string): string {
  return id.length <= 8 ? id : id.slice(-6)
}

/**
 * `label ?? title ?? <adapterSlug ?? kind> · <short id>`.
 *
 *  - `label` is spawner-supplied and always wins — it's also what a user
 *    rename writes (SPEC-3 fork-1), so an edit is guaranteed to show.
 *  - `title` is the mechanically-derived first sentence of the first prompt.
 *  - The fallback names the session by WHAT it is + a short id, rather than a
 *    bare `sess_…` handle (the old `formatTitle`) or the raw argv (the old
 *    `labelFor`) — both of which read as noise in a tree row or a tab.
 */
export function sessionDisplayName(
  session: Pick<SessionDescriptor, "label" | "title" | "id" | "adapterSlug" | "kind">,
): string {
  return session.label ?? session.title ?? `${session.adapterSlug ?? session.kind} · ${shortSessionId(session.id)}`
}
