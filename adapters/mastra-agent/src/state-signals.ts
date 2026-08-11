/**
 * Daemon state signals (WP-7) — a snapshot/delta emitter that keeps the
 * native agent's thread carrying a live picture of "what's happening around
 * me": the daemon session tree it cares about (its own children + explicitly
 * watched sessions) and the workspace git status (branch + dirty file count).
 *
 * Emission uses the FIRST-CLASS state-signal API — `agent.sendStateSignal`
 * exists in installed @mastra/core 1.57.0 (`dist/agent/agent.d.ts`,
 * experimental) with the full snapshot/delta + `cacheKey` machinery
 * (`dist/agent/state-signals.d.ts`): Mastra tracks the current cacheKey per
 * thread and skips an unchanged re-send (`{skipped: true, reason:
 * 'unchanged'}`). This emitter ALSO dedups locally (per-target last cacheKey)
 * so an unchanged state costs no `sendStateSignal` call at all — the
 * framework-side dedup is the safety net, not the hot path.
 *
 * Mode selection per the plan: the first emission for a target is a full
 * `snapshot`; later changed emissions are `delta`s describing what moved
 * (session added/removed/status change, git branch/dirty change). Local
 * per-target memory is in-process only — an adapter restart re-emits a full
 * snapshot, which is exactly the right recovery behavior.
 *
 * Targets always get `ifIdle: { behavior: "persist" }` — same rationale as
 * the notification watch path (signal-provider.ts): this adapter fronts an
 * ACP client with no surface for an unprompted background run, so state lands
 * in the thread history for the next real turn instead of waking one.
 *
 * Git status runs `git status --porcelain=v1 --branch` via `execFile` with
 * `GIT_CEILING_DIRECTORIES` set to the workspace's PARENT: the workspace dir
 * is expected to BE the repo root (or contain the repo), and the ceiling
 * stops git from wandering up into some unrelated enclosing repo when the
 * workspace isn't a repo at all. A workspace that is a deep subdir of a repo
 * therefore reports no git state — acceptable for this adapter, whose
 * workspace cwd is the checkout root.
 */

import { execFile } from "node:child_process"
import { dirname, resolve } from "node:path"
import { promisify } from "node:util"
import type { AgentStateSignalInput } from "@mastra/core/agent"
import type { DaemonClient } from "./daemon-client.js"

const execFileAsync = promisify(execFile)

/** One daemon session row, reduced to the fields the state picture needs. */
export interface DaemonStateSession {
  id: string
  label?: string
  adapter?: string
  status?: string
  parentSessionId?: string
}

export interface DaemonGitState {
  branch?: string
  dirtyFiles: number
}

export interface DaemonStateSnapshot {
  /** Own children (`parentSessionId === AGENTPROTO_SESSION_ID`) + watched ids, sorted by id. */
  sessions: DaemonStateSession[]
  /** Undefined when the workspace isn't a git repo (or git isn't runnable). */
  git?: DaemonGitState
}

/** The single agent method this emitter calls, typed structurally so tests
 *  (and the provider) don't need a full `Agent`. Matches
 *  `Agent.sendStateSignal(state, target)` in @mastra/core 1.57.0. */
export interface StateSignalAgentLike {
  sendStateSignal(
    state: AgentStateSignalInput,
    target: {
      threadId: string
      resourceId: string
      ifIdle?: { behavior?: "wake" | "persist" | "discard" }
    },
  ): Promise<unknown>
}

export interface DaemonStateEmitterOptions {
  client: DaemonClient
  /** Workspace dir the git status reads. Defaults to `process.cwd()`. */
  cwd?: string
  /** Env carrying `AGENTPROTO_SESSION_ID` (own-children filter). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Injectable `git <args>` runner returning stdout — test hook. */
  runGit?: (args: string[], cwd: string) => Promise<string>
}

/** Stable id every emission shares — Mastra keys per-thread state tracking
 *  (version, cacheKey, active copies) on it. */
export const DAEMON_STATE_SIGNAL_ID = "agentproto-daemon-state"

export type EmitResult = "snapshot" | "delta" | "unchanged"

export class DaemonStateEmitter {
  readonly #client: DaemonClient
  readonly #cwd: string
  readonly #env: NodeJS.ProcessEnv
  readonly #runGit: (args: string[], cwd: string) => Promise<string>
  readonly #lastByTarget = new Map<string, { cacheKey: string; snapshot: DaemonStateSnapshot }>()

  constructor(opts: DaemonStateEmitterOptions) {
    this.#client = opts.client
    this.#cwd = opts.cwd ?? process.cwd()
    this.#env = opts.env ?? process.env
    this.#runGit = opts.runGit ?? defaultRunGit
  }

  /**
   * Compute the current daemon-state snapshot: sessions that are either this
   * adapter's own daemon children or in `watchedSessionIds`, plus git status.
   * Either half failing degrades (empty sessions / no git) rather than throws
   * only for git; a daemon listSessions failure DOES throw — the caller (the
   * signal provider's poll loop) already isolates and warn-onces it.
   */
  async computeSnapshot(watchedSessionIds: readonly string[]): Promise<DaemonStateSnapshot> {
    const ownSessionId = this.#env.AGENTPROTO_SESSION_ID
    const watched = new Set(watchedSessionIds)
    const { sessions: rows } = await this.#client.listSessions({ includeArchived: true })
    const sessions = rows
      .filter((row): row is Record<string, unknown> & { id: string } => typeof row.id === "string")
      .filter(
        (row) =>
          watched.has(row.id) ||
          (ownSessionId !== undefined && row.parentSessionId === ownSessionId),
      )
      .map(
        (row): DaemonStateSession => ({
          id: row.id,
          ...(typeof row.label === "string" ? { label: row.label } : {}),
          ...(typeof row.adapter === "string" ? { adapter: row.adapter } : {}),
          ...(typeof row.status === "string" ? { status: row.status } : {}),
          ...(typeof row.parentSessionId === "string"
            ? { parentSessionId: row.parentSessionId }
            : {}),
        }),
      )
      .sort((a, b) => a.id.localeCompare(b.id))

    const git = await this.#gitState()
    return { sessions, ...(git ? { git } : {}) }
  }

  /**
   * Compute + send the state signal to one target thread. Returns what was
   * sent: a full `snapshot` (first emission for this target), a `delta`
   * (changed since last), or `unchanged` (nothing sent).
   */
  async emit(
    agent: StateSignalAgentLike,
    target: { threadId: string; resourceId: string },
    watchedSessionIds: readonly string[],
  ): Promise<EmitResult> {
    const snapshot = await this.computeSnapshot(watchedSessionIds)
    const cacheKey = snapshotCacheKey(snapshot)
    const targetKey = `${target.resourceId}:${target.threadId}`
    const prev = this.#lastByTarget.get(targetKey)
    if (prev?.cacheKey === cacheKey) return "unchanged"

    const mode: EmitResult = prev ? "delta" : "snapshot"
    const contents =
      mode === "snapshot" ? renderSnapshot(snapshot) : renderDelta(prev!.snapshot, snapshot)
    await agent.sendStateSignal(
      {
        id: DAEMON_STATE_SIGNAL_ID,
        cacheKey,
        mode,
        contents,
        value: snapshot,
        ...(mode === "delta" ? { delta: diffSnapshots(prev!.snapshot, snapshot) } : {}),
      },
      { ...target, ifIdle: { behavior: "persist" } },
    )
    this.#lastByTarget.set(targetKey, { cacheKey, snapshot })
    return mode
  }

  async #gitState(): Promise<DaemonGitState | undefined> {
    try {
      const out = await this.#runGit(["status", "--porcelain=v1", "--branch"], this.#cwd)
      const lines = out.split("\n").filter((line) => line.length > 0)
      const header = lines[0]?.startsWith("## ") ? lines[0].slice(3) : undefined
      // "## main...origin/main [ahead 1]" → "main"; "## HEAD (no branch)" kept whole.
      const branch = header?.split("...")[0]
      const dirtyFiles = lines.filter((line) => !line.startsWith("## ")).length
      return { ...(branch ? { branch } : {}), dirtyFiles }
    } catch {
      return undefined
    }
  }
}

async function defaultRunGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      // Stop repo discovery from walking above the workspace (see module doc).
      GIT_CEILING_DIRECTORIES: dirname(resolve(cwd)),
    },
    timeout: 10_000,
  })
  return stdout
}

/** Deterministic content key: identical state → identical key, any change →
 *  a different key. The snapshot is built from sorted sessions and plain
 *  fields, so JSON order is stable. */
function snapshotCacheKey(snapshot: DaemonStateSnapshot): string {
  return JSON.stringify(snapshot)
}

function describeSession(s: DaemonStateSession): string {
  const label = s.label ? ` (${s.label})` : ""
  const adapter = s.adapter ? ` [${s.adapter}]` : ""
  return `${s.id}${label}${adapter}: ${s.status ?? "unknown"}`
}

function renderSnapshot(snapshot: DaemonStateSnapshot): string {
  const lines = ["Daemon state snapshot:"]
  if (snapshot.sessions.length === 0) {
    lines.push("- sessions: none (no children or watched sessions)")
  } else {
    lines.push("- sessions:")
    for (const s of snapshot.sessions) lines.push(`  - ${describeSession(s)}`)
  }
  if (snapshot.git) {
    lines.push(
      `- workspace git: ${snapshot.git.branch ?? "?"}, ${snapshot.git.dirtyFiles} dirty file(s)`,
    )
  }
  return lines.join("\n")
}

export interface DaemonStateDelta {
  addedSessions: DaemonStateSession[]
  removedSessions: DaemonStateSession[]
  statusChanges: Array<{ id: string; from?: string; to?: string }>
  git?: { from?: DaemonGitState; to?: DaemonGitState }
}

function diffSnapshots(prev: DaemonStateSnapshot, next: DaemonStateSnapshot): DaemonStateDelta {
  const prevById = new Map(prev.sessions.map((s) => [s.id, s]))
  const nextById = new Map(next.sessions.map((s) => [s.id, s]))
  const addedSessions = next.sessions.filter((s) => !prevById.has(s.id))
  const removedSessions = prev.sessions.filter((s) => !nextById.has(s.id))
  const statusChanges = next.sessions
    .filter((s) => prevById.has(s.id) && prevById.get(s.id)!.status !== s.status)
    .map((s) => {
      const from = prevById.get(s.id)!.status
      return { id: s.id, ...(from !== undefined ? { from } : {}), ...(s.status !== undefined ? { to: s.status } : {}) }
    })
  const gitChanged = JSON.stringify(prev.git) !== JSON.stringify(next.git)
  return {
    addedSessions,
    removedSessions,
    statusChanges,
    ...(gitChanged
      ? {
          git: {
            ...(prev.git ? { from: prev.git } : {}),
            ...(next.git ? { to: next.git } : {}),
          },
        }
      : {}),
  }
}

function renderDelta(prev: DaemonStateSnapshot, next: DaemonStateSnapshot): string {
  const delta = diffSnapshots(prev, next)
  const lines = ["Daemon state changed:"]
  for (const s of delta.addedSessions) lines.push(`- new session ${describeSession(s)}`)
  for (const s of delta.removedSessions) lines.push(`- session ${s.id} no longer listed`)
  for (const c of delta.statusChanges) {
    lines.push(`- session ${c.id}: ${c.from ?? "unknown"} → ${c.to ?? "unknown"}`)
  }
  if (delta.git) {
    const to = delta.git.to
    lines.push(
      to
        ? `- workspace git: ${to.branch ?? "?"}, ${to.dirtyFiles} dirty file(s)`
        : "- workspace git state no longer readable",
    )
  }
  return lines.join("\n")
}
