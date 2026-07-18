/**
 * Pure logic for archiving/unarchiving a terminal session. Mirrors
 * sessionRestart.logic.ts's canRestart pattern, but the daemon DOES guard
 * `session_archive` server-side this time (sessions.ts's `archiveSession`
 * refuses a still-alive session) — these client-side gates exist so the
 * command never even offers "Archive" on a live session or "Unarchive" on
 * a session that isn't archived, rather than round-tripping to the daemon
 * to find out.
 */

import type { SessionDescriptor } from "../client/types.js"
import { contextValueFor } from "../views/sessionsTree.logic.js"

/** True only for a terminal-status session not already archived. */
export function canArchive(session: SessionDescriptor): boolean {
  return contextValueFor(session) === "session-done" && session.archived !== true
}

/** True only for an archived session. */
export function canUnarchive(session: SessionDescriptor): boolean {
  return session.archived === true
}
