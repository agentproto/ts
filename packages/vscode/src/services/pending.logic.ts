/**
 * Optimistic session rows — NO vscode import.
 *
 * Spawning is not instant: the daemon boots an adapter process and completes an
 * ACP handshake before it answers, which is seconds, sometimes many. The wizard
 * already refreshed the store the moment the call returned, so the tree was
 * never stale — it just had nothing to show until the daemon admitted the
 * session existed, and the operator watched an empty list wondering whether the
 * click had registered.
 *
 * A pending row is the answer: the tree shows what you ASKED for, immediately,
 * and swaps it for the real descriptor when the daemon produces one. It is
 * deliberately not a fake session — it carries the temp-id prefix that keeps it
 * out of every action path (see contextValueFor), because acting on a session
 * the daemon has never heard of can only 404.
 */

import type { SessionDescriptor } from "../client/types.js"

/**
 * Marks an id as locally-invented. The daemon's ids are opaque, so a prefix is
 * the only thing that distinguishes "we made this up" from "the daemon said
 * so" — and every consumer that must not act on a pending row keys off it.
 */
export const PENDING_ID_PREFIX = "pending:"

/** Fields the spawn wizard knows before the daemon has answered. */
export interface PendingSessionDraft {
  label?: string
  adapterSlug?: string
  cwd?: string
  workspaceSlug?: string
  model?: string
}

export function isPendingSession(session: Pick<SessionDescriptor, "id">): boolean {
  return session.id.startsWith(PENDING_ID_PREFIX)
}

/**
 * Build the optimistic descriptor for a spawn in flight.
 *
 * `status: "starting"` is the honest lifecycle value AND the one that paints a
 * spinner (see activityFor) — the row reads "this is coming up", which is
 * exactly what's true.
 */
export function makePendingSession(
  draft: PendingSessionDraft,
  seq: number,
  startedAt: string,
): SessionDescriptor {
  const label = draft.label ?? draft.adapterSlug ?? "agent"
  return {
    id: `${PENDING_ID_PREFIX}${seq}`,
    kind: "agent-cli",
    workspaceSlug: draft.workspaceSlug ?? "",
    command: label,
    pid: null,
    status: "starting",
    startedAt,
    busy: false,
    label,
    adapterSlug: draft.adapterSlug,
    model: draft.model,
    cwd: draft.cwd,
  }
}
