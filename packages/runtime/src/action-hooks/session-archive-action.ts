/**
 * The `session:archive` action (AH-14a): archive the session of the event
 * through the durable reaction runner.
 *
 * This is the first user-bindable action. An event routine names it with
 * `target: { action: session:archive }` and the handler receives the
 * occurrence, so it knows which session just completed. The action takes no
 * inputs: any `inputs` authored on the binding are ignored.
 *
 * The handler reads the persisted `archived` flag first, so a replay after a
 * crash between the archive and the `done` receipt is normally a no-op and does
 * not fire the retirement listeners a second time. The flag is persisted with
 * the descriptor on a debounce (`PERSIST_DEBOUNCE_MS`, 1.5 seconds): a crash
 * inside that window can lose the flag while the `running` receipt survives,
 * and then the replay archives again and the listeners see one more `archived`
 * retirement. Those listeners converge (they re-point or remove wiring), so the
 * extra event is harmless.
 *
 * Two behaviors worth knowing. A session closed with an outcome is already
 * retired (cause `killed`) when its completion fires, so archiving it emits a
 * second retirement event, with cause `archived`; that is the same as any other
 * archive of a closed session. And a completed session that has a successor
 * (`continuedTo`) is archived too: hiding the predecessor is the intent. The
 * archive primitive itself is unchanged.
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
        // The row may have been revived or archived by someone else between the
        // checks above and the primitive. Those are settled states, not
        // transient failures: do not burn the retry budget on them.
        const after = opts.sessions.get(input.sessionId)
        if (after?.archived === true) {
          return { ok: true, outcomeRef: "skipped:already_archived" }
        }
        if (after !== undefined && (after.status === "running" || after.status === "starting")) {
          return { ok: true, outcomeRef: "skipped:alive" }
        }
        const message = messageOf(err)
        const clipped = message.length > ERROR_TEXT_MAX ? message.slice(0, ERROR_TEXT_MAX) : message
        log(`${LOG_PREFIX} ${input.sessionId}: ${clipped}`)
        return { ok: false, retryable: true, error: clipped }
      }
    },
  }
}
