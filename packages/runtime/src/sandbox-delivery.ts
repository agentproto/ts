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
 *      `base..tip` range and pull it to the host as a safety net.
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

/** The remote branch carrying `branch`'s uncommitted-work snapshot. */
export function checkpointBranchOf(branch: string): string {
  return `${CHECKPOINT_BRANCH_PREFIX}${branch}`
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
  /** Identity of the delivered state (HEAD, snapshot tree, ahead count): a
   *  checkpoint whose key matches the previous fully-delivered one skips the
   *  pushes. Absent when the probe failed. */
  key?: string
  /** True when a checkpoint found nothing new since the last delivered one. */
  unchanged?: boolean
  bundle: { status: DeliveryBundleStatus; path?: string; bytes?: number; detail?: string }
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
export function buildProbeCommand(target: SandboxDeliveryTarget): string {
  const range = shellQuote(`${target.baseSha}..refs/heads/${target.branch}`)
  const message = shellQuote(`agentproto checkpoint: uncommitted work on ${target.branch}`)
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

export function buildPushCommand(target: SandboxDeliveryTarget): string {
  return `git -C ${shellQuote(target.checkoutDir)} push -u origin ${shellQuote(target.branch)}`
}

/** Force-push the snapshot: each checkpoint replaces the previous one. */
export function buildCheckpointPushCommand(target: SandboxDeliveryTarget): string {
  const refspec = shellQuote(`+${SNAPSHOT_REF}:refs/heads/${checkpointBranchOf(target.branch)}`)
  return `git -C ${shellQuote(target.checkoutDir)} push origin ${refspec}`
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
    push: { status: "skipped" },
    bundle: { status: "skipped" },
  }

  let probe: DeliveryProbe | undefined
  try {
    const result = await withinDeadline(deadlineAt, PROBE_TIMEOUT_MS, (timeoutMs) =>
      // GIT_OPTIONAL_LOCKS=0: `git status` must not take the agent's
      // index.lock while it may be committing.
      exec({ command: buildProbeCommand(target), env: { GIT_OPTIONAL_LOCKS: "0" }, timeoutMs }),
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
    return await persist(record)
  }

  if (!shouldPush(probe)) {
    record.push = { status: "skipped", detail: "no commits ahead of base" }
  } else {
    record.push = await pushBranch(exec, target, deadlineAt, input.readFile ? bundleReserveMs : 0)
  }

  if (probe.snapshot !== undefined) {
    const ref = checkpointBranchOf(target.branch)
    try {
      const result = await withinDeadline(deadlineAt, PUSH_TIMEOUT_MS, (timeoutMs) =>
        exec({ command: buildCheckpointPushCommand(target), env: { GIT_TERMINAL_PROMPT: "0" }, timeoutMs }),
        input.readFile ? bundleReserveMs : 0,
      )
      record.checkpoint =
        result.exitCode === 0
          ? { status: "pushed", ref, sha: probe.snapshot }
          : { status: "failed", ref, sha: probe.snapshot, detail: describeExecFailure(result) }
    } catch (err) {
      record.checkpoint = { status: "failed", ref, sha: probe.snapshot, detail: errorText(err) }
    }
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
  /** Take one checkpoint now. Concurrent calls share the in-flight run. */
  run(): Promise<SandboxDeliveryRecord>
}

/**
 * Periodic checkpoints for one box: remembers the last fully-delivered key so
 * an idle session costs one probe per tick, and serializes runs so a turn-end
 * checkpoint never races the timer's.
 */
export function createSandboxCheckpointer(
  input: Omit<RunSandboxDeliveryInput, "mode" | "previousKey"> & {
    onCheckpoint?: (record: SandboxDeliveryRecord) => void
  },
): SandboxCheckpointer {
  const { onCheckpoint, ...run } = input
  let lastKey: string | undefined
  let inFlight: Promise<SandboxDeliveryRecord> | undefined
  return {
    run() {
      if (inFlight) return inFlight
      inFlight = (async () => {
        const record = await runSandboxDelivery({
          ...run,
          mode: "checkpoint",
          ...(lastKey !== undefined ? { previousKey: lastKey } : {}),
        })
        if (isFullyDelivered(record)) lastKey = record.key
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
 *  overrides it; `0` turns periodic and turn-end checkpoints off. */
export const DEFAULT_CHECKPOINT_INTERVAL_MS = 5 * 60_000
export const CHECKPOINT_INTERVAL_ENV = "AGENTPROTO_SANDBOX_CHECKPOINT_INTERVAL_MS"

export function resolveCheckpointIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[CHECKPOINT_INTERVAL_ENV]?.trim()
  if (!raw) return DEFAULT_CHECKPOINT_INTERVAL_MS
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_CHECKPOINT_INTERVAL_MS
}

/** The proxy's `checkpoint` option for a box with a work branch — empty when
 *  checkpoints are turned off. Shared by the spawn and restart paths. */
export function sandboxCheckpointOpts(
  input: Parameters<typeof createSandboxCheckpointer>[0],
  env: NodeJS.ProcessEnv = process.env,
): { checkpoint?: { run: () => Promise<SandboxDeliveryRecord>; intervalMs: number } } {
  const intervalMs = resolveCheckpointIntervalMs(env)
  if (intervalMs <= 0) return {}
  const checkpointer = createSandboxCheckpointer(input)
  return { checkpoint: { run: () => checkpointer.run(), intervalMs } }
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
  const uncommittedDelivered =
    record.checkpoint !== undefined && (record.checkpoint.status === "pushed" || record.bundle.status === "saved")
  if (record.uncommittedFiles && !uncommittedDelivered) {
    parts.push(`${record.uncommittedFiles} uncommitted file(s) NOT delivered`)
  }
  return parts.join(" — ")
}
