/**
 * Availability gate for the transcript header's Conversation⇄Terminal view
 * toggle — a PURE display switch (no session restart, no resume id), distinct
 * from the restart-based `switchHarness` command.
 *
 * The toggle only makes sense when the SAME session has BOTH representations
 * to flip between:
 *   - an `agent-cli` session has structured events (conversation) AND the raw
 *     flattened /stream output (terminal), or
 *   - a native-conversation PTY (a claude/hermes terminal) has a provider
 *     transcript (conversation) AND its raw terminal output.
 *
 * A `command`/`browser` session, or a plain non-native PTY, has only one
 * meaningful view, so the toggle is hidden for it.
 */
import type { SessionDescriptor } from "../client/types.js"
import { isNativeConversationSession } from "./nativeConversation.js"

export function canToggleView(
  session: Pick<SessionDescriptor, "kind" | "pty" | "adapterSlug" | "argv">,
): boolean {
  return session.kind === "agent-cli" || isNativeConversationSession(session)
}
