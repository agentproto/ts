/**
 * Routing rule for the sessions list's single click — pure, so
 * `agentproto.openSession` (extension.ts) and any other caller share one
 * decision instead of each re-deriving it.
 *
 * - `browser` sessions have no chat panel to speak of: open the live view.
 * - A live `terminal` PTY opens the real terminal. Once a native-conversation
 *   PTY has ended, its PTY cannot accept input and its screen buffer may be
 *   gone; open the durable provider transcript instead. The transcript's
 *   Restart action can resume it into a new live terminal.
 * - everything else (`agent-cli`, `command`) opens the transcript, as before.
 *
 * `isNativeConversationSession` (nativeConversation.ts) stays the "we know
 * how to READ this PTY's transcript" predicate — it no longer decides where
 * a click lands.
 */
import type { SessionDescriptor } from "../client/types.js"
import { isNativeConversationSession } from "../webview/nativeConversation.js"
import { isExited } from "../webview/transcript.logic.js"

export type SessionOpenTarget = "terminal" | "browser" | "transcript"

export function defaultOpenTarget(
  session: Pick<SessionDescriptor, "kind" | "status" | "pty" | "adapterSlug" | "argv">,
): SessionOpenTarget {
  if (session.kind === "browser") return "browser"
  if (isExited(session.status) && isNativeConversationSession(session)) return "transcript"
  if (session.kind === "terminal") return "terminal"
  return "transcript"
}
