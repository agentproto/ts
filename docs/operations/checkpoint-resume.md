# Checkpoint resume: relinking a crashed box session to its checkpoint

Status: implemented (task 18).
Scope: `packages/runtime` (the daemon).

## The incident

Task 14 crashed four times (r1 to r4). The daemon had taken checkpoints the
whole time: the box-side snapshots sat in `agentproto-checkpoint/wt/<worktreeId>`
on the remote. The relaunches still started from `main`, and the third run
(r3) even started with no snapshot at all.

The checkpoints existed. Nothing connected a relaunch to them.

## The three causes

### (a) The checkpoint is named after the worktree, not after the session

The checkpoint ref is derived from the work branch
(`sandbox-delivery.ts`'s `checkpointBranchOf(branch)` ->
`agentproto-checkpoint/wt/<slug>`). The worktree slug is minted at spawn
(`randomBytes(4).toString("hex")`) and lives only in the box's git refs. The
session id, the task it was working on and the label that a relaunch would
recognise are nowhere in that name, and nothing in the session metadata
pointed back at the ref that held the snapshot.

Consequence: knowing that "some" checkpoint exists does not tell a relaunch
WHICH one belongs to the session it is replacing. A worktree-scoped name
cannot answer "what was this session doing when it died".

### (b) A relaunch does not read the last checkpoint

Two relaunch paths exist and neither read the checkpoint:

- `session_restart` (`session-restart-core.ts`) restarts a sandbox session.
  The fresh box re-clones the workspace and checks out the work branch, but
  the uncommitted work captured by the snapshot only comes back through the
  branch-derived restore (`restoreCheckpointSteps`), which is a
  branch-shape guess, not a pointer to "the checkpoint this session took".
- A brand new `agent_start` has no link to the dead session at all: nothing
  in its input names the session it continues, and nothing in the spawn
  consults the dead session's metadata. The new session therefore starts
  from the base branch (`main`), and the work is gone from the agent's point
  of view even though the snapshot is still on the remote.

### (c) The crashes themselves

- The adapter store of a 724 MB session exceeds the 20 MB limit.
- The E2B box expires (keepalive).
- `turn-retry: session error`.

These are the triggers, not the reason the work was lost: a crash is exactly
when the checkpoint matters most. A resume path that works only for a
graceful restart does not cover a crash.

## The target design

1. **The session remembers its checkpoint.** When the daemon creates a
   checkpoint, the ref of the snapshot (plus its sha, the branch and the
   session it belongs to) is written into the session metadata
   (`SessionDescriptor.lastCheckpoint`). The link is written by the same
   code path that creates the checkpoint (`registry.recordSandboxCheckpoint`),
   so it cannot drift from the checkpoint itself.
2. **A relaunch resolves that link.**
   - `session_restart` of a dead box: the fresh box restores the recorded
     ref with `git restore --source=<ref>` instead of guessing from the
     branch.
   - A new `agent_start` linked to a dead session (explicit `resumeFrom.
     sessionId`, or a `resumeFrom.label` / `resumeFrom.taskId` correlation
     against the dead sessions carrying that key) restores the same recorded
     ref, and reuses the dead session's work branch so the pushed commits
     come back as commits.
   - The correlation key travels with the session: `resumeFrom.taskId` is
     stamped on the new session (`SessionDescriptor.taskId`), so the NEXT
     relaunch finds it the same way.
3. **A test proves the resume.** A simulated crash: a git repo, a snapshot
   commit on a checkpoint ref, the worktree wiped (the crash), then the
   restore command built by the runtime. The file the crashed session was
   writing comes back, byte for byte.

## The implementation

### `packages/runtime/src/checkpoint-resume.ts` (new)

- `SessionCheckpointRef`: `{ ref, sha?, branch?, at, sessionId?, taskId?,
  label? }` - the session-metadata shape of "the last checkpoint of this
  session".
- `checkpointRefFromRecord(record, ctx)`: derive the ref from a
  `SandboxDeliveryRecord` (only a checkpoint that actually reached the
  remote counts).
- `latestCheckpointRef(desc)`: the session's last checkpoint - the explicit
  `lastCheckpoint` first, the recorded checkpoint/delivery records as a
  fallback (older rows, or a daemon that restarted before this change).
- `buildCheckpointRestoreCommand({ checkoutDir, ref, sha? })`: the
  `git restore --source=<ref> --staged --worktree -- .` command, guarded by
  a ref existence check, an optional sha check, and a clean-tree check.
- `planCheckpointResumeRestore(...)`: the in-box setup step.
- `resolveResumeSource(...)`: pick the dead session a relaunch continues
  (explicit id first, then the correlation keys - task id, then label -
  against the DEAD sessions that carry a checkpoint) and its checkpoint. A
  live session is never a resume source.

### Wiring

- `sessions.ts`: `SessionDescriptor.lastCheckpoint`;
  `registry.recordSandboxCheckpoint` (and the delivery record) fill it in
  and persist it.
- `sandbox-workspace-remote.ts`: `planSandboxWorkspace` accepts a
  `checkpointResume` and appends the restore step after the checkout.
- `session-spawn.ts`: `agent_start.resumeFrom`
  (`{ sessionId?, label?, taskId? }`) resolves the dead session's checkpoint
  and passes it to the boot; the work branch of the dead session is reused
  when the spawn does not name one, and the task id is stamped on the new
  session so the next relaunch can correlate the same way.
- `session-restart-core.ts`: the fresh-box path passes the recorded
  checkpoint of the dead session to the boot.
- `agent-start-schema.ts`: the `resumeFrom` field on `agent_start`.

### Boundaries

- The restore is a best effort step, never fatal: a missing ref, a dirty
  tree or a fetch failure leaves the session where it is, with a notice.
- The restored tree is the snapshot's tree: the uncommitted work comes back
  as uncommitted changes (like the existing branch-derived restore), and the
  pushed commits come back as commits when the work branch is reused.
- Only a checkpoint that reached the remote is restorable. A checkpoint
  that only exists as a host-side bundle is not silently faked.

## Crash causes that stay out of scope of this change

The 724 MB adapter store, the E2B expiry and the `turn-retry: session
error` are tracked separately. This change makes the work survive them: the
resume does not depend on the box being alive, on the adapter store being
small, or on the retry policy.

## Tests

`packages/runtime/src/__tests__/checkpoint-resume.test.ts`:

- the restore command is a `git restore --source=<ref>`;
- a simulated crash (snapshot commit, wiped worktree) is repaired by the
  command: the file is back;
- the session metadata records the checkpoint ref when the daemon creates
  the checkpoint;
- a relaunch linked to a dead session resolves that session's checkpoint
  (explicit id, label correlation and task id correlation), and a live
  session is never resumed;
- a relaunch that matches no dead session starts from the base branch (no
  restore step at all).
