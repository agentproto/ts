/**
 * Get a sandbox session's work out of the box before the box is torn down.
 *
 * Runs once, from the sandbox proxy's `close()`, after the box's agent session
 * is killed and before the box is stopped or paused. For a session that has a
 * work branch (`wt/<slug>`, cut by `sandbox-workspace-remote`):
 *
 *   1. probe how many commits the branch is ahead of its recorded base;
 *   2. push the branch to `origin` when it is ahead;
 *   3. when the push did not land (or could not be tried), `git bundle` the
 *      `base..branch` range and pull it to the host as a safety net.
 *
 * Every outcome is reported, never thrown: teardown must not be blocked by a
 * delivery problem, and the record is what tells a human where the work is.
 * No token is handled here — pushes rely on the credential helper set up at
 * clone time.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describeExecFailure, shellQuote, type SandboxExec } from "./sandbox-workspace-remote.js"

export const DELIVERY_BUNDLE_FILE = "delivery.bundle"
export const DELIVERY_RECORD_FILE = "delivery.json"
/** Bundles above this are left in the box and reported, not downloaded. */
export const DEFAULT_BUNDLE_MAX_BYTES = 50 * 1024 * 1024

const BOX_BUNDLE_PATH = "/tmp/agentproto-delivery.bundle"
const PROBE_TIMEOUT_MS = 30_000
const PUSH_TIMEOUT_MS = 90_000
const BUNDLE_TIMEOUT_MS = 60_000
/** Wall-clock cap on the WHOLE delivery: the box keeps billing until teardown
 *  finishes, so every step's timeout is also capped by what is left of this. */
export const DEFAULT_DELIVERY_DEADLINE_MS = 150_000

export interface SandboxDeliveryTarget {
  checkoutDir: string
  /** `wt/<slug>` */
  branch: string
  /** Commit the branch was cut from. */
  baseSha: string
}

export type DeliveryPushStatus = "pushed" | "skipped" | "failed"
export type DeliveryBundleStatus = "saved" | "skipped" | "failed"

export interface SandboxDeliveryRecord {
  at: string
  branch: string
  baseSha: string
  /** Commits on the branch beyond the base; absent when the probe failed. */
  ahead?: number
  /** Uncommitted paths left in the checkout (not delivered). */
  uncommittedFiles?: number
  push: { status: DeliveryPushStatus; detail?: string }
  bundle: { status: DeliveryBundleStatus; path?: string; bytes?: number; detail?: string }
}

export interface DeliveryProbe {
  ahead: number
  uncommitted: number
}

export function buildProbeCommand(target: SandboxDeliveryTarget): string {
  const range = shellQuote(`${target.baseSha}..refs/heads/${target.branch}`)
  return (
    `cd ${shellQuote(target.checkoutDir)} && ` +
    `echo "ahead=$(git rev-list --count ${range})" && ` +
    `echo "uncommitted=$(git status --porcelain | wc -l | tr -d ' ')"`
  )
}

export function parseProbe(stdout: string): DeliveryProbe | undefined {
  const ahead = /^ahead=(\d+)$/m.exec(stdout)
  const uncommitted = /^uncommitted=(\d+)$/m.exec(stdout)
  if (!ahead) return undefined
  return { ahead: Number(ahead[1]), uncommitted: uncommitted ? Number(uncommitted[1]) : 0 }
}

export function buildPushCommand(target: SandboxDeliveryTarget): string {
  return `git -C ${shellQuote(target.checkoutDir)} push -u origin ${shellQuote(target.branch)}`
}

/** Creates the bundle and prints its size in bytes. */
export function buildBundleCommand(target: SandboxDeliveryTarget): string {
  const range = shellQuote(`${target.baseSha}..${target.branch}`)
  return (
    `git -C ${shellQuote(target.checkoutDir)} bundle create --quiet ${BOX_BUNDLE_PATH} ${range} && ` +
    `wc -c < ${BOX_BUNDLE_PATH}`
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
}): BundleDecision {
  if (input.ahead <= 0) return { action: "skip", reason: "no commits ahead of base" }
  if (input.pushStatus === "pushed") return { action: "skip", reason: "branch was pushed" }
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
  now?: () => Date
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Runs `step` with a timeout of at most `capMs`, never past the deadline. The
 *  race also covers a provider that ignores the exec timeout and hangs. */
async function withinDeadline<T>(
  deadlineAt: number,
  capMs: number,
  step: (timeoutMs: number) => Promise<T>,
): Promise<T> {
  const timeoutMs = Math.min(capMs, deadlineAt - Date.now())
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

export async function runSandboxDelivery(input: RunSandboxDeliveryInput): Promise<SandboxDeliveryRecord> {
  const { exec, target } = input
  const maxBytes = input.maxBytes ?? DEFAULT_BUNDLE_MAX_BYTES
  const deadlineAt = Date.now() + (input.deadlineMs ?? DEFAULT_DELIVERY_DEADLINE_MS)
  const record: SandboxDeliveryRecord = {
    at: (input.now?.() ?? new Date()).toISOString(),
    branch: target.branch,
    baseSha: target.baseSha,
    push: { status: "skipped" },
    bundle: { status: "skipped" },
  }

  let probe: DeliveryProbe | undefined
  try {
    const result = await withinDeadline(deadlineAt, PROBE_TIMEOUT_MS, (timeoutMs) =>
      exec({ command: buildProbeCommand(target), timeoutMs }),
    )
    probe = result.exitCode === 0 ? parseProbe(result.stdout) : undefined
    if (!probe) {
      const detail = `probe failed: ${result.exitCode === 0 ? "unparseable output" : describeExecFailure(result)}`
      record.push = { status: "failed", detail }
      record.bundle = { status: "skipped", detail: "probe failed" }
      return await persist(record, input.outDir)
    }
  } catch (err) {
    record.push = { status: "failed", detail: `probe failed: ${errorText(err)}` }
    record.bundle = { status: "skipped", detail: "probe failed" }
    return await persist(record, input.outDir)
  }
  record.ahead = probe.ahead
  record.uncommittedFiles = probe.uncommitted

  if (!shouldPush(probe)) {
    record.push = { status: "skipped", detail: "no commits ahead of base" }
    record.bundle = { status: "skipped", detail: "no commits ahead of base" }
    return await persist(record, input.outDir)
  }

  try {
    const result = await withinDeadline(deadlineAt, PUSH_TIMEOUT_MS, (timeoutMs) =>
      exec({ command: buildPushCommand(target), env: { GIT_TERMINAL_PROMPT: "0" }, timeoutMs }),
    )
    record.push =
      result.exitCode === 0
        ? { status: "pushed" }
        : { status: "failed", detail: describeExecFailure(result) }
  } catch (err) {
    record.push = { status: "failed", detail: errorText(err) }
  }

  const decision = decideBundle({
    ahead: probe.ahead,
    pushStatus: record.push.status,
    canDownload: input.readFile !== undefined,
  })
  if (decision.action === "skip") {
    record.bundle = { status: "skipped", detail: decision.reason }
    return await persist(record, input.outDir)
  }

  try {
    const made = await withinDeadline(deadlineAt, BUNDLE_TIMEOUT_MS, (timeoutMs) =>
      exec({ command: buildBundleCommand(target), timeoutMs }),
    )
    if (made.exitCode !== 0) {
      record.bundle = { status: "failed", detail: `git bundle failed: ${describeExecFailure(made)}` }
      return await persist(record, input.outDir)
    }
    const bytes = Number(made.stdout.trim())
    if (!withinBundleLimit(bytes, maxBytes)) {
      record.bundle = {
        status: "skipped",
        detail: Number.isFinite(bytes)
          ? `bundle is ${bytes} bytes, over the ${maxBytes} byte limit; left at ${BOX_BUNDLE_PATH} in the box`
          : "could not read the bundle size",
      }
      return await persist(record, input.outDir)
    }
    const data = await withinDeadline(deadlineAt, Infinity, () => input.readFile!(BOX_BUNDLE_PATH))
    await mkdir(input.outDir, { recursive: true })
    const path = join(input.outDir, DELIVERY_BUNDLE_FILE)
    await writeFile(path, data)
    record.bundle = { status: "saved", path, bytes: data.byteLength }
  } catch (err) {
    record.bundle = { status: "failed", detail: errorText(err) }
  }
  return await persist(record, input.outDir)
}

async function persist(record: SandboxDeliveryRecord, outDir: string): Promise<SandboxDeliveryRecord> {
  try {
    await mkdir(outDir, { recursive: true })
    await writeFile(join(outDir, DELIVERY_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`)
  } catch {
    // the record is also stamped on the descriptor; a disk failure here is not fatal
  }
  return record
}

/** One-line summary for the session's transcript. */
export function formatDeliveryNotice(record: SandboxDeliveryRecord): string {
  const parts = [
    `[sandbox delivery] ${record.branch}`,
    record.ahead === undefined ? "state unknown" : `${record.ahead} commit(s) ahead of ${record.baseSha.slice(0, 7)}`,
    `push: ${record.push.status}${record.push.detail ? ` (${record.push.detail})` : ""}`,
    `bundle: ${record.bundle.status}${
      record.bundle.path ? ` at ${record.bundle.path}` : record.bundle.detail ? ` (${record.bundle.detail})` : ""
    }`,
  ]
  if (record.uncommittedFiles) parts.push(`${record.uncommittedFiles} uncommitted file(s) NOT delivered`)
  return parts.join(" — ")
}
