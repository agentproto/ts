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
 * A checkpoint additionally carries the adapter's CONVERSATION store: the
 * box-side pack/download in `sandbox-adapter-store.ts` archives the session's
 * isolated adapter-config dir next to `checkpoint.json` as
 * `adapter-store.tar.gz` (recorded on {@link SandboxDeliveryRecord.adapterStore}),
 * so a restart that moves to a fresh box can put the conversation back
 * (`session-restart-core.ts`'s `spawnOnFreshBox`) instead of starting the
 * adapter blank. A store failure never fails the checkpoint.
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
import { commitMessageWithSessionTrailer } from "./pr-provenance.js"
import {
  ADAPTER_STORE_TIMEOUT_MS,
  archiveAdapterStore,
  type AdapterStoreRecord,
} from "./sandbox-adapter-store.js"

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
/** The sandbox's first push clones/uploads whatever the box's work tree has
 *  grown to (node_modules, build artifacts of a whole 72-tool-call turn) —
 *  90 s regularly expired on provider uplink (observed 2026-10-18), so give
 *  it minutes. Capped per step by the enclosing delivery deadline anyway. */
const PUSH_TIMEOUT_MS = 180_000
const BUNDLE_TIMEOUT_MS = 90_000
/** Wall-clock cap on the WHOLE delivery: the box keeps billing until teardown
 *  finishes, so every step's timeout is also capped by what is left of this.
 *  Sized to fit probe + push (180 s) + the bundle reserve with room to spare. */
export const DEFAULT_DELIVERY_DEADLINE_MS = 420_000
/** Slice of the deadline the push may never eat into: the bundle (create +
 *  download of up to 50 MiB) is the fallback for a push that hangs or fails. */
export const DEFAULT_BUNDLE_RESERVE_MS = 90_000
/** A checkpoint runs while the agent works: default to 5 minutes — a
 *  first-turn push of a heavily-worked tree with a node_modules-scale
 *  adapter store regularly exceeded the 120 s default (observed
 *  2026-10-18: "push: failed, delivery deadline reached"). Also the
 *  `defaults.sandbox.checkpoint.timeoutMs` config default; raising it
 *  only costs billing headroom on a slow checkpoint, never correctness. */
export const DEFAULT_CHECKPOINT_DEADLINE_MS = 300_000

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

/**
 * The checkpoint ref namespace a session's snapshots actually live under:
 * the SAME value `resolveSandboxCheckpointConfig` resolved when the session
 * booted: the session's own per-spawn override wins over the daemon's global
 * `defaults.sandbox.checkpoint.refPrefix`, which wins over the legacy
 * default.
 *
 * Readers of a checkpoint (the PR-provenance stamper, looking for the
 * `Agentproto-Session:` trailer on the checkpoint tip) MUST resolve it the
 * same way the writer did, reading `agentproto-checkpoint/<branch>` while
 * the delivery pushed to `custom/<branch>` silently loses every author only
 * the checkpoint knows.
 */
export function checkpointRefPrefixForSession(
  session: { sandboxCheckpointOverride?: { refPrefix?: string } | false } | undefined,
  globalRefPrefix?: string,
): string {
  const override = session?.sandboxCheckpointOverride
  const perSpawn = override && typeof override === "object" ? override.refPrefix : undefined
  return perSpawn ?? globalRefPrefix ?? CHECKPOINT_BRANCH_PREFIX
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

/** DISK-FULL / WEDGED-SESSION RESCUE — remote branch namespace the rescue
 *  push carries everything to: `rescue/<session>` (or
 *  `rescue/<sandboxId>-<session>` when a caller disambiguates). Distinct
 *  from the checkpoint namespace: a rescue is a LAST-resort copy of the
 *  whole checkout state, never the branch a restart would fast-forward. */
export const RESCUE_BRANCH_PREFIX = "rescue/"

/**
 * The host-side rescue push for a wedged session (`run$ not needed): one
 * exec into the box that stages EVERYTHING, commits it with hooks disabled
 * (a full-disk box cannot run hook scripts; the commit may be empty — the
 * push then carries the branch's commits alone) and force-pushes it to the
 * rescue branch. Every step tolerates failure except the final push, whose
 * exit code is the result — a rescue that cannot push reports `failed`
 * and the caller still reports the delivery record's own outcome.
 */
export function buildRescuePushCommand(target: SandboxDeliveryTarget, rescueBranch: string): string {
  const message = shellQuote(`agentproto rescue: state of ${target.branch} before the box went away`)
  return (
    `cd ${shellQuote(target.checkoutDir)} && ` +
    `git add -A && ` +
    `{ git commit --no-verify -m ${message} || ` +
    `echo ${RESCUE_NOTHING_TO_COMMIT_MARKER}: $?; } && ` +
    `git push --no-verify origin ${shellQuote(`HEAD:refs/heads/${rescueBranch}`)}`
  )
}

/** Marker {@link buildRescuePushCommand} prints when `git commit` found
 *  nothing to commit — expected during a rescue, never a failure. */
export const RESCUE_NOTHING_TO_COMMIT_MARKER = "rescue-nothing-to-commit"

export interface SandboxRescueRecord {
  at: string
  branch: string
  /** `rescue/<session>` */
  rescueBranch: string
  status: "pushed" | "failed"
  detail?: string
}

/**
 * Run {@link buildRescuePushCommand} through `exec` and classify the result.
 * Never throws: the outcome is the record, and a failed rescue must not
 * hide whatever the delivery/checkpoint record before it said.
 */
export async function runRescuePush(input: {
  exec: SandboxExec
  target: SandboxDeliveryTarget
  rescueBranch?: string
  now?: () => Date
}): Promise<SandboxRescueRecord> {
  const rescueBranch = input.rescueBranch ?? `${RESCUE_BRANCH_PREFIX}${input.target.branch}` // NOTE: bookkeeping default; the session-bound namespace (`rescue/<session>`, per the prefix's doc) should be passed explicitly by callers that know it — see the proxy's push.
  const record: SandboxRescueRecord = {
    at: (input.now?.() ?? new Date()).toISOString(),
    branch: input.target.branch,
    rescueBranch,
    status: "pushed",
  }
  let result
  try {
    result = await input.exec({
      command: buildRescuePushCommand(input.target, rescueBranch),
      env: { GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: PUSH_TIMEOUT_MS,
    })
  } catch (err) {
    return { ...record, status: "failed", detail: errorText(err) }
  }
  if (result.exitCode !== 0) {
    return { ...record, status: "failed", detail: describeExecFailure(result) }
  }
  return record
}

/**
 * Whether a delivery record left work stranded — the low-disk disk guard's
 * trigger for the host-side rescue push. `undefined` (the checkpoint never
 * ran / fully failed) counts as stranded; `unchanged` never does (the work
 * was already fully delivered earlier); anything else is judged by
 * {@link isFullyDelivered}.
 */
export function rescueWarranted(record: unknown): boolean {
  if (record === undefined || record === null) return true
  if (typeof record !== "object") return true
  const rec = record as SandboxDeliveryRecord
  if (rec.unchanged === true) return false
  return !isFullyDelivered(rec)
}

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
  /** Checkpoint-mode only: the adapter's conversation store, archived next
   *  to the record as `adapter-store.tar.gz` so a fresh-box restart can
   *  restore it (see `sandbox-adapter-store.ts`). Absent on teardown
   *  deliveries and on a checkpoint taken without an
   *  {@link RunSandboxDeliveryInput.adapterStore} input. */
  adapterStore?: AdapterStoreRecord
  /** Teardown-only: outcome of the `Agentproto-Session:` provenance stamp
   *  on the work branch (see {@link buildProvenanceStampCommand}). Absent
   *  when no stamp was attempted (no session id, checkpoint mode, nothing
   *  ahead, or the uncommitted-work snapshot already carries the trailer ,
   *  `"skipped"` then). Attribution only: never part of
   *  {@link isFullyDelivered}. */
  provenanceStamp?: { status: "stamped" | "failed" | "skipped"; detail?: string }
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
    /** Stamped as an `Agentproto-Session:` trailer on the snapshot commit —
     *  the branch's authoring session, for PR authorship attribution. */
    sessionId?: string
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
  const baseMessage = `agentproto checkpoint: uncommitted work on ${target.branch}${turnSuffix}`
  const message = shellQuote(
    opts?.sessionId
      ? commitMessageWithSessionTrailer(baseMessage, opts.sessionId)
      : baseMessage,
  )
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

/** The empty provenance commit's subject (see {@link buildProvenanceStampCommand}). */
export const PROVENANCE_COMMIT_SUBJECT = "agentproto: delivered work"

/**
 * Stamp the authoring session onto the DELIVERED work branch itself: append
 * an empty commit (same tree as the tip, parent: the tip) whose message
 * carries the `Agentproto-Session:` trailer. The checkpoint ref is deleted
 * once the checkout is clean and the branch is pushed, so it can't be the
 * only carrier of the trailer - a PR opened after a clean teardown reads the
 * trailer off the branch's own commits (`pr-provenance-stamp.ts`).
 *
 * Built with plumbing (`commit-tree` + `update-ref` with the old value
 * guarded) so the agent's index and worktree are never touched, and a no-op
 * when the tip already carries this session's trailer. Run for the teardown
 * delivery only - the agent is already killed, so nothing races the ref.
 */
export function buildProvenanceStampCommand(target: SandboxDeliveryTarget, sessionId: string): string {
  const ref = shellQuote(`refs/heads/${target.branch}`)
  const trailer = shellQuote(`Agentproto-Session: ${sessionId}`)
  const message = shellQuote(commitMessageWithSessionTrailer(PROVENANCE_COMMIT_SUBJECT, sessionId))
  return (
    `cd ${shellQuote(target.checkoutDir)} && ref=${ref} && ` +
    `{ git log -1 --format=%B "$ref" | grep -qxF ${trailer} || ` +
    `{ old=$(git rev-parse "$ref") && new=$(git commit-tree "$ref^{tree}" -p "$old" -m ${message}) && ` +
    `git update-ref "$ref" "$new" "$old"; }; }`
  )
}

/** Attempts per {@link runProvenanceStamp} call. */
const PROVENANCE_STAMP_ATTEMPTS = 2

/**
 * Run {@link buildProvenanceStampCommand}, retrying a failed attempt (a
 * throw, a timeout or a non-zero exit). Never throws: the outcome is the
 * record. The command is idempotent, so a retry after a partial success
 * adds nothing.
 */
async function runProvenanceStamp(
  exec: SandboxExec,
  target: SandboxDeliveryTarget,
  sessionId: string,
  deadlineAt: number,
  reserveMs: number,
): Promise<NonNullable<SandboxDeliveryRecord["provenanceStamp"]>> {
  let detail = "not attempted"
  for (let attempt = 0; attempt < PROVENANCE_STAMP_ATTEMPTS; attempt++) {
    try {
      const result = await withinDeadline(
        deadlineAt,
        PROBE_TIMEOUT_MS,
        (timeoutMs) => exec({ command: buildProvenanceStampCommand(target, sessionId), timeoutMs }),
        reserveMs,
      )
      if (result.exitCode === 0) return { status: "stamped" }
      detail = describeExecFailure(result)
    } catch (err) {
      detail = errorText(err)
    }
  }
  return { status: "failed", detail }
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
  /** Checkpoint-mode only: also archive this session's adapter conversation
   *  store (its isolated adapter-config dir in the box, keyed by the
   *  box-side `adapterSessionId`) and pull it next to the record — see
   *  `sandbox-adapter-store.ts`. An archive failure is recorded on
   *  {@link SandboxDeliveryRecord.adapterStore}, never thrown. */
  adapterStore?: { adapterSessionId: string; adapter?: string }
  /** The authoring session id, stamped as an `Agentproto-Session:` commit
   *  trailer on the snapshot commit this run creates — PR provenance
   *  (pr-provenance.ts `collectBranchAuthors`) reads it back so a branch is
   *  attributed to the session that wrote it even after the registry stops
   *  knowing the box session. Pure provenance — not parsed back for
   *  anything secret; the id is a pointer to the descriptor. */
  sessionId?: string
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

  // Checkpoint-mode passenger: archive the adapter's conversation store
  // alongside the git state. Runs BEFORE the probe so every outcome below
  // (push, bundle, unchanged-skip, even a probe failure) still carries the
  // freshest store; a failure only ever lands on `record.adapterStore`.
  if (checkpointMode && input.adapterStore) {
    record.adapterStore = await archiveAdapterStore({
      exec,
      ...(input.readFile ? { readFile: input.readFile } : {}),
      adapterSessionId: input.adapterStore.adapterSessionId,
      ...(input.adapterStore.adapter ? { adapter: input.adapterStore.adapter } : {}),
      outDir: input.outDir,
      timeoutMs: Math.max(1, Math.min(ADAPTER_STORE_TIMEOUT_MS, deadlineAt - Date.now())),
    })
  }

  let probe: DeliveryProbe | undefined
  try {
    const result = await withinDeadline(deadlineAt, PROBE_TIMEOUT_MS, (timeoutMs) =>
      // GIT_OPTIONAL_LOCKS=0: `git status` must not take the agent's
      // index.lock while it may be committing.
      exec({
        command: buildProbeCommand(target, {
          snapshotUncommitted: input.snapshotUncommitted,
          turn: input.turn,
          sessionId: input.sessionId,
        }),
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
    // Teardown only: carry the authoring-session trailer on the pushed work
    // branch (the checkpoint ref that also carries it is deleted below on a
    // clean run). Best-effort - a failure only loses the attribution hint,
    // never blocks the push. A failed attempt is retried, and the outcome is
    // recorded so a stamp that never landed is visible, not swallowed.
    //
    // NOT when the probe took a snapshot of the uncommitted work: the
    // snapshot commit ALREADY carries the session trailer, and stamping the
    // branch would move the branch tip to a SIBLING of that snapshot, the
    // restore path then rejects the checkpoint (its new HEAD is neither its
    // parent nor an ancestor of its parent) and the uncommitted work is lost
    // on restart. The snapshot is the carrier here.
    const reserveMs = input.readFile ? bundleReserveMs : 0
    const stamp = !checkpointMode && input.sessionId && probe.snapshot === undefined
      ? () => runProvenanceStamp(exec, target, input.sessionId!, deadlineAt, reserveMs)
      : undefined
    if (stamp) record.provenanceStamp = await stamp()
    else if (!checkpointMode && input.sessionId && probe.snapshot !== undefined) {
      record.provenanceStamp = { status: "skipped", detail: "the uncommitted-work snapshot already carries the session trailer" }
    }
    record.push = await pushBranch(exec, target, deadlineAt, reserveMs)
    // The push landed but the stamp did not: retry it once more and, when it
    // lands now, push again so the remote branch carries the trailer too.
    // Without this a failed stamp was never retried: nothing else re-runs
    // the teardown delivery once its push succeeded.
    if (stamp && record.provenanceStamp?.status === "failed" && record.push.status === "pushed") {
      const retry = await stamp()
      if (retry.status === "stamped") {
        const again = await pushBranch(exec, target, deadlineAt, reserveMs)
        record.provenanceStamp = again.status === "pushed"
          ? retry
          : { status: "failed", detail: `stamped but the re-push failed: ${again.detail ?? "unknown"}` }
      } else {
        record.provenanceStamp = retry
      }
    }
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

export interface SandboxCheckpointerRunOpts {
  /** Bypass the unchanged-since-last-checkpoint skip (the disk guard's
   *  escape hatch: a full disk is exactly the moment a "nothing new" answer
   *  must not be trusted). */
  force?: boolean
  /** Per-run wall-clock budget (ms) for this checkpoint, overriding the
   *  checkpointer's configured `timeoutMs`. A checkpoint run as the box's
   *  lifetime deadline approaches MUST be bounded by the time actually
   *  left: a run budgeted past the deadline finishes AFTER the provider
   *  has reaped the box ("sandbox not found" — sess 20/10/2026, E2B), so
   *  the caller caps it to the remaining lifetime minus a safety margin. */
  deadlineMs?: number
}

export interface SandboxCheckpointer {
  /** Take one checkpoint now. Concurrent calls share the in-flight run.
   *  `turn`, when given, is stamped onto the record and the snapshot commit
   *  message (see {@link SandboxDeliveryRecord.turn}) — a coalesced call
   *  (one already in flight) keeps whichever turn number started IT, not
   *  the caller's.
   *  `opts.force` bypasses the unchanged-since-last-checkpoint skip.
   *  `opts.deadlineMs` caps THIS run (`SandboxCheckpointerRunOpts.deadlineMs`). */
  run(turn?: number, opts?: SandboxCheckpointerRunOpts): Promise<SandboxDeliveryRecord>
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
    run(turn, opts) {
      if (inFlight && !opts?.force) return inFlight
      // A forced run still SERIALIZES — it chains on the in-flight run
      // instead of overlapping it (two overlapping runs would race the
      // snapshot ref, and in tar mode the same archive path), it only
      // bypasses the unchanged-since-last-checkpoint skip.
      const prior = inFlight
      const chained = (fn: () => Promise<SandboxDeliveryRecord>): Promise<SandboxDeliveryRecord> =>
        prior ? prior.catch(() => undefined).then(fn) : fn()
      let wrapped: Promise<SandboxDeliveryRecord>
      wrapped = chained(async () => {
        const record = await runSandboxDelivery({
          ...run,
          mode: "checkpoint",
          checkpointPushed,
          ...(opts?.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}),
          ...(opts?.force ? {} : lastKey !== undefined ? { previousKey: lastKey } : {}),
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
      }).finally(() => {
        // Only OUR run may clear the slot — a chained forced run may have
        // already replaced it.
        if (inFlight === wrapped) inFlight = undefined
      })
      inFlight = wrapped
      return wrapped
    },
  }
}

/** Spacing of periodic checkpoints. `AGENTPROTO_SANDBOX_CHECKPOINT_INTERVAL_MS`
 *  overrides it; `0` turns periodic and turn-end checkpoints off. Legacy
 *  knob — {@link SandboxCheckpointConfig.minIntervalMs} is the config-object
 *  equivalent and wins when set; this env var remains the ultimate fallback
 *  (see {@link resolveSandboxCheckpointConfig}) so an existing deployment
 *  that only ever touched it keeps behaving identically. */
export const DEFAULT_CHECKPOINT_INTERVAL_MS = 10 * 60_000
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
  /** Which triggers take a checkpoint. `"turn-end"` wires the per-turn hook
   *  (a snapshot after each turn the proxy completes); absent, turns end
   *  uncheckpointed. `"interval"` wires the PERIODIC timer — every
   *  {@link SandboxCheckpointConfig.intervalMs} of the session's life a
   *  snapshot is taken DURING a turn too, so a turn longer than the box
   *  lifetime is not lost with it (a time-based trigger, as opposed to
   *  `turn-end`'s event-based one). `"turn-end"` ALSO wires the timer (the
   *  pre-`"interval"` behaviour — an explicit `["turn-end", "teardown"]`
   *  keeps mid-turn checkpointing across an upgrade); `"interval"` is for a
   *  timer WITHOUT the per-turn hook. `"teardown"` makes the teardown
   *  delivery SNAPSHOT uncommitted work (not just count it, {@link
   *  buildProbeCommand}'s `snapshotUncommitted`); absent, teardown still
   *  pushes the branch but leaves uncommitted work in the box
   *  uncounted-for-rescue, matching the pre-checkpoint behaviour.
   *  Default all three. */
  on?: Array<"turn-end" | "teardown" | "interval">
  /** Remote branch namespace the snapshot is force-pushed to
   * (`<refPrefix><branch>`). Default {@link CHECKPOINT_BRANCH_PREFIX} —
   * changing this only affects a FUTURE checkpoint; see
   * {@link checkpointBranchOf}. */
  refPrefix?: string
  /** Periodic-checkpoint timer interval (replaces
   *  `AGENTPROTO_SANDBOX_CHECKPOINT_INTERVAL_MS`). Default
   *  {@link DEFAULT_CHECKPOINT_INTERVAL_MS}. */
  minIntervalMs?: number
  /** Preferred spelling of {@link SandboxCheckpointConfig.minIntervalMs} —
   *  the periodic-checkpoint timer interval; wins over it when both are
   *  set (they exist because the periodic dial predates the `on: ["interval"]`
   *  trigger that names it properly). Same default. */
  intervalMs?: number
  /** Per-checkpoint wall-clock budget (`runSandboxDelivery`'s `deadlineMs`).
   *  Default {@link DEFAULT_CHECKPOINT_DEADLINE_MS}. */
  timeoutMs?: number
}

export interface ResolvedSandboxCheckpointConfig {
  enabled: boolean
  /** Resolved `enabled && on.includes("turn-end")` — the proxy wires the
   *  per-turn hook iff this is true. */
  onTurnEnd: boolean
  /** Resolved `enabled && on.includes("teardown")` — whether the teardown
   *  delivery snapshots uncommitted work. */
  onTeardown: boolean
  /** Resolved `enabled && on.includes("interval")` — whether the proxy
   *  runs the periodic-checkpoint timer (every {@link .intervalMs}). */
  onInterval: boolean
  refPrefix: string
  minIntervalMs: number
  /** Effective periodic-checkpoint interval — `intervalMs ?? minIntervalMs`
   *  (config layers) then the legacy env seed. */
  intervalMs: number
  timeoutMs: number
}

const DEFAULT_CHECKPOINT_ON: ReadonlyArray<"turn-end" | "teardown" | "interval"> = [
  "turn-end",
  "teardown",
  "interval",
]

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
  const pick = <T>(key: keyof SandboxCheckpointConfig): T | undefined =>
    perSpawn === false
      ? (global?.[key] as T | undefined)
      : ((perSpawn?.[key] as T | undefined) ?? (global?.[key] as T | undefined))
  const refPrefix = pick<string>("refPrefix")
  const minIntervalMs = pick<number>("minIntervalMs")
  const intervalMs = pick<number>("intervalMs") ?? minIntervalMs ?? resolveCheckpointIntervalMs(env)
  const timeoutMs = pick<number>("timeoutMs") ?? DEFAULT_CHECKPOINT_DEADLINE_MS
  if (perSpawn === false) {
    return {
      enabled: false,
      onTurnEnd: false,
      onTeardown: false,
      onInterval: false,
      refPrefix: refPrefix ?? CHECKPOINT_BRANCH_PREFIX,
      minIntervalMs: minIntervalMs ?? intervalMs,
      intervalMs,
      timeoutMs,
    }
  }
  const enabled = perSpawn?.enabled ?? global?.enabled ?? true
  const on = perSpawn?.on ?? global?.on ?? DEFAULT_CHECKPOINT_ON
  return {
    enabled,
    // `intervalMs <= 0` keeps disabling the timer + per-turn hook on its
    // own — the pre-config-object off-switch (`AGENTPROTO_SANDBOX_
    // CHECKPOINT_INTERVAL_MS=0`), preserved so an existing deployment that
    // only ever set the env var keeps behaving identically.
    onTurnEnd: enabled && on.includes("turn-end") && intervalMs > 0,
    onTeardown: enabled && on.includes("teardown"),
    // `on: ["turn-end"]` KEEPS wiring the timer (the pre-"interval" behaviour
    // — a deployment that explicitly configured `["turn-end", "teardown"]`
    // must not silently lose mid-turn checkpointing on upgrade); `"interval"`
    // is for a timer WITHOUT the per-turn hook.
    onInterval: enabled && intervalMs > 0 && (on.includes("interval") || on.includes("turn-end")),
    refPrefix: refPrefix ?? CHECKPOINT_BRANCH_PREFIX,
    minIntervalMs: minIntervalMs ?? intervalMs,
    intervalMs,
    timeoutMs,
  }
}

/** DISK GUARD — free-space fraction of the box's root disk below which the
 *  proxy's periodic tick forces a checkpoint and emits a warning. A box
 *  running out of disk dies badly (the agent's writes fail mid-turn, and a
 *  crash skips the teardown hook — no checkpoint at all), so the guard runs
 *  BEFORE the disk is full, while the tar/push path can still get the tree
 *  out. */
export const DISK_GUARD_MIN_FREE_FRACTION = 0.1
export const DISK_GUARD_PROBE_TIMEOUT_MS = 10_000

/** `df -Pk`'s POSIX layout (1K blocks) for `dir` — the box's root by default:
 *  it is the disk the agent's checkout, builds and adapter store grow on. */
export function buildDiskFreeCommand(dir = "/"): string {
  return `df -Pk ${shellQuote(dir)}`
}

/** Parse `df -Pk` output: `{ totalBytes, freeBytes }` from the row whose
 *  mount point is `/`. `undefined` for a header-only or unparseable output —
 *  the guard stays silent rather than guessing. */
export function parseDiskFree(stdout: string): { totalBytes: number; freeBytes: number } | undefined {
  for (const line of stdout.split("\n")) {
    // `Filesystem 1024-blocks Used Available Capacity Mounted-on`
    const m = /^\S+\s+(\d+)\s+\d+\s+(\d+)\s+\d+%\s+\/$/.exec(line.trim())
    if (m) return { totalBytes: Number(m[1]) * 1024, freeBytes: Number(m[2]) * 1024 }
  }
  return undefined
}

/** Free fraction of a disk — the number the {@link DISK_GUARD_MIN_FREE_FRACTION}
 *  threshold compares against. Unknown totals (a zero-column row) read as 1
 *  (never low): a broken probe must not force-checkpoint forever. */
export function diskFreeFraction(disk: { totalBytes: number; freeBytes: number }): number {
  if (!Number.isFinite(disk.totalBytes) || disk.totalBytes <= 0) return 1
  return disk.freeBytes / disk.totalBytes
}

/** The proxy's `checkpoint` option for a box with a work branch — empty when
 *  neither the per-turn hook (`config.onTurnEnd`) nor the periodic timer
 *  (`config.onInterval`) is on. Shared by the spawn and restart paths. */
export function sandboxCheckpointOpts(
  input: Omit<Parameters<typeof createSandboxCheckpointer>[0], "deadlineMs" | "refPrefix">,
  config: ResolvedSandboxCheckpointConfig,
): {
  checkpoint?: {
    run: (turn?: number, opts?: SandboxCheckpointerRunOpts) => Promise<SandboxDeliveryRecord>
    intervalMs: number
    /** Whether the proxy runs the periodic timer (`config.onInterval`) —
     *  false leaves the per-turn hook as the only trigger. */
    periodic: boolean
    /** Whether the proxy checkpoints after each turn (`config.onTurnEnd`). */
    onTurnEnd: boolean
  }
} {
  if (!config.onTurnEnd && !config.onInterval) return {}
  const checkpointer = createSandboxCheckpointer({
    ...input,
    deadlineMs: config.timeoutMs,
    refPrefix: config.refPrefix,
  })
  return {
    checkpoint: {
      run: (turn, opts) => checkpointer.run(turn, opts),
      intervalMs: config.intervalMs,
      periodic: config.onInterval,
      onTurnEnd: config.onTurnEnd,
    },
  }
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
  /** Checkpoint-mode conversation-store passenger — see
   *  {@link RunSandboxDeliveryInput.adapterStore}. */
  adapterStore?: { adapterSessionId: string; adapter?: string }
  /** The authoring session id, stamped as an `Agentproto-Session:` trailer
   *  on the checkpoint commits this session's box makes — see
   *  {@link RunSandboxDeliveryInput.sessionId}. */
  sessionId?: string
  onDelivery?: (record: SandboxDeliveryRecord) => void
  onCheckpoint?: (record: SandboxDeliveryRecord) => void
  onTargetChanged?: (target: SandboxDeliveryTarget) => void
}): {
  onBeforeTeardown: () => Promise<void>
  checkpoint?: {
    run: (turn?: number, opts?: SandboxCheckpointerRunOpts) => Promise<unknown>
    intervalMs: number
    periodic: boolean
    onTurnEnd: boolean
    /** Host-side rescue push (`runRescuePush`) into the CURRENT learned
     *  target's checkout, force-pushed to `rescue/<sessionId>` — the disk
     *  guard's wedged-session escape hatch; see
     *  {@link SandboxAgentSessionProxyOpts.checkpoint.rescue}. */
    rescue: (sessionId: string) => Promise<unknown>
  }
} {
  let target = input.target
  const base = {
    exec: input.exec,
    ...(input.readFile ? { readFile: input.readFile } : {}),
    outDir: input.outDir,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  }
  const buildCheckpoint = () =>
    sandboxCheckpointOpts(
      {
        ...base,
        target,
        ...(input.adapterStore ? { adapterStore: input.adapterStore } : {}),
        ...(input.onCheckpoint ? { onCheckpoint: input.onCheckpoint } : {}),
      },
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
      intervalMs: input.config.intervalMs,
      periodic: input.config.onInterval,
      onTurnEnd: input.config.onTurnEnd,
      run: async (turn, opts) => {
        await learn()
        return checkpoint!.run(turn, opts)
      },
      // The rescue runs against the CURRENT target (the branch the agent
      // actually switched to) — executed through `exec` into the box, so it
      // works exactly while the box's filesystem is still reachable, even
      // when the agent session (and thus every in-agent checkpoint probe)
      // is wedged.
      rescue: (sessionId: string) => {
        return runRescuePush({
          exec: input.exec,
          target: { ...target },
          rescueBranch: `${RESCUE_BRANCH_PREFIX}${sessionId}`,
        })
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
  if (record.adapterStore) {
    parts.push(
      `adapter store: ${record.adapterStore.status}${
        record.adapterStore.path ? ` at ${record.adapterStore.path}` : ""
      }${record.adapterStore.detail ? ` (${record.adapterStore.detail})` : ""}`,
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
