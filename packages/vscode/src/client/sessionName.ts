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
 * `user-renamed-label > title > spawn-label > <adapterSlug ?? kind> · <short id>`.
 * Hand-mirror of the runtime's `sessionDisplayName` (packages/runtime/src/
 * session-title.ts) — keep the two in sync.
 *
 *  - A `label` a HUMAN wrote via `session_rename` (flagged `renamedByUser`)
 *    always wins — a deliberate rename must show.
 *  - `title` is the mechanically-derived first sentence of the first prompt.
 *    It now OUTRANKS a spawn label, so a spawn slug
 *    ("auto-title-precedence-fix") no longer shadows the useful derived title.
 *  - A spawn `label` shows only when there's no derived title to prefer.
 *  - The fallback names the session by WHAT it is + a short id, rather than a
 *    bare `sess_…` handle (the old `formatTitle`) or the raw argv (the old
 *    `labelFor`) — both of which read as noise in a tree row or a tab.
 *
 * Back-compat: a session persisted before `renamedByUser` existed carries a
 * `label` and NO flag. Since the pre-flag rename path also wrote `label`, an
 * old spawn slug and an old user rename can't be told apart on disk — so an
 * absent flag on a labelled session is treated as "user-renamed" to avoid
 * losing a prior rename. Only NEW spawns (`renamedByUser: false`) let the
 * derived title win over their label.
 */
export function sessionDisplayName(
  session: Pick<SessionDescriptor, "label" | "title" | "id" | "adapterSlug" | "kind" | "renamedByUser">,
): string {
  const userRenamed = session.renamedByUser ?? session.label !== undefined
  if (userRenamed && session.label !== undefined) return session.label
  if (session.title !== undefined) return session.title
  if (session.label !== undefined) return session.label
  return `${session.adapterSlug ?? session.kind} · ${shortSessionId(session.id)}`
}
