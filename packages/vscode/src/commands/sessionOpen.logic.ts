/**
 * Routing rule for the sessions list's single click — pure, so
 * `agentproto.openSession` (extension.ts) and any other caller share one
 * decision instead of each re-deriving it.
 *
 * - `browser` sessions have no chat panel to speak of: open the live view.
 * - ANY `terminal` PTY opens the real terminal — including a
 *   native-conversation PTY (a claude/hermes TUI attached to a provider
 *   conversation). The operator asked for a terminal when they spawned it;
 *   the conversation panel is the OTHER view of the same session, one
 *   click away via the existing Conversation⇄Terminal toggle
 *   (`viewToggle.logic.ts`) — the reverse of the old rule, which sent a
 *   provider TUI to the transcript and made the terminal the hidden view.
 * - everything else (`agent-cli`, `command`) opens the transcript, as before.
 *
 * `isNativeConversationSession` (nativeConversation.ts) stays the "we know
 * how to READ this PTY's transcript" predicate — it no longer decides where
 * a click lands.
 */
import type { SessionDescriptor } from "../client/types.js"

export type SessionOpenTarget = "terminal" | "browser" | "transcript"

export function defaultOpenTarget(
  session: Pick<SessionDescriptor, "kind" | "pty" | "adapterSlug" | "argv">,
): SessionOpenTarget {
  if (session.kind === "browser") return "browser"
  if (session.kind === "terminal") return "terminal"
  return "transcript"
}
