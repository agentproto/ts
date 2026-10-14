/**
 * Get a sandbox session's work out of the box before the box is torn down.
 *
 * Runs from the sandbox proxy's `close()`, after the box's agent session is
 * killed and before the box is stopped or paused, and also as a periodic
 * CHECKPOINT while the session is alive (`mode: "checkpoint"`: on a timer, at
 * each turn end, and once more when the box daemon stops answering) — a box
 * can die outside `close()` (an OOM-killed daemon, an expired VM), and work
 * that only ever left the box at teardown died with it. For a session that
 * has a work branch (`wt/<slug>`, cut by `sandbox-workspace-remote`):
 *
 *   1. probe how many commits the branch is ahead of its recorded base, and
 *      snapshot any UNCOMMITTED work as a commit object (built through a
 *      throwaway index: the agent's index, worktree and branch are never
 *      touched) parked at {@link SNAPSHOT_REF};
 *   2. push the branch to `origin` when it is ahead, and force-push the
 *      snapshot to `agentproto-checkpoint/<branch>` when there is one;
 *   3. when a push did not land (or could not be tried), `git bundle` the
 *      `base..tip` range and pull it to the host as a safety net;
 *   4. when the checkout is clean (no snapshot this run) and the work branch
 *      is safe on the remote, delete the now-stale `agentproto-checkpoint/
 *      <branch>` so it does not pile up on the remote forever.
 *
 * A fresh box checking the same branch out again (`sandbox-workspace-remote`)
 * picks the pushed branch up and re-applies the checkpoint snapshot as
 * uncommitted changes, so a restart on a new box resumes where the dead one
 * stopped.
 *
 * Every outcome is reported, never thrown: teardown must not be blocked by a
 * delivery problem, and the record is what tells a human where the work is.
 * No token is handled here — pushes rely on the credential helper set up at
 * clone time.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  CHECKPOINT_BRANCH_PREFIX,
  describeExecFailure,
  learnWorkBranch,
  shellQuote,
  type SandboxExec,
} from "./sandbox-workspace-remote.js"

export { CHECKPOINT_BRANCH_PREFIX }

export const DELIVERY_BUNDLE_FILE = "delivery.bundle"
export const DELIVERY_RECORD_FILE = "delivery.json"
export const CHECKPOINT_BUNDLE_FILE = "checkpoint.bundle"
export const CHECKPOINT_RECORD_FILE = "checkpoint.json"
/** Box-local ref the latest snapshot commit is parked at (outside `refs/heads`,
 *  so it never shows up as a branch of the agent's own). */
export const SNAPSHOT_REF = "refs/agentproto/checkpoint"
/** Bundles above this are left in the box and reported, not downloaded. */
export const DEFAULT_BUNDLE_MAX_BYTES = 50 * 1024 * 1024

const BOX_BUNDLE_PATH = "/tmp/agentproto-delivery.bundle"
const BOX_CHECKPOINT_BUNDLE_PATH = "/tmp/agentproto-checkpoint.bundle"
const PROBE_TIMEOUT_MS = 30_000
const PUSH_TIMEOUT_MS = 90_000
const BUNDLE_TIMEOUT_MS = 60_000
/** Wall-clock cap on the WHOLE delivery: the box keeps billing until teardown
 *  finishes, so every step's timeout is also capped by what is left of this.
 *  Sized to fit probe + push + the bundle reserve with room to spare. */
export const DEFAULT_DELIVERY_DEADLINE_MS = 240_000
/** Slice of the deadline the push may never eat into: the bundle (create +
 *  download of up to 50 MiB) is the fallback for a push that hangs or fails. */
export const DEFAULT_BUNDLE_RESERVE_MS = 90_000
/** A checkpoint runs while the agent works: keep it well inside one interval. */
export const DEFAULT_CHECKPOINT_DEADLINE_MS = 120_000

/** The remote branch carrying `branch`'s uncommitted-work snapshot.
 *  `refPrefix` defaults to {@link CHECKPOINT_BRANCH_PREFIX} — the value
 *  every checkpoint used before it became configurable
 *  ({@link SandboxCheckpointConfig.refPrefix}); passing a custom prefix only
 *  changes where a FUTURE checkpoint lands, so the caller is responsible for
 *  also using it when reading a checkpoint back (`sandbox-workspace-remote.
 *  ts`'s `planSandboxWorkspace` takes the same `refPrefix` for that reason). */
export function checkpointBranchOf(branch: string, refPrefix: string = CHECKPOINT_BRANCH_PREFIX): string {
  return `${refPrefix}${branch}`
}

export interface SandboxDeliveryTarget {
  checkoutDir: string
  /** `wt/<slug>` */
  branch: string
  /** Commit the branch was cut from. */
  baseSha: string
}

export type DeliveryPushStatus = "pushed" | "skipped" | "failed"
export type DeliveryBundleStatus = "saved" | "skipped" | "failed"
export type DeliveryMode = "delivery" | "checkpoint"

export interface SandboxDeliveryRecord {
  at: string
  branch: string
  baseSha: string
  /** Commits on the branch beyond the base; absent when the probe failed. */
  ahead?: number
  /** Uncommitted paths in the checkout. Delivered only through
   *  {@link checkpoint} — absent there, they stayed in the box. */
  uncommittedFiles?: number
  /** `"checkpoint"` for a periodic snapshot taken while the session runs;
   *  absent for the teardown delivery. */
  mode?: "checkpoint"
  push: { status: DeliveryPushStatus; detail?: string }
  /** Snapshot of the uncommitted work, force-pushed to
   *  `agentproto-checkpoint/<branch>`. Absent when the checkout was clean. */
  checkpoint?: { status: DeliveryPushStatus; ref: string; sha?: string; detail?: string }
  /** Best-effort deletion of the checkpoint branch, once the checkout was
   *  clean and the work branch was safe on the remote — see
   *  {@link buildCheckpointDeleteCommand}. Never blocks teardown. */
  checkpointCleanup?: { status: "deleted" | "absent" | "failed"; ref: string; detail?: string }
  /** Identity of the delivered state (HEAD, snapshot tree, ahead count): a
   *  checkpoint whose key matches the previous fully-delivered one skips the
   *  pushes. Absent when the probe failed. */
  key?: string
  /** True when a checkpoint found nothing new since the last delivered one. */
  unchanged?: boolean
  bundle: { status: DeliveryBundleStatus; path?: string; bytes?: number; detail?: string }
  /** Turn count this checkpoint/delivery was taken after, when the caller
   *  knew one (`sandbox-agent-session-proxy.ts`'s `turnsSent`) — also baked
   *  into the snapshot commit message. Absent when no turn context was
   *  given (a bare periodic tick, or a call outside the proxy). */
  turn?: number
}

export interface DeliveryProbe {
  ahead: number
  uncommitted: number
  /** HEAD at probe time. */
  head?: string
  /** Commit snapshotting the uncommitted work (parent: HEAD), parked at
   *  {@link SNAPSHOT_REF}. Absent for a clean checkout or a failed snapshot. */
  snapshot?: string
  /** Tree of {@link snapshot} — stable across snapshots of the same content,
   *  unlike the commit sha (which carries a timestamp). */
  snapshotTree?: string
}

/**
 * Probe the branch and snapshot uncommitted work in one round trip. The
 * snapshot goes through a COPY of the index (`GIT_INDEX_FILE`), so `git add
 * -A` stages nothing in the agent's own index; `.gitignore`d paths
 * (node_modules, dist) stay out. A failing snapshot never fails the probe:
 * commits can still be delivered without it.
 */
export function buildProbeCommand(
  target: SandboxDeliveryTarget,
  opts?: {
    /** `false` reverts to the pre-checkpoint behaviour: only COUNT
     *  uncommitted files, never snapshot/commit them. Default true. Driven
     *  by {@link ResolvedSandboxCheckpointConfig.onTeardown} for the
     *  teardown delivery call — `"teardown"` absent from `on` means
     *  "deliver the branch, but don't bother rescuing uncommitted work". */
    snapshotUncommitted?: boolean
    /** Recorded in the snapshot commit message when taking a checkpoint
     *  mid-session (`sandbox-agent-session-proxy.ts`'s `turnsSent`) — purely
     *  a human-readable breadcrumb, not parsed back. */
    turn?: number
  },
): string {
  const snapshotUncommitted = opts?.snapshotUncommitted ?? true
  const range = shellQuote(`${target.baseSha}..refs/heads/${target.branch}`)
  if (!snapshotUncommitted) {
    return (
      `cd ${shellQuote(target.checkoutDir)} && ` +
      `echo "ahead=$(git rev-list --count ${range})" && ` +
      `n=$(git status --porcelain | wc -l | tr -d ' ') && echo "uncommitted=$n" && ` +
      `echo "head=$(git rev-parse HEAD)"`
    )
  }
  const turnSuffix = opts?.turn !== undefined ? ` turn ${opts.turn}` : ""
  const message = shellQuote(`agentproto checkpoint: uncommitted work on ${target.branch}${turnSuffix}`)
  const snapshot =
    `idx=$(mktemp -u) && { cp "$(git rev-parse --git-path index)" "$idx" 2>/dev/null || true; } && ` +
    `GIT_INDEX_FILE="$idx" git add -A && tree=$(GIT_INDEX_FILE="$idx" git write-tree) && ` +
    `snap=$(git commit-tree "$tree" -p HEAD -m ${message}) && ` +
    `git update-ref ${SNAPSHOT_REF} "$snap" && echo "snapshot=$snap" && echo "tree=$tree"`
  return (
    `cd ${shellQuote(target.checkoutDir)} && ` +
    `echo "ahead=$(git rev-list --count ${range})" && ` +
    `n=$(git status --porcelain | wc -l | tr -d ' ') && echo "uncommitted=$n" && ` +
    `echo "head=$(git rev-parse HEAD)" && ` +
    `if [ "$n" -gt 0 ]; then { ${snapshot}; } || echo "snapshot=failed"; rm -f "$idx"; fi`
  )
}

export function parseProbe(stdout: string): DeliveryProbe | undefined {
  const ahead = /^ahead=(\d+)$/m.exec(stdout)
  const uncommitted = /^uncommitted=(\d+)$/m.exec(stdout)
  if (!ahead) return undefined
  const head = /^head=([0-9a-f]{40,64})$/m.exec(stdout)
  const snapshot = /^snapshot=([0-9a-f]{40,64})$/m.exec(stdout)
  const tree = /^tree=([0-9a-f]{40,64})$/m.exec(stdout)
  return {
    ahead: Number(ahead[1]),
    uncommitted: uncommitted ? Number(uncommitted[1]) : 0,
    ...(head ? { head: head[1] } : {}),
    ...(snapshot ? { snapshot: snapshot[1] } : {}),
    ...(snapshot && tree ? { snapshotTree: tree[1] } : {}),
  }
}

/** Identity of what a delivery would publish — see `SandboxDeliveryRecord.key`. */
export function deliveryKey(probe: DeliveryProbe): string {
  return `${probe.head ?? "?"}:${probe.ahead}:${probe.snapshotTree ?? "clean"}`
}

/** Every push from the box skips client-side hooks: a checkpoint or teardown
 *  delivery is a safety-net backup, and a repo's `pre-push` gate (e.g. one
 *  that requires a changeset) must not stop it from landing. */
const PUSH = "push --no-verify"

export function buildPushCommand(target: SandboxDeliveryTarget): string {
  return `git -C ${shellQuote(target.checkoutDir)} ${PUSH} -u origin ${shellQuote(target.branch)}`
}

/** Force-push the snapshot: each checkpoint replaces the previous one.
 *  `refPrefix` — see {@link checkpointBranchOf}. */
export function buildCheckpointPushCommand(target: SandboxDeliveryTarget, refPrefix?: string): string {
  const refspec = shellQuote(`+${SNAPSHOT_REF}:refs/heads/${checkpointBranchOf(target.branch, refPrefix)}`)
  return `git -C ${shellQuote(target.checkoutDir)} ${PUSH} origin ${refspec}`
}

/** Marker {@link buildCheckpointDeleteCommand} prints when the remote no
 *  longer has the checkpoint ref — the delete then still exits 0, but the
 *  runner can tell "was absent" apart from "was deleted". */
export const CHECKPOINT_REF_ABSENT_MARKER = "checkpoint-ref-absent"

/** Delete the checkpoint branch once the work it rescued is safe elsewhere.
 *  A missing remote ref is success, not failure: the exit code is 0 both when
 *  the push deleted it and when `ls-remote` confirms it is already gone;
 *  only a ref that still exists (or cannot be checked) fails. `refPrefix` —
 *  see {@link checkpointBranchOf}. */
export function buildCheckpointDeleteCommand(target: SandboxDeliveryTarget, refPrefix?: string): string {
  const ref = checkpointBranchOf(target.branch, refPrefix)
  return (
    `git -C ${shellQuote(target.checkoutDir)} ${PUSH} origin --delete ${shellQuote(ref)} 2>&1 || ` +
    `{ git ls-remote --exit-code origin ${shellQuote(`refs/heads/${ref}`)} >/dev/null; ` +
    `test $? -eq 2 && echo ${CHECKPOINT_REF_ABSENT_MARKER}; }`
  )
}

/** Creates the bundle and prints its size in bytes. `tip` defaults to the
 *  branch; a snapshot delivery bundles up to {@link SNAPSHOT_REF} instead. */
export function buildBundleCommand(
  target: SandboxDeliveryTarget,
  tip: string = target.branch,
  boxPath: string = BOX_BUNDLE_PATH,
): string {
  const range = shellQuote(`${target.baseSha}..${tip}`)
  return (
    `git -C ${shellQuote(target.checkoutDir)} bundle create --quiet ${boxPath} ${range} && ` +
    `wc -c < ${boxPath}`
  )
}

/** Push only a branch that actually has commits to publish. */
export function shouldPush(probe: DeliveryProbe): boolean {
  return probe.ahead > 0
}

export type BundleDecision =
  | { action: "bundle" }
  | { action: "skip"; reason: string }

/** The bundle is the fallback for work that did not reach the remote. */
export function decideBundle(input: {
  ahead: number
  pushStatus: DeliveryPushStatus
  canDownload: boolean
  /** A snapshot of uncommitted work exists and its push did not land. */
  snapshotPending?: boolean
}): BundleDecision {
  const snapshotPending = input.snapshotPending === true
  if (input.ahead <= 0 && !snapshotPending) return { action: "skip", reason: "no commits ahead of base" }
  if (input.pushStatus === "pushed" && !snapshotPending) return { action: "skip", reason: "branch was pushed" }
  if (!input.canDownload) {
    return { action: "skip", reason: "provider cannot download files from the box" }
  }
  return { action: "bundle" }
}

/** Whether a bundle of `bytes` may be pulled to the host. */
export function withinBundleLimit(bytes: number, maxBytes: number): boolean {
  return Number.isFinite(bytes) && bytes >= 0 && bytes <= maxBytes
}

export interface RunSandboxDeliveryInput {
  exec: SandboxExec
  /** Absent when the provider cannot download files. */
  readFile?: (path: string) => Promise<Uint8Array>
  target: SandboxDeliveryTarget
  /** Host directory receiving `delivery.bundle` and `delivery.json`. */
  outDir: string
  maxBytes?: number
  /** Overall budget for probe + push + bundle + download. */
  deadlineMs?: number
  /** Part of {@link deadlineMs} the push must leave for the bundle fallback. */
  bundleReserveMs?: number
  now?: () => Date
  /** `"checkpoint"`: a snapshot taken while the session runs — writes
   *  `checkpoint.json`/`checkpoint.bundle` instead of the teardown files and
   *  skips the pushes when {@link previousKey} still describes the box. */
  mode?: DeliveryMode
  /** Key of the last checkpoint whose pushes all landed. */
  previousKey?: string
  /** `false` skips snapshotting uncommitted work (see {@link buildProbeCommand}).
   *  Default true. */
  snapshotUncommitted?: boolean
  /** Remote branch namespace for the checkpoint push — see {@link checkpointBranchOf}. */
  refPrefix?: string
  /** Turn count to stamp on the record/commit message — see {@link SandboxDeliveryRecord.turn}. */
  turn?: number
  /** True when a checkpoint was pushed to the remote earlier in this session.
   *  In `"checkpoint"` mode the stale-checkpoint delete below only runs when
   *  this is true (an idle turn must not pay a delete round trip per tick);
   *  teardown mode deletes regardless. */
  checkpointPushed?: boolean
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Runs `step` with a timeout of at most `capMs`, never past the deadline
 *  (less `reserveMs` kept back for a later step). The race also covers a
 *  provider that ignores the exec timeout and hangs. */
async function withinDeadline<T>(
  deadlineAt: number,
  capMs: number,
  step: (timeoutMs: number) => Promise<T>,
  reserveMs = 0,
): Promise<T> {
  const timeoutMs = Math.min(capMs, deadlineAt - Date.now() - reserveMs)
  if (timeoutMs <= 0) throw new Error("delivery deadline reached")
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("delivery deadline reached")), timeoutMs)
  })
  try {
    return await Promise.race([step(timeoutMs), expired])
  } finally {
    clearTimeout(timer)
  }
}

async function pushBranch(
  exec: SandboxExec,
  target: SandboxDeliveryTarget,
  deadlineAt: number,
  reserveMs: number,
): Promise<SandboxDeliveryRecord["push"]> {
  try {
    const result = await withinDeadline(
      deadlineAt,
      PUSH_TIMEOUT_MS,
      (timeoutMs) => exec({ command: buildPushCommand(target), env: { GIT_TERMINAL_PROMPT: "0" }, timeoutMs }),
      reserveMs,
    )
    return result.exitCode === 0 ? { status: "pushed" } : { status: "failed", detail: describeExecFailure(result) }
  } catch (err) {
    return { status: "failed", detail: errorText(err) }
  }
}

/**
 * The checkpoint branch is stale exactly when the checkout is clean for THIS
 * run (`probe.snapshot === undefined` — a snapshot means uncommitted work was
 * just rescued onto the checkpoint, so it is still needed) AND the work
 * branch is safe on the remote (its push landed, or there was nothing to
 * push). A `"checkpoint"`-mode run only pays the delete's network round trip
 * when a checkpoint was actually pushed earlier in the session.
 */
function shouldCleanupCheckpoint(
  probe: DeliveryProbe,
  record: SandboxDeliveryRecord,
  checkpointMode: boolean,
  checkpointPushed: boolean | undefined,
): boolean {
  if (probe.snapshot !== undefined) return false
  if (!(record.push.status === "pushed" || probe.ahead === 0)) return false
  return !checkpointMode || checkpointPushed === true
}

/** Best-effort delete of the checkpoint branch — never throws, never blocks
 *  teardown; a failure is recorded and the delivery carries on. */
async function cleanupCheckpoint(
  exec: SandboxExec,
  target: SandboxDeliveryTarget,
  refPrefix: string | undefined,
  deadlineAt: number,
): Promise<NonNullable<SandboxDeliveryRecord["checkpointCleanup"]>> {
  const ref = checkpointBranchOf(target.branch, refPrefix)
  try {
    const result = await withinDeadline(deadlineAt, PUSH_TIMEOUT_MS, (timeoutMs) =>
      exec({
        command: buildCheckpointDeleteCommand(target, refPrefix),
        env: { GIT_TERMINAL_PROMPT: "0" },
        timeoutMs,
      }),
    )
    if (result.exitCode !== 0) return { status: "failed", ref, detail: describeExecFailure(result) }
    return result.stdout.includes(CHECKPOINT_REF_ABSENT_MARKER) ? { status: "absent", ref } : { status: "deleted", ref }
  } catch (err) {
    return { status: "failed", ref, detail: errorText(err) }
  }
}

export async function runSandboxDelivery(input: RunSandboxDeliveryInput): Promise<SandboxDeliveryRecord> {
  const { exec, target } = input
  const checkpointMode = input.mode === "checkpoint"
  const files = checkpointMode
    ? { record: CHECKPOINT_RECORD_FILE, bundle: CHECKPOINT_BUNDLE_FILE, boxBundle: BOX_CHECKPOINT_BUNDLE_PATH }
    : { record: DELIVERY_RECORD_FILE, bundle: DELIVERY_BUNDLE_FILE, boxBundle: BOX_BUNDLE_PATH }
  const persist = (r: SandboxDeliveryRecord) => persistRecord(r, input.outDir, files.record)
  const maxBytes = input.maxBytes ?? DEFAULT_BUNDLE_MAX_BYTES
  const deadlineAt =
    Date.now() + (input.deadlineMs ?? (checkpointMode ? DEFAULT_CHECKPOINT_DEADLINE_MS : DEFAULT_DELIVERY_DEADLINE_MS))
  const bundleReserveMs = input.bundleReserveMs ?? DEFAULT_BUNDLE_RESERVE_MS
  const record: SandboxDeliveryRecord = {
    at: (input.now?.() ?? new Date()).toISOString(),
    branch: target.branch,
    baseSha: target.baseSha,
    ...(checkpointMode ? { mode: "checkpoint" as const } : {}),
    ...(input.turn !== undefined ? { turn: input.turn } : {}),
    push: { status: "skipped" },
    bundle: { status: "skipped" },
  }

  let probe: DeliveryProbe | undefined
  try {
    const result = await withinDeadline(deadlineAt, PROBE_TIMEOUT_MS, (timeoutMs) =>
      // GIT_OPTIONAL_LOCKS=0: `git status` must not take the agent's
      // index.lock while it may be committing.
      exec({
        command: buildProbeCommand(target, { snapshotUncommitted: input.snapshotUncommitted, turn: input.turn }),
        env: { GIT_OPTIONAL_LOCKS: "0" },
        timeoutMs,
      }),
    )
    probe = result.exitCode === 0 ? parseProbe(result.stdout) : undefined
    if (!probe) {
      const detail = `probe failed: ${result.exitCode === 0 ? "unparseable output" : describeExecFailure(result)}`
      record.push = { status: "failed", detail }
      record.bundle = { status: "skipped", detail: "probe failed" }
      return await persist(record)
    }
  } catch (err) {
    record.push = { status: "failed", detail: `probe failed: ${errorText(err)}` }
    record.bundle = { status: "skipped", detail: "probe failed" }
    return await persist(record)
  }
  record.ahead = probe.ahead
  record.uncommittedFiles = probe.uncommitted
  record.key = deliveryKey(probe)

  if (checkpointMode && input.previousKey !== undefined && input.previousKey === record.key) {
    record.unchanged = true
    record.push = { status: "skipped", detail: "unchanged since the last checkpoint" }
    record.bundle = { status: "skipped", detail: "unchanged since the last checkpoint" }
    return await persist(record)
  }

  if (!shouldPush(probe) && probe.snapshot === undefined) {
    record.push = { status: "skipped", detail: "no commits ahead of base" }
    record.bundle = { status: "skipped", detail: "no commits ahead of base" }
    // A session that committed nothing this turn but pushed a checkpoint
    // earlier still has a stale checkpoint branch to clean up.
    if (shouldCleanupCheckpoint(probe, record, checkpointMode, input.checkpointPushed)) {
      record.checkpointCleanup = await cleanupCheckpoint(exec, target, input.refPrefix, deadlineAt)
    }
    return await persist(record)
  }

  if (!shouldPush(probe)) {
    record.push = { status: "skipped", detail: "no commits ahead of base" }
  } else {
    record.push = await pushBranch(exec, target, deadlineAt, input.readFile ? bundleReserveMs : 0)
  }

  if (probe.snapshot !== undefined) {
    const ref = checkpointBranchOf(target.branch, input.refPrefix)
    try {
      const result = await withinDeadline(deadlineAt, PUSH_TIMEOUT_MS, (timeoutMs) =>
        exec({
          command: buildCheckpointPushCommand(target, input.refPrefix),
          env: { GIT_TERMINAL_PROMPT: "0" },
          timeoutMs,
        }),
        input.readFile ? bundleReserveMs : 0,
      )
      record.checkpoint =
        result.exitCode === 0
          ? { status: "pushed", ref, sha: probe.snapshot }
          : { status: "failed", ref, sha: probe.snapshot, detail: describeExecFailure(result) }
    } catch (err) {
      record.checkpoint = { status: "failed", ref, sha: probe.snapshot, detail: errorText(err) }
    }
  } else if (shouldCleanupCheckpoint(probe, record, checkpointMode, input.checkpointPushed)) {
    // Clean checkout with the work branch safe on the remote: a checkpoint
    // pushed earlier in the session is now stale — delete it.
    record.checkpointCleanup = await cleanupCheckpoint(exec, target, input.refPrefix, deadlineAt)
  }
  const snapshotPending = record.checkpoint !== undefined && record.checkpoint.status !== "pushed"

  const decision = decideBundle({
    ahead: probe.ahead,
    pushStatus: record.push.status,
    canDownload: input.readFile !== undefined,
    snapshotPending,
  })
  if (decision.action === "skip") {
    record.bundle = { status: "skipped", detail: decision.reason }
    return await persist(record)
  }

  try {
    const made = await withinDeadline(deadlineAt, BUNDLE_TIMEOUT_MS, (timeoutMs) =>
      exec({
        command: buildBundleCommand(target, probe.snapshot !== undefined ? SNAPSHOT_REF : target.branch, files.boxBundle),
        timeoutMs,
      }),
    )
    if (made.exitCode !== 0) {
      record.bundle = { status: "failed", detail: `git bundle failed: ${describeExecFailure(made)}` }
      return await persist(record)
    }
    const bytes = Number(made.stdout.trim())
    if (!withinBundleLimit(bytes, maxBytes)) {
      record.bundle = {
        status: "skipped",
        detail: Number.isFinite(bytes)
          ? `bundle is ${bytes} bytes, over the ${maxBytes} byte limit; left at ${files.boxBundle} in the box`
          : "could not read the bundle size",
      }
      return await persist(record)
    }
    const data = await withinDeadline(deadlineAt, Infinity, () => input.readFile!(files.boxBundle))
    await mkdir(input.outDir, { recursive: true })
    const path = join(input.outDir, files.bundle)
    await writeFile(path, data)
    record.bundle = { status: "saved", path, bytes: data.byteLength }
  } catch (err) {
    record.bundle = { status: "failed", detail: errorText(err) }
  }
  return await persist(record)
}

/** The proxy's `onBeforeTeardown` hook for a session whose branch lives in a box.
 *  Shared by the spawn path and the restart path so both deliver identically. */
export function createDeliveryHook(
  input: Omit<RunSandboxDeliveryInput, "deadlineMs" | "now"> & {
    onDelivery?: (record: SandboxDeliveryRecord) => void
  },
): () => Promise<void> {
  const { onDelivery, ...run } = input
  return async () => {
    onDelivery?.(await runSandboxDelivery(run))
  }
}

/** Whether every piece of work the record saw reached the remote or the host. */
export function isFullyDelivered(record: SandboxDeliveryRecord): boolean {
  if (record.key === undefined) return false
  if (record.unchanged) return true
  const commitsSafe = (record.ahead ?? 0) <= 0 || record.push.status === "pushed"
  const snapshotSafe = record.checkpoint === undefined || record.checkpoint.status === "pushed"
  return (commitsSafe && snapshotSafe) || record.bundle.status === "saved"
}

export interface SandboxCheckpointer {
  /** Take one checkpoint now. Concurrent calls share the in-flight run.
   *  `turn`, when given, is stamped onto the record and the snapshot commit
   *  message (see {@link SandboxDeliveryRecord.turn}) — a coalesced call
   *  (one already in flight) keeps whichever turn number started IT, not
   *  the caller's. */
  run(turn?: number): Promise<SandboxDeliveryRecord>
}

/**
 * Periodic checkpoints for one box: remembers the last fully-delivered key so
 * an idle session costs one probe per tick, serializes runs so a turn-end
 * checkpoint never races the timer's, and tracks whether a checkpoint was
 * ever pushed this session (so a later clean probe knows there is a stale
 * checkpoint branch to delete — see {@link RunSandboxDeliveryInput.checkpointPushed}).
 */
export function createSandboxCheckpointer(
  input: Omit<RunSandboxDeliveryInput, "mode" | "previousKey"> & {
    onCheckpoint?: (record: SandboxDeliveryRecord) => void
  },
): SandboxCheckpointer {
  const { onCheckpoint, ...run } = input
  let lastKey: string | undefined
  let checkpointPushed = input.checkpointPushed === true
  let inFlight: Promise<SandboxDeliveryRecord> | undefined
  return {
    run(turn) {
      if (inFlight) return inFlight
      inFlight = (async () => {
        const record = await runSandboxDelivery({
          ...run,
          mode: "checkpoint",
          checkpointPushed,
          ...(lastKey !== undefined ? { previousKey: lastKey } : {}),
          ...(turn !== undefined ? { turn } : {}),
        })
        if (isFullyDelivered(record)) lastKey = record.key
        if (record.checkpoint?.status === "pushed") checkpointPushed = true
        try {
          onCheckpoint?.(record)
        } catch {
          // reporting is best-effort
        }
        return record
      })().finally(() => {
        inFlight = undefined
      })
      return inFlight
    },
  }
}

/** Spacing of periodic checkpoints. `AGENTPROTO_SANDBOX_CHECKPOINT_INTERVAL_MS`
 *  overrides it; `0` turns periodic and turn-end checkpoints off. Legacy
 *  knob — {@link SandboxCheckpointConfig.minIntervalMs} is the config-object
 *  equivalent and wins when set; this env var remains the ultimate fallback
 *  (see {@link resolveSandboxCheckpointConfig}) so an existing deployment
 *  that only ever touched it keeps behaving identically. */
export const DEFAULT_CHECKPOINT_INTERVAL_MS = 5 * 60_000
export const CHECKPOINT_INTERVAL_ENV = "AGENTPROTO_SANDBOX_CHECKPOINT_INTERVAL_MS"

export function resolveCheckpointIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[CHECKPOINT_INTERVAL_ENV]?.trim()
  if (!raw) return DEFAULT_CHECKPOINT_INTERVAL_MS
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_CHECKPOINT_INTERVAL_MS
}

/**
 * `defaults.sandbox.checkpoint` / `agent_start({ sandboxCheckpoint })` — the
 * daemon-config/per-spawn knob replacing the single
 * `AGENTPROTO_SANDBOX_CHECKPOINT_INTERVAL_MS` env var with a composable
 * object. See {@link resolveSandboxCheckpointConfig} for the global →
 * per-spawn precedence.
 */
export interface SandboxCheckpointConfig {
  /** Master switch. Default true. */
  enabled?: boolean
  /** Which triggers take a checkpoint. `"turn-end"` wires the periodic
   *  timer AND the per-turn hook (today's single on/off knob — there is no
   *  separate dial for the timer vs. the hook); absent, both stay off.
   *  `"teardown"` makes the teardown delivery SNAPSHOT uncommitted work
   *  (not just count it, {@link buildProbeCommand}'s `snapshotUncommitted`);
   *  absent, teardown still pushes the branch but leaves uncommitted work
   *  in the box uncounted-for-rescue, matching the pre-checkpoint behaviour.
   *  Default both. */
  on?: Array<"turn-end" | "teardown">
  /** Remote branch namespace the snapshot is force-pushed to
   *  (`<refPrefix><branch>`). Default {@link CHECKPOINT_BRANCH_PREFIX} —
   *  changing this only affects a FUTURE checkpoint; see
   *  {@link checkpointBranchOf}. */
  refPrefix?: string
  /** Periodic-checkpoint timer interval (replaces
   *  `AGENTPROTO_SANDBOX_CHECKPOINT_INTERVAL_MS`). Default
   *  {@link DEFAULT_CHECKPOINT_INTERVAL_MS}. */
  minIntervalMs?: number
  /** Per-checkpoint wall-clock budget (`runSandboxDelivery`'s `deadlineMs`).
   *  Default {@link DEFAULT_CHECKPOINT_DEADLINE_MS}. */
  timeoutMs?: number
}

export interface ResolvedSandboxCheckpointConfig {
  enabled: boolean
  /** Resolved `enabled && on.includes("turn-end")` — the proxy wires the
   *  timer + per-turn hook iff this is true. */
  onTurnEnd: boolean
  /** Resolved `enabled && on.includes("teardown")` — whether the teardown
   *  delivery snapshots uncommitted work. */
  onTeardown: boolean
  refPrefix: string
  minIntervalMs: number
  timeoutMs: number
}

const DEFAULT_CHECKPOINT_ON: ReadonlyArray<"turn-end" | "teardown"> = ["turn-end", "teardown"]

/**
 * `global → per-spawn` resolution, same precedence shape as
 * `resolveSpawnDefaults` (per-spawn wins key-by-key). `perSpawn: false`
 * (`agent_start({ sandboxCheckpoint: false })`) turns everything off for
 * this spawn regardless of the global config. The legacy
 * `AGENTPROTO_SANDBOX_CHECKPOINT_INTERVAL_MS` env var still seeds
 * `minIntervalMs` when NEITHER config layer sets it, so an existing
 * deployment that only ever touched the env var keeps working unchanged.
 */
export function resolveSandboxCheckpointConfig(
  global: SandboxCheckpointConfig | undefined,
  perSpawn: SandboxCheckpointConfig | false | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSandboxCheckpointConfig {
  const refPrefix = perSpawn === false ? global?.refPrefix : perSpawn?.refPrefix ?? global?.refPrefix
  const minIntervalMs =
    (perSpawn === false ? global?.minIntervalMs : perSpawn?.minIntervalMs ?? global?.minIntervalMs) ??
    resolveCheckpointIntervalMs(env)
  const timeoutMs = (perSpawn === false ? global?.timeoutMs : perSpawn?.timeoutMs ?? global?.timeoutMs) ??
    DEFAULT_CHECKPOINT_DEADLINE_MS
  if (perSpawn === false) {
    return {
      enabled: false,
      onTurnEnd: false,
      onTeardown: false,
      refPrefix: refPrefix ?? CHECKPOINT_BRANCH_PREFIX,
      minIntervalMs,
      timeoutMs,
    }
  }
  const enabled = perSpawn?.enabled ?? global?.enabled ?? true
  const on = perSpawn?.on ?? global?.on ?? DEFAULT_CHECKPOINT_ON
  return {
    enabled,
    // `minIntervalMs <= 0` keeps disabling the timer + per-turn hook on its
    // own — the pre-config-object off-switch (`AGENTPROTO_SANDBOX_
    // CHECKPOINT_INTERVAL_MS=0`), preserved so an existing deployment that
    // only ever set the env var keeps behaving identically.
    onTurnEnd: enabled && on.includes("turn-end") && minIntervalMs > 0,
    onTeardown: enabled && on.includes("teardown"),
    refPrefix: refPrefix ?? CHECKPOINT_BRANCH_PREFIX,
    minIntervalMs,
    timeoutMs,
  }
}

/** The proxy's `checkpoint` option for a box with a work branch — empty when
 *  `config.onTurnEnd` is false. Shared by the spawn and restart paths. */
export function sandboxCheckpointOpts(
  input: Omit<Parameters<typeof createSandboxCheckpointer>[0], "deadlineMs" | "refPrefix">,
  config: ResolvedSandboxCheckpointConfig,
): { checkpoint?: { run: (turn?: number) => Promise<SandboxDeliveryRecord>; intervalMs: number } } {
  if (!config.onTurnEnd) return {}
  const checkpointer = createSandboxCheckpointer({
    ...input,
    deadlineMs: config.timeoutMs,
    refPrefix: config.refPrefix,
  })
  return { checkpoint: { run: (turn) => checkpointer.run(turn), intervalMs: config.minIntervalMs } }
}

/**
 * The proxy's `onBeforeTeardown` + `checkpoint` options for a box with a work
 * branch, with the turn-end safety net: before each checkpoint, read the
 * checkout's CURRENT branch and — when it is a `wt/` branch other than the
 * recorded target (the agent cut or switched branches by hand) — adopt it as
 * the delivery target. The checkpoint that follows, and the teardown
 * delivery, then push the branch the work actually lives on, and
 * `onTargetChanged` lets the caller persist it on the session record so a
 * restart resumes it. Shared by the spawn and restart paths.
 */
export function trackedSandboxDeliveryOpts(input: {
  exec: SandboxExec
  readFile?: (path: string) => Promise<Uint8Array>
  target: SandboxDeliveryTarget
  outDir: string
  config: ResolvedSandboxCheckpointConfig
  /** Ref the learned branch's fork point is computed against. */
  baseRef: string
  onDelivery?: (record: SandboxDeliveryRecord) => void
  onCheckpoint?: (record: SandboxDeliveryRecord) => void
  onTargetChanged?: (target: SandboxDeliveryTarget) => void
}): {
  onBeforeTeardown: () => Promise<void>
  checkpoint?: { run: (turn?: number) => Promise<unknown>; intervalMs: number }
} {
  let target = input.target
  const base = {
    exec: input.exec,
    ...(input.readFile ? { readFile: input.readFile } : {}),
    outDir: input.outDir,
  }
  const buildCheckpoint = () =>
    sandboxCheckpointOpts(
      { ...base, target, ...(input.onCheckpoint ? { onCheckpoint: input.onCheckpoint } : {}) },
      input.config,
    ).checkpoint
  let checkpoint = buildCheckpoint()
  const onBeforeTeardown = () =>
    createDeliveryHook({
      ...base,
      target,
      snapshotUncommitted: input.config.onTeardown,
      ...(input.onDelivery ? { onDelivery: input.onDelivery } : {}),
    })()
  if (!checkpoint) return { onBeforeTeardown }

  const learn = async () => {
    const found = await learnWorkBranch(input.exec, target.checkoutDir, input.baseRef)
    if (!found || found.branch === target.branch) return
    target = { checkoutDir: target.checkoutDir, branch: found.branch, baseSha: found.baseSha ?? target.baseSha }
    // A fresh checkpointer: its unchanged-since-last-checkpoint key does not
    // include the branch name, so the old one would skip pushing the new branch.
    checkpoint = buildCheckpoint()
    try {
      input.onTargetChanged?.(target)
    } catch {
      // recording is best-effort
    }
  }
  return {
    onBeforeTeardown,
    checkpoint: {
      intervalMs: input.config.minIntervalMs,
      run: async (turn) => {
        await learn()
        return checkpoint!.run(turn)
      },
    },
  }
}

async function persistRecord(
  record: SandboxDeliveryRecord,
  outDir: string,
  file: string,
): Promise<SandboxDeliveryRecord> {
  try {
    await mkdir(outDir, { recursive: true })
    await writeFile(join(outDir, file), `${JSON.stringify(record, null, 2)}\n`)
  } catch {
    // the record is also stamped on the descriptor; a disk failure here is not fatal
  }
  return record
}

/** One-line summary for the session's transcript. */
export function formatDeliveryNotice(record: SandboxDeliveryRecord): string {
  const parts = [
    `[sandbox ${record.mode === "checkpoint" ? "checkpoint" : "delivery"}] ${record.branch}`,
    record.ahead === undefined ? "state unknown" : `${record.ahead} commit(s) ahead of ${record.baseSha.slice(0, 7)}`,
    `push: ${record.push.status}${record.push.detail ? ` (${record.push.detail})` : ""}`,
    `bundle: ${record.bundle.status}${
      record.bundle.path ? ` at ${record.bundle.path}` : record.bundle.detail ? ` (${record.bundle.detail})` : ""
    }`,
  ]
  if (record.checkpoint) {
    parts.push(
      `uncommitted snapshot: ${record.checkpoint.status}${
        record.checkpoint.status === "pushed" ? ` to ${record.checkpoint.ref}` : ""
      }${record.checkpoint.detail ? ` (${record.checkpoint.detail})` : ""}`,
    )
  }
  if (record.checkpointCleanup) {
    parts.push(
      `checkpoint cleanup: ${record.checkpointCleanup.status}${
        record.checkpointCleanup.detail ? ` (${record.checkpointCleanup.detail})` : ""
      }`,
    )
  }
  const uncommittedDelivered =
    record.checkpoint !== undefined && (record.checkpoint.status === "pushed" || record.bundle.status === "saved")
  if (record.uncommittedFiles && !uncommittedDelivered) {
    parts.push(`${record.uncommittedFiles} uncommitted file(s) NOT delivered`)
  }
  return parts.join(" — ")
}

/**
 * Teardown-only rescue notice for the session's PARENT (distinct from
 * {@link formatDeliveryNotice}, which is written into the sandbox session's
 * OWN transcript — a session whose box died has no next turn to read that):
 * names the ref the uncommitted-work snapshot was force-pushed to and a
 * copy-pasteable command to recover it. Undefined when there is nothing to
 * rescue — no uncommitted files, or the snapshot push itself never landed
 * (then the ref doesn't exist and there's no fetch command to give).
 */
export function formatUncommittedRescueNotice(record: SandboxDeliveryRecord): string | undefined {
  if (!record.uncommittedFiles || record.checkpoint?.status !== "pushed") return undefined
  const ref = record.checkpoint.ref
  const sha = record.checkpoint.sha?.slice(0, 7) ?? "?"
  return (
    `[sandbox] ${record.uncommittedFiles} uncommitted file(s) on ${record.branch} were still uncommitted ` +
    `when the box went away — rescued at ${ref} (${sha}). Recover with: ` +
    `git fetch origin ${ref} && git checkout FETCH_HEAD -- .`
  )
}
