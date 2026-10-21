/**
 * Crash resume: link a session to the checkpoint it produced, and put that
 * checkpoint back into a box that died.
 *
 * The daemon already checkpoints the uncommitted work of a sandbox session
 * (`sandbox-delivery.ts`): the snapshot is force-pushed to
 * `agentproto-checkpoint/<worktree>` on the workspace remote. That ref is
 * named after the WORK TREE, which is minted per spawn and known to nobody
 * else, so a relaunch could not find "the checkpoint of the session that
 * died": the snapshot was on the remote, but nothing pointed at it.
 *
 * This module closes that gap:
 *
 *   1. {@link SessionCheckpointRef} is the session-metadata shape of "the
 *      last checkpoint of this session" (ref, sha, branch, session id). The
 *      daemon writes it into the session row when it creates the checkpoint
 *      (`registry.recordSandboxCheckpoint`), so the link cannot drift from
 *      the checkpoint itself.
 *   2. {@link resolveResumeSource} picks the DEAD session a relaunch
 *      continues - by explicit id, or by label correlation - and returns its
 *      checkpoint. A live session is never resumed: a running session is not
 *      a crashed one.
 *   3. {@link buildCheckpointRestoreCommand} turns that checkpoint into the
 *      `git restore --source=<ref>` that puts the work back on a fresh
 *      checkout.
 *
 * The restore is best effort by construction: a missing ref, a dirty tree or
 * a failed fetch leaves the checkout alone and the step reports what
 * happened. Only a checkpoint that REACHED the remote is restorable - a
 * snapshot that only exists as a host-side bundle is never faked.
 */

import type { SandboxDeliveryRecord } from "./sandbox-delivery.js"

/** POSIX single-quote a value for safe interpolation into a shell command.
 *  Same shape as `sandbox-workspace-remote.ts`'s helper, kept local so this
 *  module stays free of an import cycle with it. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** The session-metadata record of the last checkpoint a session produced. */
export interface SessionCheckpointRef {
  /** Remote branch carrying the snapshot commit (`agentproto-checkpoint/wt/x`). */
  ref: string
  /** Snapshot commit sha, when the checkpoint recorded one. */
  sha?: string
  /** Work branch the snapshot belongs to (`wt/x`). */
  branch?: string
  /** ISO instant the checkpoint was recorded. */
  at: string
  /** Session that produced the checkpoint. */
  sessionId?: string
  /** Correlation key of the session that produced it (a task id). */
  taskId?: string
  /** Correlation key of the session that produced it (its label). */
  label?: string
}

/** A checkpoint that reached the remote, as recorded on the session row. */
export interface RecordedCheckpoint {
  checkpoint: SessionCheckpointRef
  /** The delivery record the ref was derived from. */
  record: SandboxDeliveryRecord
}

/**
 * The checkpoint ref of a delivery record - only when the snapshot actually
 * reached the remote (`status: "pushed"`). A failed push leaves nothing to
 * restore, and pretending otherwise would restore an empty tree over the
 * agent's work.
 */
export function checkpointRefFromRecord(
  record: SandboxDeliveryRecord | undefined,
  ctx?: { sessionId?: string; taskId?: string; label?: string },
): SessionCheckpointRef | undefined {
  const pushed = record?.checkpoint
  if (!record || !pushed || pushed.status !== "pushed" || !pushed.ref) return undefined
  return {
    ref: pushed.ref,
    ...(pushed.sha ? { sha: pushed.sha } : {}),
    ...(record.branch ? { branch: record.branch } : {}),
    at: record.at,
    ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx?.taskId ? { taskId: ctx.taskId } : {}),
    ...(ctx?.label ? { label: ctx.label } : {}),
  }
}

/** The subset of a session row this module reads. */
export interface CheckpointRefCarrier {
  /** The explicit link written when the checkpoint was created. */
  lastCheckpoint?: SessionCheckpointRef
  /** The latest periodic checkpoint record of the session. */
  sandboxCheckpoint?: SandboxDeliveryRecord
  /** The teardown delivery record of the session. */
  sandboxDelivery?: SandboxDeliveryRecord
  /** The session id. */
  id?: string
  /** The session label (a correlation key for a relaunch). */
  label?: string
  /** The task the session was working on (a correlation key for a relaunch). */
  taskId?: string
  /** Where the session's work branch lived in its box, reused by a
   *  relaunch so the pushed commits come back as commits. */
  sandboxDeliveryTarget?: { branch?: string }
  /** The workspace the session worked in. */
  workspaceSlug?: string
}

/**
 * The last checkpoint of a session: the explicit link first, then the
 * recorded checkpoint/delivery records as a fallback (a row written before
 * this link existed, or a daemon that restarted between the checkpoint and
 * the link).
 */
export function latestCheckpointRef(desc: CheckpointRefCarrier | undefined): SessionCheckpointRef | undefined {
  if (!desc) return undefined
  if (desc.lastCheckpoint?.ref) return desc.lastCheckpoint
  const ctx = {
    ...(desc.id ? { sessionId: desc.id } : {}),
    ...(desc.taskId ? { taskId: desc.taskId } : {}),
    ...(desc.label ? { label: desc.label } : {}),
  }
  return (
    checkpointRefFromRecord(desc.sandboxCheckpoint, ctx) ?? checkpointRefFromRecord(desc.sandboxDelivery, ctx)
  )
}

/** A session that can be resumed: it is not running any more. */
export function isDeadSession(desc: { status?: string }): boolean {
  return desc.status !== "running" && desc.status !== "starting"
}

export interface ResumeSourceRequest {
  /** The sessions the relaunch may pick from (the registry's rows). */
  sessions: Array<CheckpointRefCarrier & { id?: string; status?: string; label?: string; taskId?: string }>
  /** Explicit link to the session that died. */
  sessionId?: string
  /** Correlation by label: the most recent dead session with this label. */
  label?: string
  /** Correlation by task id. */
  taskId?: string
}

export interface ResumeSource {
  /** The dead session the relaunch continues. */
  session: CheckpointRefCarrier & { id?: string; status?: string; label?: string; taskId?: string }
  /** Its last checkpoint - the one to restore. */
  checkpoint: SessionCheckpointRef
}

/**
 * Resolve the session a relaunch continues and the checkpoint it must
 * restore. Explicit id first, then the correlation keys (task id, then
 * label) against the DEAD sessions that carry a checkpoint.
 *
 * A live session is never a resume source: its work is still in its box.
 */
export function resolveResumeSource(req: ResumeSourceRequest): ResumeSource | undefined {
  const withCheckpoint = (session: ResumeSourceRequest["sessions"][number]): ResumeSource | undefined => {
    if (!isDeadSession(session)) return undefined
    const checkpoint = latestCheckpointRef(session)
    if (!checkpoint?.ref) return undefined
    return { session, checkpoint }
  }
  if (req.sessionId) {
    const found = req.sessions.find(s => s.id === req.sessionId)
    return found ? withCheckpoint(found) : undefined
  }
  const candidates = req.sessions.filter(isDeadSession)
  if (req.taskId) {
    const byTask = candidates.filter(s => s.taskId === req.taskId)
    const hit = byTask.map(withCheckpoint).find((r): r is ResumeSource => r !== undefined)
    if (hit) return hit
  }
  if (req.label) {
    const byLabel = candidates.filter(s => s.label === req.label)
    // Most recent checkpoint wins: the rows are ordered by the caller, and
    // the checkpoint carries its own instant.
    const hits = byLabel.map(withCheckpoint).filter((r): r is ResumeSource => r !== undefined)
    hits.sort((a, b) => (a.checkpoint.at < b.checkpoint.at ? 1 : a.checkpoint.at > b.checkpoint.at ? -1 : 0))
    const hit = hits[0]
    if (hit) return hit
  }
  return undefined
}

/** Remote-tracking ref the snapshot is read back from in a box. */
export function checkpointSourceRef(ref: string): string {
  return ref.startsWith("refs/") ? ref : `refs/remotes/origin/${ref}`
}

export interface CheckpointRestoreCommandInput {
  /** The checkout the work is restored into. */
  checkoutDir: string
  /** The checkpoint ref (`agentproto-checkpoint/wt/x`). */
  ref: string
  /** The snapshot sha, when known: the restore only happens for THAT snapshot. */
  sha?: string
  /** Skip the fetch of the checkpoint ref (the caller already fetched it). */
  skipFetch?: boolean
}

/**
 * The command that puts a checkpoint back on a checkout:
 * `git restore --source=<ref> --staged --worktree -- .`.
 *
 * The snapshot commit carries the tree of the crashed session's worktree
 * (its staged and unstaged changes, `git add -A` through a throwaway index),
 * so restoring it restores the FILES the session was working on - the
 * modified ones and the ones it had added. The restored state is
 * uncommitted, exactly like the checkpoint it came from.
 *
 * Guarded, never fatal:
 * - the checkpoint ref is fetched first (a clone may predate it);
 * - a missing ref, a sha that does not match, or a dirty checkout skips the
 *   restore and says so.
 */
export function buildCheckpointRestoreCommand(input: CheckpointRestoreCommandInput): string {
  const dir = shellQuote(input.checkoutDir)
  const source = shellQuote(checkpointSourceRef(input.ref))
  const fetch = input.skipFetch
    ? ""
    : `git fetch --quiet --no-tags origin ${shellQuote(`+refs/heads/${input.ref}:refs/remotes/origin/${input.ref}`)} >/dev/null 2>&1 || true; `
  const shaCheck = input.sha ? ` && [ "$(git rev-parse ${source})" = ${shellQuote(input.sha)} ]` : ""
  return (
    `cd ${dir} && ${fetch}` +
    `if git show-ref --verify --quiet ${source}${shaCheck} && [ -z "$(git status --porcelain)" ]; ` +
    `then git restore --source=${source} --staged --worktree -- . && echo ${shellQuote(`restored checkpoint ${input.ref}`)}; ` +
    `else echo ${shellQuote(`checkpoint not restored: ${input.ref}`)}; fi`
  )
}

/** The in-box setup step that restores a checkpoint. */
export interface CheckpointResumeStep {
  label: string
  command: string
  timeoutMs: number
}

/**
 * The setup steps that restore a recorded checkpoint onto a fresh checkout.
 * Empty when there is no checkpoint to restore.
 */
export function planCheckpointResumeRestore(
  input: CheckpointRestoreCommandInput & { timeoutMs?: number },
): CheckpointResumeStep[] {
  if (!input.ref) return []
  return [
    {
      label: "restore-checkpoint-resume",
      command: buildCheckpointRestoreCommand(input),
      timeoutMs: input.timeoutMs ?? 120_000,
    },
  ]
}
