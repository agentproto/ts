/**
 * The `session:archive` action (AH-14a): archive the session of the event
 * through the durable reaction runner.
 *
 * This is the first user-bindable action. An event routine names it with
 * `target: { action: session:archive }` and the handler receives the
 * occurrence, so it knows which session just completed. The action takes no
 * inputs: any `inputs` authored on the binding are ignored.
 *
 * The handler reads the durable `archived` flag first, so a replay after a
 * crash between the archive and the `done` receipt is a no-op and never
 * re-fires the retirement listeners. The archive primitive itself is
 * unchanged; this module is the receipt dedupe the design note asked for.
 */

import type { SessionsRegistry } from "../sessions.js"
import type { ActionHandler, ActionRunInput } from "./reaction-bindings.js"
import type { ReactionTargetOutcome } from "./reaction-runner.js"

export const SESSION_ARCHIVE_ACTION_ID = "session:archive"

const ERROR_TEXT_MAX = 500

const LOG_PREFIX = "[session-archive]"

export interface SessionArchiveActionOptions {
  sessions: Pick<SessionsRegistry, "get" | "archiveSession">
  log?: (line: string) => void
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createSessionArchiveAction(opts: SessionArchiveActionOptions): ActionHandler {
  const log = opts.log ?? ((line: string): void => console.warn(line))

  return {
    actionId: SESSION_ARCHIVE_ACTION_ID,
    // The handler reads the durable `archived` flag first, so a replay after
    // a crash between the archive and the `done` receipt is a no-op and never
    // re-fires the retirement listeners.
    idempotent: true,
    async run(input: ActionRunInput): Promise<ReactionTargetOutcome> {
      const desc = opts.sessions.get(input.sessionId)
      if (desc === undefined) {
        return { ok: true, outcomeRef: "skipped:session_missing" }
      }
      if (desc.archived === true) {
        return { ok: true, outcomeRef: "skipped:already_archived" }
      }
      // The session was revived after it completed, so archiving it is wrong
      // and retrying will not help. Same liveness test as `archiveSession`.
      if (desc.status === "running" || desc.status === "starting") {
        return { ok: true, outcomeRef: "skipped:alive" }
      }
      // Automation never archives a session the operator pinned or asked to
      // keep alive.
      if (desc.pinned === true) {
        return { ok: true, outcomeRef: "skipped:pinned" }
      }
      if (desc.keepAlive === true) {
        return { ok: true, outcomeRef: "skipped:keep_alive" }
      }

      try {
        opts.sessions.archiveSession(input.sessionId)
        return { ok: true, outcomeRef: "archived" }
      } catch (err) {
        const message = messageOf(err)
        const clipped = message.length > ERROR_TEXT_MAX ? message.slice(0, ERROR_TEXT_MAX) : message
        log(`${LOG_PREFIX} ${input.sessionId}: ${clipped}`)
        return { ok: false, retryable: true, error: clipped }
      }
    },
  }
}
