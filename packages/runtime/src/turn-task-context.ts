/**
 * The reservation a covered tool call (`agent_start` with a prompt, `agent_prompt`) runs under when the host has
 * decided to answer it with a task.
 *
 * The host reserves the identifiers BEFORE the tool runs and hands them to the tool through this request-scoped
 * context, never through the request: a client has no parameter that can name a `promptId`, choose a `sessionId` or
 * force task creation. The tool calls `commit` once it has resolved its target and passed its own admission checks, just
 * before it hands the prompt over, so the durable ledger entry always exists before the session (or its queue) hears
 * about the prompt.
 */

import { AsyncLocalStorage } from "node:async_hooks"

export interface TurnTaskReservation {
  /** Host-chosen prompt ticket for the prompt this call carries. */
  readonly promptId: string
  /** `agent_start` only: the host-chosen id the session must be spawned under. */
  readonly sessionId?: string
  /**
   * Durably record the task for `sessionId` (ledger entry in state `working`, queued) and return. Throws when the
   * ledger cannot persist, in which case the tool must answer with its own error and start nothing. Idempotent.
   */
  commit(sessionId: string): void
}

const storage = new AsyncLocalStorage<TurnTaskReservation>()

/** Run `fn` with `reservation` visible to the covered tool it calls. */
export function runWithTurnTaskReservation<T>(reservation: TurnTaskReservation, fn: () => Promise<T>): Promise<T> {
  return storage.run(reservation, fn)
}

/** The reservation of the tool call being served, if the host decided to answer it with a task. */
export function currentTurnTaskReservation(): TurnTaskReservation | undefined {
  return storage.getStore()
}
