/**
 * `session_migrate` — resume a sandbox session from its checkpoint on a NEW box.
 *
 * A sandbox session that works on a workspace-remote branch keeps its work
 * safe off-box (`sandbox-delivery.ts`: the branch pushed, uncommitted files
 * snapshotted to `<refPrefix><branch>`). Migrating moves the session onto a
 * fresh box when the old one is dying, rate-limited or just the wrong shape:
 *
 *   1. {@link assessMigration} (pure) — is this session migratable at all, and
 *      which recorded checkpoint backs it up?
 *   2. final checkpoint — while the old box is reachable, snapshot it once more
 *      so the new box resumes from the latest state (best effort; the recorded
 *      checkpoint is the fallback).
 *   3. spawn — `continueAgentSessionFresh` with the new box's `sandbox`/
 *      `worktree` laid over it: the same adapter/model/profile boots a new box
 *      from the workspace remote, `restoreCheckpointSteps` puts the work back
 *      (commits as commits, uncommitted files left uncommitted) and the context
 *      checkpoint carries the transcript over as the first prompt.
 *   4. retire the old session, killing its box if it is still alive. A failed
 *      spawn leaves the old session untouched.
 *
 * `migrateSandboxSession` is the one entry point for the MCP/HTTP/CLI verbs
 * and for in-daemon callers (turnRetry's "migrate" action).
 */

import { execSandboxCommand } from "./sandbox-exec.js"
import {
  checkpointBranchOf,
  formatDeliveryNotice,
  resolveSandboxCheckpointConfig,
  runSandboxDelivery,
  type ResolvedSandboxCheckpointConfig,
  type SandboxDeliveryRecord,
} from "./sandbox-delivery.js"
import {
  SANDBOX_BRANCH_PREFIX,
  type CheckpointRestoreSnapshot,
  type SandboxExec,
} from "./sandbox-workspace-remote.js"
import type { ContextCheckpoint } from "./context-checkpoint.js"
import type { CheckpointSources } from "./checkpoint-extract.js"
import { loadConfig } from "./config.js"
import { continueAgentSessionFresh } from "./session-continue-fresh.js"
import { parseSandboxProviderSlug } from "./session-restart-core.js"
import type { SpawnAgentSessionDeps } from "./session-spawn.js"
import type { SessionDescriptor } from "./sessions.js"
import { sessionTranscriptDir } from "./transcript-writer.js"
import { findWorkspace, loadWorkspacesConfig, type WorkspaceRemote, type WorkspacesConfig } from "./workspaces-config.js"

export type SessionMigrateErrorCode =
  /** The session did not run in a sandbox box. */
  | "not_sandbox_session"
  /** A `device:` box — its checkout lives on another machine. */
  | "unsupported_sandbox"
  /** The box held no work branch (no workspace remote + worktree at spawn). */
  | "no_work_branch"
  /** The session's workspace is unknown or has no `remote` to clone from. */
  | "no_workspace_remote"
  /** No checkpoint was ever recorded and the old box cannot take a new one. */
  | "no_checkpoint"
  /** The latest checkpoint did not reach the remote (push failed). */
  | "checkpoint_not_delivered"
  /** The session has no context-continuity policy to build the transcript carry-over from. */
  | "no_context_continuity"

/** Thrown for a session that cannot be migrated; `code` maps to an HTTP status. */
export class SessionMigrateError extends Error {
  constructor(
    readonly code: SessionMigrateErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "SessionMigrateError"
  }
}

/** Whether the work the record saw reached the REMOTE (a host-side bundle
 *  alone is not enough: the new box can only clone). */
export function isRemoteDelivered(record: SandboxDeliveryRecord): boolean {
  if (record.unchanged) return true
  if (record.key === undefined) return false
  const commitsSafe = (record.ahead ?? 0) <= 0 || record.push.status === "pushed"
  const snapshotSafe = record.checkpoint === undefined || record.checkpoint.status === "pushed"
  return commitsSafe && snapshotSafe
}

/** Which snapshot the new box may restore for work described by `record`. */
export function restoreSnapshotFor(record: SandboxDeliveryRecord): CheckpointRestoreSnapshot {
  if (record.unchanged) return "any"
  if (record.checkpoint?.status === "pushed" && record.checkpoint.sha) return { sha: record.checkpoint.sha }
  // A clean checkout: a snapshot left on the remote by an earlier checkpoint
  // is stale and must not resurface.
  if (record.checkpoint === undefined && record.uncommittedFiles === 0) return "none"
  return "any"
}

function latestRecord(prev: SessionDescriptor): SandboxDeliveryRecord | undefined {
  const records = [prev.sandboxCheckpoint, prev.sandboxDelivery].filter(
    (r): r is SandboxDeliveryRecord => r !== undefined,
  )
  return records.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0]
}

export interface MigrationPlan {
  branch: string
  workspace: { slug: string; remote: WorkspaceRemote }
  /** Provider the OLD box ran on. */
  providerSlug: string
  /** The old box is expected to be reachable (row running, box id known). */
  live: boolean
  /** Latest recorded checkpoint/delivery of the old session, if any. */
  recorded?: SandboxDeliveryRecord
}

/**
 * Pure pre-flight: can `prev` be migrated, and from what? `workspace` is the
 * registry entry for `prev.workspaceSlug` (undefined when unknown).
 */
export function assessMigration(
  prev: SessionDescriptor,
  workspace: { slug: string; remote?: WorkspaceRemote } | undefined,
): { ok: true; plan: MigrationPlan } | { ok: false; error: SessionMigrateError } {
  const fail = (code: SessionMigrateErrorCode, message: string, details?: Record<string, unknown>) => ({
    ok: false as const,
    error: new SessionMigrateError(code, message, details),
  })
  if (prev.kind !== "agent-cli" || prev.remote !== true) {
    return fail(
      "not_sandbox_session",
      `session ${prev.id} does not run in a sandbox box — only a sandbox session can be migrated to a new box.`,
    )
  }
  const providerSlug = prev.sandboxProvider ?? parseSandboxProviderSlug(prev.command)
  if (providerSlug?.startsWith("device:") || prev.hostSessionId !== undefined) {
    return fail(
      "unsupported_sandbox",
      `session ${prev.id} runs on a device sandbox (${providerSlug ?? "device"}); its checkout lives on another machine and cannot be migrated.`,
    )
  }
  const branch = prev.sandboxDeliveryTarget?.branch
  if (!branch || !branch.startsWith(SANDBOX_BRANCH_PREFIX)) {
    return fail(
      "no_work_branch",
      `session ${prev.id} has no work branch in its box — migration needs a sandbox spawned from a workspace remote with a worktree (agent_start sandbox + workspaceSlug + worktree).`,
    )
  }
  if (!providerSlug) {
    return fail("not_sandbox_session", `session ${prev.id} records no sandbox provider — cannot boot its replacement.`)
  }
  if (!prev.contextContinuity) {
    return fail(
      "no_context_continuity",
      `session ${prev.id} has no context-continuity policy, so its transcript cannot be carried over.`,
    )
  }
  if (!prev.workspaceSlug || !workspace?.remote) {
    return fail(
      "no_workspace_remote",
      `workspace "${prev.workspaceSlug ?? "(none)"}" of session ${prev.id} has no git remote registered — a new box cannot clone the work. ` +
        "Set one with `agentproto workspace remote set`.",
      { workspaceSlug: prev.workspaceSlug },
    )
  }
  const live = (prev.status === "running" || prev.status === "starting") && prev.sandboxId !== undefined
  const recorded = latestRecord(prev)
  if (!live && recorded === undefined) {
    return fail(
      "no_checkpoint",
      `session ${prev.id} has no recorded checkpoint and its box is no longer running, so there is nothing to resume from.`,
    )
  }
  return {
    ok: true,
    plan: {
      branch,
      workspace: { slug: workspace.slug, remote: workspace.remote },
      providerSlug,
      live,
      ...(recorded ? { recorded } : {}),
    },
  }
}

function undeliveredError(prev: SessionDescriptor, record: SandboxDeliveryRecord): SessionMigrateError {
  const bundle = record.bundle.status === "saved" && record.bundle.path ? record.bundle.path : undefined
  return new SessionMigrateError(
    "checkpoint_not_delivered",
    `the latest checkpoint of session ${prev.id} did not reach the workspace remote ` +
      `(push: ${record.push.status}${record.push.detail ? ` — ${record.push.detail}` : ""}), so a new box could not resume it.` +
      (bundle ? ` The work is saved locally as a git bundle: ${bundle}` : ""),
    { record, ...(bundle ? { bundle } : {}) },
  )
}

export interface FinalCheckpointInput {
  prev: SessionDescriptor
  branch: string
  config: ResolvedSandboxCheckpointConfig
}

/** One extra, non-destructive checkpoint of the old (still reachable) box,
 *  run through the provider's exec. Rejects/returns undefined on any failure. */
export type FinalCheckpoint = (input: FinalCheckpointInput) => Promise<SandboxDeliveryRecord | undefined>

export interface SessionMigrateDeps extends SpawnAgentSessionDeps {
  /** Workspace registry reader. Default: `~/.agentproto/workspaces.json`. */
  loadWorkspaces?: () => Promise<WorkspacesConfig>
  /** Final checkpoint of the old box. Default: attach via the provider's exec. */
  finalCheckpoint?: FinalCheckpoint
}

export interface MigrateSandboxSessionOptions {
  /** Provider slug for the NEW box. Default: the old session's. */
  sandbox?: string
  /** Model for the new session. Default: the old session's. */
  model?: string
  /** Auth profile (billing wallet) for the new session. Default: the old session's. */
  access?: { profileRef: string }
  /** Operator notes appended to the carried-over checkpoint. */
  notes?: string
  /** Skip the final checkpoint of the old box and resume from the recorded one. */
  skipFinalCheckpoint?: boolean
  /** Last policy gate / open tasks lookups for the carried-over checkpoint. */
  sources?: CheckpointSources
  /** Checkpoint storage dir (tests). */
  baseDir?: string
}

export interface MigrateSandboxSessionResult {
  ok: true
  /** The new session. */
  descriptor: SessionDescriptor
  migratedFrom: string
  checkpoint: ContextCheckpoint
  restore: {
    /** `live`: taken just now from the old box; `recorded`: the last periodic/teardown one. */
    source: "live" | "recorded"
    snapshot: CheckpointRestoreSnapshot
    branch: string
    record: SandboxDeliveryRecord
  }
  /** True when the old session was still running and has been stopped. */
  oldSessionKilled: boolean
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The default {@link FinalCheckpoint}: runs the delivery through the old box's provider exec. */
export function makeProviderFinalCheckpoint(deps: Pick<SpawnAgentSessionDeps, "resolveSandboxProvider">): FinalCheckpoint {
  return async ({ prev, branch, config }) => {
    const target = prev.sandboxDeliveryTarget
    const provider = prev.sandboxProvider ?? parseSandboxProviderSlug(prev.command)
    if (!target || !provider || !prev.sandboxId) return undefined
    const sandboxId = prev.sandboxId
    const exec: SandboxExec = async opts => {
      const res = await execSandboxCommand(
        {
          provider,
          sandboxId,
          command: opts.command,
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          ...(opts.env ? { env: opts.env } : {}),
          ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        },
        deps.resolveSandboxProvider ? { resolveSandboxProvider: deps.resolveSandboxProvider } : {},
      )
      if (!res.ok) throw new Error(res.message)
      const { exitCode, stdout, stderr, durationMs } = res.result
      return { exitCode, stdout, stderr, durationMs }
    }
    return runSandboxDelivery({
      exec,
      target: { ...target, branch },
      outDir: sessionTranscriptDir(prev.id),
      mode: "checkpoint",
      snapshotUncommitted: true,
      refPrefix: config.refPrefix,
      deadlineMs: config.timeoutMs,
    })
  }
}

function migrationNotes(plan: MigrationPlan, config: ResolvedSandboxCheckpointConfig, extra?: string): string {
  return [
    `Sandbox migrated: the previous box was replaced by a new one. The workspace "${plan.workspace.slug}" is checked out ` +
      `again on branch ${plan.branch}; commits pushed to the remote are back as commits and the last uncommitted snapshot ` +
      `(${checkpointBranchOf(plan.branch, config.refPrefix)}) was restored as uncommitted changes.`,
    "Run `git status` before continuing. Paths in this checkpoint refer to the previous box, and anything that was neither committed nor snapshotted (ignored files, installed dependencies, running processes) is gone.",
    ...(extra ? [extra] : []),
  ].join("\n")
}

/**
 * Move a sandbox session onto a new box. Throws {@link SessionMigrateError}
 * when `prev` cannot be migrated and `ContinueFreshSpawnError` when the new
 * box's spawn is refused — in both cases the old session is left as it was.
 */
export async function migrateSandboxSession(
  deps: SessionMigrateDeps,
  prev: SessionDescriptor,
  opts: MigrateSandboxSessionOptions = {},
): Promise<MigrateSandboxSessionResult> {
  const workspaces = await (deps.loadWorkspaces ?? loadWorkspacesConfig)()
  const workspace = prev.workspaceSlug ? findWorkspace(workspaces, prev.workspaceSlug) : undefined
  const assessed = assessMigration(prev, workspace)
  if (!assessed.ok) throw assessed.error
  const { plan } = assessed

  const configDefaults = deps.loadDefaultsConfig ? await deps.loadDefaultsConfig() : (await loadConfig()).defaults
  const config = resolveSandboxCheckpointConfig(configDefaults?.sandbox?.checkpoint, prev.sandboxCheckpointOverride)

  // Source of the restore: a fresh checkpoint of the old box when it answers,
  // else what was last recorded. Only a state that reached the remote counts.
  let chosen: MigrateSandboxSessionResult["restore"] | undefined
  let undelivered: SandboxDeliveryRecord | undefined
  if (plan.live && !opts.skipFinalCheckpoint) {
    const take = deps.finalCheckpoint ?? makeProviderFinalCheckpoint(deps)
    let record: SandboxDeliveryRecord | undefined
    try {
      record = await take({ prev, branch: plan.branch, config })
    } catch (err) {
      console.warn(`[session_migrate] final checkpoint of ${prev.id} failed: ${errorText(err)}`)
    }
    if (record) {
      try {
        deps.registry.recordSandboxCheckpoint(prev.id, record, formatDeliveryNotice(record))
      } catch {
        // the record is advisory on the old descriptor
      }
      if (isRemoteDelivered(record)) {
        chosen = { source: "live", snapshot: restoreSnapshotFor(record), branch: plan.branch, record }
      } else {
        undelivered = record
      }
    }
  }
  if (!chosen && plan.recorded) {
    if (isRemoteDelivered(plan.recorded)) {
      chosen = {
        source: "recorded",
        snapshot: restoreSnapshotFor(plan.recorded),
        branch: plan.branch,
        record: plan.recorded,
      }
    } else {
      undelivered ??= plan.recorded
    }
  }
  if (!chosen) {
    if (undelivered) throw undeliveredError(prev, undelivered)
    throw new SessionMigrateError(
      "no_checkpoint",
      `session ${prev.id} has no recorded checkpoint and its box could not take a new one, so there is nothing to resume from.`,
    )
  }

  const sandbox = opts.sandbox ?? plan.providerSlug
  const fresh = await continueAgentSessionFresh(deps, prev, {
    // Asking the old session to summarise itself would run another turn in the
    // box after the checkpoint just taken.
    askSource: false,
    stampHandoff: false,
    notes: migrationNotes(plan, config, opts.notes),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.access ? { access: opts.access } : {}),
    ...(opts.baseDir ? { baseDir: opts.baseDir } : {}),
    ...(opts.sources ? { sources: opts.sources } : {}),
    spawn: {
      sandbox,
      workspaceSlug: plan.workspace.slug,
      // A host path is meaningless in the new box; the workspace remote names the checkout.
      cwd: undefined,
      worktree: { slug: plan.branch.slice(SANDBOX_BRANCH_PREFIX.length) },
      sandboxCheckpoint: prev.sandboxCheckpointOverride,
      sandboxCheckpointRestore: chosen.snapshot,
      label: prev.label ? `${prev.label} (migrated)` : undefined,
      title: prev.title ? `${prev.title} (migrated)` : undefined,
      // The policy rides along exactly like `session-restart-core.ts` carries
      // `prev.turnRetry`: without it the replacement box has no `turnRetry`
      // at all, so the next transient failure could neither retry nor migrate
      // (and `turnRetry.action: "migrate"` would be silently lost by its own
      // first migration). `spawnAgentSession` re-resolves it with
      // `resolveTurnRetryPolicy`, which is idempotent on a resolved policy.
      ...(prev.turnRetry ? { turnRetry: prev.turnRetry } : {}),
      ...(prev.modelPolicy ? { modelPolicy: prev.modelPolicy } : {}),
    },
  })

  // The new box is up and owns the branch: stop the old session (its teardown
  // pushes whatever is left and releases the box). A no-op on an ended row.
  let oldSessionKilled = false
  const current = deps.registry.get(prev.id)
  if (current && (current.status === "running" || current.status === "starting")) {
    oldSessionKilled = deps.registry.kill(prev.id, "SIGTERM", "restarted")
  }

  return {
    ok: true,
    descriptor: fresh.descriptor,
    migratedFrom: prev.id,
    checkpoint: fresh.checkpoint,
    restore: chosen,
    oldSessionKilled,
  }
}

/** The wire shape of a finished migration — shared by the MCP and HTTP verbs. */
export function summarizeMigration(result: MigrateSandboxSessionResult): Record<string, unknown> {
  const { restore } = result
  return {
    migratedFrom: result.migratedFrom,
    migratedTo: result.descriptor.id,
    sandboxId: result.descriptor.sandboxId,
    sandboxProvider: result.descriptor.sandboxProvider,
    branch: restore.branch,
    checkpointId: result.checkpoint.checkpointId,
    checkpointPath: result.checkpoint.checkpointPath,
    restore: {
      source: restore.source,
      snapshot: typeof restore.snapshot === "string" ? restore.snapshot : restore.snapshot.sha,
      at: restore.record.at,
      ahead: restore.record.ahead,
      uncommittedFiles: restore.record.uncommittedFiles,
    },
    oldSessionKilled: result.oldSessionKilled,
  }
}
