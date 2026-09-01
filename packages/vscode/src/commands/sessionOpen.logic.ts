/**
 * Routing rule for the sessions list's single click — pure, so
 * `agentproto.openSession` (extension.ts) and any other caller share one
 * decision instead of each re-deriving it.
 *
 * - `browser` sessions have no chat panel to speak of: open the live view.
 * - a plain `terminal` PTY (a bash/shell session) has no structured events at
 *   all, so the transcript panel would show nothing useful — open the real
 *   terminal.
 * - a native-conversation PTY (a claude/hermes TUI attached to a provider
 *   conversation, see `isNativeConversationSession`) keeps the conversation
 *   panel as default: that panel already offers a Conversation⇄Terminal
 *   toggle for it (`viewToggle.logic.ts`), so defaulting to terminal here
 *   would just make the user flip it back.
 * - everything else (`agent-cli`, `command`) opens the transcript, as before.
 */
import type { SessionDescriptor } from "../client/types.js"
import { isNativeConversationSession } from "../webview/nativeConversation.js"

export type SessionOpenTarget = "terminal" | "browser" | "transcript"

export function defaultOpenTarget(
  session: Pick<SessionDescriptor, "kind" | "pty" | "adapterSlug" | "argv">,
): SessionOpenTarget {
  if (session.kind === "browser") return "browser"
  if (session.kind === "terminal" && !isNativeConversationSession(session)) return "terminal"
  return "transcript"
}
