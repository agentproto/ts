/**
 * `agentproto host guard` — the deterministic periodic host watchdog.
 *
 * `host health` answers "is this host OK to spawn more agents?". `host guard`
 * acts on that answer, but only in one direction: it REAPS sessions that are
 * already idle (last turn finished, not keepAlive, not busy, not waiting on
 * anything) and leaves every live/working session alone. A reap is not a
 * kill: the row stays lazy-resumable in place, and it is tagged
 * `guard-reaped` rather than `operator-stopped`. It never edits keepAlive,
 * never interrupts a turn, and never spawns anything until AFTER its cleanup
 * pass — a spawn on a full host is exactly the failure this exists to avoid.
 *
 * Policy, in one table:
 *
 *   verdict  reaps                                    escalates
 *   OK       nothing                                  no
 *   WARN     oldest idle sessions, just enough to     no
 *            fall back under the sessions WARN limit,
 *            else at most `warnMaxClose` (default 3)
 *   CRIT     same, more aggressively (`critMaxClose`,  yes, after cleanup,
 *            default 10, and enough to fall under       only if still CRIT
 *            the WARN sessions limit), never below the
 *            900 s CRIT idle floor
 *
 * A session is eligible only when ALL of these hold:
 *   - alive (`running` / `starting` — `starting` is excluded, no turn yet),
 *   - status `running` and `busy !== true` (last turn finished),
 *   - not `keepAlive`, not `pinned`,
 *   - not awaiting input/permission,
 *   - no background tasks, no queued prompts, no busy children, no live
 *     child session at all (`child-alive`),
 *   - nobody is watching it (`watchers === 0`),
 *   - no work in flight (`work-in-flight`): a dirty or unpushed worktree, a
 *     git check that could not answer, or an active `fix-pr*|exec-*|diag-*|
 *     fix-*` label younger than 2 h,
 *   - idle for at least `warnMinIdleSec` (WARN, default 300s) /
 *     `critMinIdleSec` (CRIT, default and floor 900s),
 *   - not an ancestor of a live session, not this guard's own session (or
 *     one of its ancestors), and not labelled `host-guard-escalation`.
 *
 * Everything above is a pure function of (health, sessions, now, the
 * pre-fetched worktree states), so the decision is reproducible and
 * unit-tested. The I/O runner at the bottom gathers the inputs, appends one
 * JSON line per run to the log, REAPS the selected sessions through
 * `POST /sessions/:id/reap` (never `/kill`, so the reason is `guard-reaped`,
 * not `operator-stopped`), writes the CRIT marker that
 * `agentproto workflow start|run-file` consults, and escalates once.
 *
 * Just before each reap the session is re-fetched and re-validated
 * (`recheckGuardCandidate`), because a turn may have started since the
 * snapshot. Git worktree inspection is bounded to 2 s per command; any
 * failure keeps the session (never reap what we cannot prove clean).
 *
 * Exit status: 0 whenever the guard ran successfully (regardless of the
 * host verdict — read the verdict from the log/`--json`), 2 when the daemon
 * or health sample is unavailable, 64 on bad usage.
 */
import { execFile } from "node:child_process"
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { parseArgs, promisify } from "node:util"
import type { SessionDescriptor } from "@agentproto/runtime"
import { discoverDaemon, httpGetJson, httpPostJson, printNoDaemonError } from "./_daemon-helpers.js"
import { gatherHealthInput } from "./host.js"
import {
  DEFAULT_HEALTH_THRESHOLDS,
  computeHostHealth,
  type HealthCheck,
  type HealthVerdict,
  type HostHealthThresholds,
} from "./host-health.js"

export const GUARD_ESCALATION_LABEL = "host-guard-escalation"
export const DEFAULT_GUARD_LOG_PATH = join(homedir(), ".agentproto", "host-guard.log")
export const DEFAULT_GUARD_STATE_PATH = join(homedir(), ".agentproto", "host-guard", "state.json")

/** How long a CRIT marker blocks workflow starts. The guard runs
 *  every 20 min, so 25 min keeps a fresh CRIT verdict live across one missed
 *  tick without leaving the block armed after the guard stops running. */
export const GUARD_STATE_TTL_MS = 25 * 60_000

/** Absolute floor for the CRIT idle window (15 min). Even when
 *  `--crit-min-idle` asks for less, a CRIT sweep never reaps a session whose
 *  last turn is younger than this: a busy host is not a reason to interrupt
 *  work that is merely between turns. */
export const CRIT_MIN_IDLE_FLOOR_SEC = 900

/** Labels whose sessions are treated as active work-in-flight while younger
 *  than {@link ACTIVE_FIX_PROTECTION_MS}, even if the worktree looks clean. */
export const ACTIVE_FIX_LABEL_RE = /^(?:fix-pr|exec-|diag-|fix-)/

/** How long an active `fix-pr*|exec-*|diag-*|fix-*` session is protected from
 *  the guard after its last observed activity (2 h). */
export const ACTIVE_FIX_PROTECTION_MS = 2 * 60 * 60_000

/** Per-command budget for the worktree `git` probes. A slow/broken git keeps
 *  the session (we never reap what we cannot prove clean). */
export const WORKTREE_GIT_TIMEOUT_MS = 2000

export interface GuardPolicy {
  /** Max idle sessions to close on WARN when the sessions check is not the
   *  reason for the verdict. */
  warnMaxClose: number
  /** Max idle sessions to close on CRIT (unless more are needed to fall back
   *  under the WARN sessions limit). */
  critMaxClose: number
  /** Minimum idle time before a session is closable on WARN. */
  warnMinIdleSec: number
  /** Minimum idle time before a session is closable on CRIT. Never lower than
   *  {@link CRIT_MIN_IDLE_FLOOR_SEC}, even via an override. */
  critMinIdleSec: number
}

export const DEFAULT_GUARD_POLICY: GuardPolicy = {
  warnMaxClose: 3,
  critMaxClose: 10,
  warnMinIdleSec: 300,
  critMinIdleSec: CRIT_MIN_IDLE_FLOOR_SEC,
}

/** The git state of a session's worktree, pre-fetched by the runner so the
 *  decision stays pure. `unknown` means git could not answer (timeout, no
 *  upstream, not a repo) — treated as work-in-flight, i.e. keep the session. */
export interface WorktreeState {
  dirty: boolean
  unpushed: boolean
  unknown?: boolean
}

/** True when the row's label marks work that is still active within the
 *  2-hour protection window. Pure. */
export function isActiveFixLabel(label: string, idleMs: number): boolean {
  return ACTIVE_FIX_LABEL_RE.test(label) && idleMs < ACTIVE_FIX_PROTECTION_MS
}

/** The subset of `SessionDescriptor` the decision reads. Structural so tests
 *  can build rows without a registry. */
export interface GuardSession {
  id: string
  name?: string
  label?: string
  title?: string
  kind?: string
  status?: string
  alive?: boolean
  busy?: boolean
  keepAlive?: boolean
  pinned?: boolean
  awaitingInput?: boolean
  awaitingPermission?: boolean
  pendingBgTasks?: number
  backgroundTasks?: readonly unknown[]
  queuedPrompts?: number
  childrenBusy?: number
  watchers?: number
  startedAt?: string
  lastActivityAt?: string
  parentSessionId?: string
  /** Root of the session's linked worktree, when it has one. */
  worktreePath?: string
  /** Pre-fetched by the runner; ignored by pure callers that don't supply it. */
  worktreeState?: WorktreeState
}

export type GuardSkipReason =
  | "not-alive"
  | "starting"
  | "not-agent"
  | "busy"
  | "awaiting-input"
  | "awaiting-permission"
  | "background-tasks"
  | "queued-prompts"
  | "children-busy"
  | "child-alive"
  | "watched"
  | "work-in-flight"
  | "keep-alive"
  | "pinned"
  | "ancestor-of-live"
  | "self-or-ancestor"
  | "too-recent"

export interface GuardCandidate {
  id: string
  label: string
  startedAt: string | null
  lastActivityAt: string | null
  idleSec: number
}

export interface GuardCounts {
  total: number
  alive: number
  busy: number
  keepAlive: number
  pinned: number
  protectedAncestors: number
  eligible: number
}

export interface GuardSelection {
  verdict: HealthVerdict
  /** `close` when at least one session was selected. */
  action: "none" | "close"
  /** Why nothing was closed (empty when action is `close`). */
  idleReason: string | null
  /** Every eligible session, oldest inactivity first. */
  candidates: GuardCandidate[]
  /** The prefix of `candidates` this pass will close. */
  close: GuardCandidate[]
  /** Live sessions to leave after this pass (projection). */
  projectedAlive: number
  /** Minimum live count the session threshold asks for, when it tripped. */
  targetAlive: number | null
  /** How many closable sessions the policy allowed this pass. */
  budget: number
  counts: GuardCounts
  skipped: Partial<Record<GuardSkipReason, number>>
  policy: GuardPolicy
}

export interface GuardSelectionInput {
  health: {
    verdict: HealthVerdict
    checks: readonly Pick<HealthCheck, "id" | "status" | "value">[]
    thresholds: Pick<HostHealthThresholds, "warnSessions">
  }
  sessions: readonly GuardSession[]
  nowMs: number
  policy?: Partial<GuardPolicy>
  /** Session ids that must never be closed (the guard's own session, a brain
   *  the operator pinned explicitly, ...). Their ancestors are protected too. */
  protectedSessionIds?: readonly string[]
}

const ALIVE_STATUSES = new Set(["running", "starting"])

/** Upper bound for `idleSec` (one year) so unknown idle time stays finite. */
const MAX_IDLE_SEC = 365 * 24 * 3600

export function isAliveSession(s: GuardSession): boolean {
  return s.alive ?? (s.status !== undefined && ALIVE_STATUSES.has(s.status))
}

/** Parse an ISO timestamp to epoch ms; undefined when absent/invalid. */
function parseMs(value: string | undefined): number | undefined {
  if (!value) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

/** How long a session has been idle. Missing activity falls back to start time,
 *  then to "unknown" (treated as maximally old — it has no turn in flight). */
export function idleMsOf(s: GuardSession, nowMs: number): number {
  const at = parseMs(s.lastActivityAt) ?? parseMs(s.startedAt)
  if (at === undefined) return Number.POSITIVE_INFINITY
  return Math.max(0, nowMs - at)
}

export function sessionLabel(s: GuardSession): string {
  return s.label || s.title || s.name || s.id
}

function resolvePolicy(over: Partial<GuardPolicy> | undefined): GuardPolicy {
  const merged = { ...DEFAULT_GUARD_POLICY, ...(over ?? {}) }
  // The CRIT floor is absolute: a flag may raise it, never lower it.
  return { ...merged, critMinIdleSec: Math.max(CRIT_MIN_IDLE_FLOOR_SEC, merged.critMinIdleSec) }
}

/** Ancestors (not the ids themselves) of every alive session plus every
 *  explicitly protected session. Closing one of these would orphan a live
 *  child, so they are never eligible. */
function protectedAncestors(
  sessions: readonly GuardSession[],
  explicit: ReadonlySet<string>,
): Set<string> {
  const byId = new Map(sessions.map(s => [s.id, s]))
  const out = new Set<string>()
  const seeds = new Set(explicit)
  for (const s of sessions) if (isAliveSession(s)) seeds.add(s.id)
  for (const id of seeds) {
    let parent = byId.get(id)?.parentSessionId
    const seen = new Set<string>()
    while (parent && !seen.has(parent)) {
      seen.add(parent)
      out.add(parent)
      parent = byId.get(parent)?.parentSessionId
    }
  }
  return out
}

/** First reason a session must not be closed, or null when it is eligible. */
function ineligibility(
  s: GuardSession,
  opts: {
    nowMs: number
    minIdleMs: number
    ancestors: ReadonlySet<string>
    protectedIds: ReadonlySet<string>
    hasLiveChild: ReadonlySet<string>
  },
): GuardSkipReason | null {
  if (!isAliveSession(s)) return "not-alive"
  if (s.status === "starting") return "starting"
  if (s.kind !== undefined && s.kind !== "agent-cli") return "not-agent"
  if (s.busy === true) return "busy"
  if (s.awaitingInput === true) return "awaiting-input"
  if (s.awaitingPermission === true) return "awaiting-permission"
  if ((s.pendingBgTasks ?? 0) > 0 || (s.backgroundTasks?.length ?? 0) > 0) return "background-tasks"
  if ((s.queuedPrompts ?? 0) > 0) return "queued-prompts"
  if ((s.childrenBusy ?? 0) > 0) return "children-busy"
  if (opts.hasLiveChild.has(s.id)) return "child-alive"
  if ((s.watchers ?? 0) > 0) return "watched"
  if (s.worktreeState?.dirty || s.worktreeState?.unpushed || s.worktreeState?.unknown) return "work-in-flight"
  if (isActiveFixLabel(sessionLabel(s), idleMsOf(s, opts.nowMs))) return "work-in-flight"
  if (s.keepAlive === true || s.pinned === true) return s.keepAlive === true ? "keep-alive" : "pinned"
  if (opts.protectedIds.has(s.id)) return "self-or-ancestor"
  if (opts.ancestors.has(s.id)) return "ancestor-of-live"
  if (sessionLabel(s).startsWith("host-guard-")) return "self-or-ancestor"
  if (idleMsOf(s, opts.nowMs) < opts.minIdleMs) return "too-recent"
  return null
}

/**
 * The whole decision. Pure: same inputs, same output. `close` is always a
 * prefix of `candidates` (oldest inactivity first), capped by the policy and
 * the live-session target.
 */
export function selectGuardSessions(input: GuardSelectionInput): GuardSelection {
  const policy = resolvePolicy(input.policy)
  const { health, sessions, nowMs } = input
  const verdict = health.verdict
  const explicit = new Set(input.protectedSessionIds ?? [])
  const ancestors = protectedAncestors(sessions, explicit)
  const protectedIds = new Set(explicit)
  const hasLiveChild = new Set<string>()
  for (const s of sessions) {
    if (isAliveSession(s) && s.parentSessionId) hasLiveChild.add(s.parentSessionId)
  }
  const minIdleSec = verdict === "CRIT" ? policy.critMinIdleSec : policy.warnMinIdleSec

  const counts: GuardCounts = {
    total: sessions.length,
    alive: 0,
    busy: 0,
    keepAlive: 0,
    pinned: 0,
    protectedAncestors: ancestors.size,
    eligible: 0,
  }
  const skipped: Partial<Record<GuardSkipReason, number>> = {}
  const candidates: GuardCandidate[] = []

  for (const s of sessions) {
    const alive = isAliveSession(s)
    if (alive) {
      counts.alive++
      if (s.busy === true) counts.busy++
      if (s.keepAlive === true) counts.keepAlive++
      if (s.pinned === true) counts.pinned++
    }
    const reason = ineligibility(s, {
      nowMs,
      minIdleMs: minIdleSec * 1000,
      ancestors,
      protectedIds,
      hasLiveChild,
    })
    if (reason) {
      skipped[reason] = (skipped[reason] ?? 0) + 1
      continue
    }
    candidates.push({
      id: s.id,
      label: sessionLabel(s),
      startedAt: s.startedAt ?? null,
      lastActivityAt: s.lastActivityAt ?? null,
      // Clamp "unknown" (Infinity) so JSON logs stay numeric.
      idleSec: Math.min(Math.floor(idleMsOf(s, nowMs) / 1000), MAX_IDLE_SEC),
    })
  }
  counts.eligible = candidates.length

  candidates.sort((a, b) => {
    const aAt = parseMs(a.lastActivityAt ?? undefined) ?? parseMs(a.startedAt ?? undefined) ?? 0
    const bAt = parseMs(b.lastActivityAt ?? undefined) ?? parseMs(b.startedAt ?? undefined) ?? 0
    return aAt - bAt || a.id.localeCompare(b.id)
  })

  const base = { verdict, candidates, counts, skipped, policy } as const
  if (verdict === "OK") {
    return {
      ...base,
      action: "none",
      idleReason: "host is OK — nothing to close",
      close: [],
      projectedAlive: counts.alive,
      targetAlive: null,
      budget: 0,
    }
  }

  const sessionsCheck = health.checks.find(c => c.id === "sessions")
  const threshold = health.thresholds.warnSessions
  let targetAlive: number | null = null
  let needed = 0
  if (sessionsCheck && sessionsCheck.status !== "OK" && typeof sessionsCheck.value === "number") {
    // The check trips at >= warnSessions, so "below" means warnSessions - 1.
    targetAlive = Math.max(0, threshold - 1)
    needed = Math.max(0, sessionsCheck.value - targetAlive)
  }

  let budget = verdict === "CRIT" ? policy.critMaxClose : policy.warnMaxClose
  if (needed > 0) {
    // WARN: close exactly what the sessions check asks for ("just enough").
    // CRIT: at least the normal CRIT sweep, plus whatever is needed to get
    // back under the WARN sessions limit.
    budget = verdict === "WARN" ? Math.max(1, needed) : Math.max(budget, needed)
  }
  budget = Math.min(Math.max(0, budget), candidates.length)

  const close = candidates.slice(0, budget)
  const idleReason =
    close.length > 0
      ? null
      : counts.alive === 0
        ? "no live sessions"
        : counts.eligible === 0
          ? "no eligible idle sessions (all live sessions are busy, protected, recently active, or waiting)"
          : "policy allows no further closures"

  return {
    ...base,
    action: close.length > 0 ? "close" : "none",
    idleReason,
    close,
    projectedAlive: counts.alive - close.length,
    targetAlive,
    budget,
  }
}

/**
 * Re-validate one selected candidate against a FRESH session list taken
 * immediately before its kill. The kill route is unconditional (it does not
 * check `busy`), so a session that started a turn after the initial snapshot
 * must be caught here. Returns the skip reason, or null when it is still
 * safe to close. A session missing from the fresh list is `not-alive`.
 */
export function recheckGuardCandidate(
  id: string,
  fresh: readonly GuardSession[],
  opts: {
    verdict: HealthVerdict
    nowMs: number
    policy?: Partial<GuardPolicy>
    protectedSessionIds?: readonly string[]
  },
): GuardSkipReason | null {
  const policy = resolvePolicy(opts.policy)
  const session = fresh.find(s => s.id === id)
  if (!session) return "not-alive"
  const explicit = new Set(opts.protectedSessionIds ?? [])
  const hasLiveChild = new Set<string>()
  for (const s of fresh) {
    if (isAliveSession(s) && s.parentSessionId) hasLiveChild.add(s.parentSessionId)
  }
  const minIdleSec = opts.verdict === "CRIT" ? policy.critMinIdleSec : policy.warnMinIdleSec
  return ineligibility(session, {
    nowMs: opts.nowMs,
    minIdleMs: minIdleSec * 1000,
    ancestors: protectedAncestors(fresh, explicit),
    protectedIds: explicit,
    hasLiveChild,
  })
}

/** The CRIT marker consumed by the workflow launch gate. */
export interface GuardState {
  verdict: "CRIT"
  reasons: readonly string[]
  at: string
  expiresAt: string
  closed: readonly { id: string; label: string; idleSec: number }[]
  remaining: { alive: number; busy: number; keepAlive: number }
}

/** Why a workflow start (`workflow start|run-file`, of any weight) must be
 *  refused, or null when allowed. Pure, so the gate's expiry/verdict rules
 *  are testable. */
export function heavyWorkflowBlockReason(
  state: GuardState | null | undefined,
  nowMs: number,
): string | null {
  if (!state || state.verdict !== "CRIT") return null
  const expires = Date.parse(state.expiresAt)
  if (!Number.isFinite(expires) || expires <= nowMs) return null
  return `host is CRIT (${state.reasons.join("; ") || "no reasons recorded"}); host-guard has blocked workflow starts until ${state.expiresAt}. Free the host (or pass --force to override) and re-run \`agentproto host health\`.`
}

/** Best-effort read of the marker. Never throws: an unreadable marker means
 *  "not armed". */
export async function readGuardState(path: string = DEFAULT_GUARD_STATE_PATH): Promise<GuardState | null> {
  try {
    const raw = await readFile(path, "utf8")
    const parsed = JSON.parse(raw) as Partial<GuardState>
    if (parsed.verdict !== "CRIT" || typeof parsed.expiresAt !== "string") return null
    return {
      verdict: "CRIT",
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.filter((r): r is string => typeof r === "string") : [],
      at: typeof parsed.at === "string" ? parsed.at : new Date(0).toISOString(),
      expiresAt: parsed.expiresAt,
      closed: Array.isArray(parsed.closed) ? (parsed.closed as GuardState["closed"]) : [],
      remaining:
        parsed.remaining && typeof parsed.remaining === "object"
          ? (parsed.remaining as GuardState["remaining"])
          : { alive: 0, busy: 0, keepAlive: 0 },
    }
  } catch {
    return null
  }
}

async function writeGuardState(path: string, state: GuardState): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(state, null, 2) + "\n", "utf8")
}

async function clearGuardState(path: string): Promise<void> {
  await rm(path, { force: true })
}

async function appendLog(path: string, line: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, JSON.stringify(line) + "\n", "utf8")
}

// ── runner ──────────────────────────────────────────────────────────

const EXIT_USAGE = 64

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

interface SessionListBody {
  sessions?: SessionDescriptor[]
}

export const GUARD_USAGE = `Usage:
  agentproto host guard [--dry-run] [--json] [--log <path>|--no-log]
                        [--state <path>|--no-state]
                        [--agent <slug>] [--notify-session <id-or-name>]
                        [--no-escalate] [--warn-close <n>] [--crit-close <n>]
                        [--min-idle <s>] [--crit-min-idle <s>] [--settle <ms>]
                        [--budget <ms>]

The deterministic host watchdog, meant for \`*/20 * * * *\`. Reads
\`host health\` + the live session list, then:

  OK    nothing.
  WARN  closes the oldest already-idle sessions, just enough to fall back
        under the sessions WARN limit (else at most --warn-close, default 3).
  CRIT  same, more aggressively (--crit-close, default 10), writes a marker
        that blocks \`agentproto workflow start|run-file\`, and — only AFTER
        the cleanup — escalates to a brain (\`--notify-session\`) or a fresh
        agent (\`--agent\`) if the host is still CRIT.

A session is NEVER closed while busy, awaiting input/permission, holding
background tasks or queued prompts, watched, keepAlive, pinned, younger than
--min-idle/--crit-min-idle, an ancestor of a live session, or this guard's
own session. Nothing is spawned before cleanup.

  --dry-run              decide and log, close nothing, write no marker
  --json                 print the decision/report as JSON
  --log <path>           JSONL log (default ~/.agentproto/host-guard.log)
  --no-log               do not write a log
  --state <path>         CRIT marker (default ~/.agentproto/host-guard/state.json)
  --no-state             never write/clear the CRIT marker
  --agent <slug>         spawn this adapter if the host is still CRIT after cleanup
  --notify-session <id>  prompt this session instead of spawning a new agent
  --no-escalate          never notify/spawn
  --settle <ms>          wait after closing before re-checking (default 3000)
  --budget <ms>          host sample budget (same as host health --budget)
`

interface GuardFlags {
  dryRun: boolean
  json: boolean
  log: string | null
  state: string | null
  agent: string | undefined
  notifySession: string | undefined
  escalate: boolean
  policy: Partial<GuardPolicy>
  settleMs: number
  budgetMs: number | undefined
}

function parseGuardFlags(args: readonly string[]): { flags: GuardFlags } | { error: string } {
  let values: Record<string, string | boolean | undefined>
  try {
    values = parseArgs({
      args: [...args],
      allowPositionals: false,
      strict: true,
      options: {
        "dry-run": { type: "boolean" },
        json: { type: "boolean" },
        log: { type: "string" },
        "no-log": { type: "boolean" },
        state: { type: "string" },
        "no-state": { type: "boolean" },
        agent: { type: "string" },
        "notify-session": { type: "string" },
        "no-escalate": { type: "boolean" },
        "warn-close": { type: "string" },
        "crit-close": { type: "string" },
        "min-idle": { type: "string" },
        "crit-min-idle": { type: "string" },
        settle: { type: "string" },
        budget: { type: "string" },
      },
    }).values
  } catch (err) {
    return { error: errText(err) }
  }
  const num = (raw: unknown, flag: string, min: number): number | undefined | string => {
    if (raw === undefined) return undefined
    const n = Number(raw)
    if (!Number.isFinite(n) || n < min) return `--${flag} expects a number >= ${min}, got "${String(raw)}"`
    return n
  }
  const warnClose = num(values["warn-close"], "warn-close", 0)
  const critClose = num(values["crit-close"], "crit-close", 0)
  const minIdle = num(values["min-idle"], "min-idle", 0)
  const critMinIdle = num(values["crit-min-idle"], "crit-min-idle", 0)
  const settle = num(values.settle, "settle", 0)
  const budget = num(values.budget, "budget", 300)
  for (const v of [warnClose, critClose, minIdle, critMinIdle, settle, budget]) {
    if (typeof v === "string") return { error: v }
  }
  const policy: Partial<GuardPolicy> = {}
  if (typeof warnClose === "number") policy.warnMaxClose = warnClose
  if (typeof critClose === "number") policy.critMaxClose = critClose
  if (typeof minIdle === "number") policy.warnMinIdleSec = minIdle
  if (typeof critMinIdle === "number") policy.critMinIdleSec = critMinIdle
  return {
    flags: {
      dryRun: values["dry-run"] === true,
      json: values.json === true,
      log: values["no-log"] === true ? null : typeof values.log === "string" ? values.log : DEFAULT_GUARD_LOG_PATH,
      state:
        values["no-state"] === true
          ? null
          : typeof values.state === "string"
            ? values.state
            : DEFAULT_GUARD_STATE_PATH,
      agent: (typeof values.agent === "string" ? values.agent : process.env.HOST_GUARD_AGENT) || undefined,
      notifySession:
        (typeof values["notify-session"] === "string" ? values["notify-session"] : process.env.HOST_GUARD_NOTIFY_SESSION) ||
        undefined,
      escalate: values["no-escalate"] !== true,
      policy,
      settleMs: typeof settle === "number" ? settle : 3000,
      budgetMs: typeof budget === "number" ? budget : undefined,
    },
  }
}

async function fetchSessions(url: string): Promise<SessionDescriptor[]> {
  const body = await httpGetJson<SessionListBody>(`${url}/sessions`)
  return Array.isArray(body?.sessions) ? body.sessions : []
}

const execFileAsync = promisify(execFile)

/** Inspect a session's worktree for uncommitted or unpushed work. Bounded by
 *  `timeoutMs` per git command; ANY failure (timeout, no upstream, not a
 *  repo) returns `unknown: true`, which the decision treats as work-in-flight
 *  — we never reap what we cannot prove clean. */
export async function inspectWorktree(
  path: string,
  timeoutMs: number = WORKTREE_GIT_TIMEOUT_MS,
): Promise<WorktreeState> {
  try {
    const status = await execFileAsync("git", ["-C", path, "status", "--porcelain"], {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    })
    const dirty = status.stdout.trim().length > 0
    try {
      const count = await execFileAsync("git", ["-C", path, "rev-list", "--count", "@{u}..HEAD"], {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      })
      return { dirty, unpushed: Number(count.stdout.trim()) > 0 }
    } catch {
      return { dirty, unpushed: false, unknown: true }
    }
  } catch {
    return { dirty: false, unpushed: false, unknown: true }
  }
}

/** Pre-fetch worktree state onto the session rows the decision reads. Only
 *  live agent-cli sessions inside a linked worktree need a git probe. */
async function annotateWorktreeStates(sessions: readonly GuardSession[]): Promise<void> {
  await Promise.all(
    sessions.map(async s => {
      if (!s.worktreePath || !isAliveSession(s)) return
      if (s.kind !== undefined && s.kind !== "agent-cli") return
      ;(s as GuardSession).worktreeState = await inspectWorktree(s.worktreePath)
    }),
  )
}

function summarizeRemaining(sessions: readonly GuardSession[]): {
  alive: number
  busy: number
  keepAlive: number
} {
  return {
    alive: sessions.filter(isAliveSession).length,
    busy: sessions.filter(s => isAliveSession(s) && s.busy === true).length,
    keepAlive: sessions.filter(s => isAliveSession(s) && s.keepAlive === true).length,
  }
}

/** The guard's own session id, when the CLI runs inside an agent session. */
function selfSessionIds(): string[] {
  const out: string[] = []
  for (const key of ["AGENTPROTO_SESSION_ID", "AGENTPROTO_PARENT_SESSION_ID"]) {
    const v = process.env[key]
    if (v) out.push(v)
  }
  return out
}

async function reapSession(
  url: string,
  token: string | undefined,
  id: string,
  idleSec: number,
): Promise<void> {
  await httpPostJson(
    `${url}/sessions/${encodeURIComponent(id)}/reap`,
    { idleMs: Math.round(idleSec * 1000) },
    token,
  )
}

function humanReport(report: {
  verdict: HealthVerdict
  dryRun: boolean
  selection: GuardSelection
  closed: { id: string; label: string; idleSec: number }[]
  failed: { id: string; error: string }[]
  after: { verdict: HealthVerdict; reasons: readonly string[] } | null
  escalation: string
  logPath: string | null
}): string {
  const s = report.selection
  const lines: string[] = []
  lines.push(
    `host guard: ${report.verdict}${report.dryRun ? " (dry run)" : ""} — ` +
      `${s.counts.alive} live / ${s.counts.busy} busy / ${s.counts.keepAlive} keepAlive / ${s.counts.eligible} eligible`,
  )
  if (s.close.length === 0) {
    lines.push(`  nothing to close: ${s.idleReason ?? "no reason"}`)
  } else {
    lines.push(`  ${report.dryRun ? "would close" : "closing"} ${s.close.length} (target live ${s.targetAlive ?? "n/a"}):`)
    for (const c of s.close) lines.push(`    ${c.id} ${c.label} — idle ${Math.round(c.idleSec / 60)} min`)
  }
  for (const f of report.failed) lines.push(`    FAILED ${f.id}: ${f.error}`)
  if (report.after) {
    lines.push(`  after cleanup: ${report.after.verdict}${report.after.reasons.length > 0 ? " — " + report.after.reasons.join("; ") : ""}`)
  }
  if (report.escalation !== "none") lines.push(`  escalation: ${report.escalation}`)
  if (report.logPath) lines.push(`  log: ${report.logPath}`)
  return lines.join("\n") + "\n"
}

function escalationPrompt(args: {
  healthReasons: readonly string[]
  closed: readonly { id: string; label: string; idleSec: number }[]
  failed: readonly { id: string; error: string }[]
  remaining: { alive: number; busy: number; keepAlive: number }
  sessions: readonly GuardSession[]
}): string {
  const remaining = args.sessions.filter(isAliveSession).slice(0, 15)
  const rows = remaining.map(
    s =>
      `- ${s.id} ${sessionLabel(s)} status=${s.status ?? "?"} busy=${s.busy === true} keepAlive=${s.keepAlive === true} idle=${Math.round(idleMsOf(s, Date.now()) / 1000)}s`,
  )
  return [
    "HOST GUARD ESCALATION — the host is still CRIT after the automated cleanup pass.",
    "",
    `Health reasons: ${args.healthReasons.join("; ") || "none recorded"}`,
    `Remaining: ${args.remaining.alive} live, ${args.remaining.busy} busy, ${args.remaining.keepAlive} keepAlive.`,
    "",
    `Closed this pass (${args.closed.length}):`,
    ...(args.closed.length > 0
      ? args.closed.map(c => `- ${c.id} ${c.label} (idle ${Math.round(c.idleSec / 60)} min)`)
      : ["- (none)"]),
    ...(args.failed.length > 0 ? ["", "Failed to close:", ...args.failed.map(f => `- ${f.id}: ${f.error}`)] : []),
    "",
    "Live sessions still on the host:",
    ...(rows.length > 0 ? rows : ["- (none)"]),
    "",
    "Instructions:",
    "1. Do NOT start heavy workflows, big sandboxes, or large builds until `agentproto host health` is OK or WARN.",
    "2. Find what is consuming the host (`agentproto host load --full`); report the top processes and their owning sessions.",
    "3. Only stop sessions that are genuinely idle. Never stop a busy/keepAlive session.",
    "4. Report back to the supervisor with what you freed and what remains.",
  ].join("\n")
}

export async function runHostGuard(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(GUARD_USAGE)
    return 0
  }
  const parsed = parseGuardFlags(args)
  if ("error" in parsed) {
    process.stderr.write(`agentproto host guard: ${parsed.error}\n`)
    return EXIT_USAGE
  }
  const flags = parsed.flags
  const startedAt = new Date().toISOString()
  const nowMs = Date.now()

  const found = (await discoverDaemon()).found
  if (!found) {
    printNoDaemonError({ found: null, stale: [] }, "agentproto host guard")
    return 2
  }

  let health: ReturnType<typeof computeHostHealth>
  let sessions: SessionDescriptor[]
  try {
    const input = await gatherHealthInput({
      local: false,
      ...(flags.budgetMs !== undefined ? { budgetMs: flags.budgetMs } : {}),
    })
    health = computeHostHealth(input, DEFAULT_HEALTH_THRESHOLDS)
    sessions = await fetchSessions(found.url)
    await annotateWorktreeStates(sessions)
  } catch (err) {
    process.stderr.write(`agentproto host guard: ${errText(err)}\n`)
    return 2
  }

  const selection = selectGuardSessions({
    health,
    sessions,
    nowMs,
    ...(Object.keys(flags.policy).length > 0 ? { policy: flags.policy } : {}),
    protectedSessionIds: selfSessionIds(),
  })

  const closed: { id: string; label: string; idleSec: number }[] = []
  const failed: { id: string; error: string }[] = []
  if (!flags.dryRun) {
    for (const candidate of selection.close) {
      try {
        // Re-validate against a fresh list right before each reap (a turn may
        // have started, or the worktree may have become dirty, since the
        // initial snapshot).
        const fresh = await fetchSessions(found.url)
        await annotateWorktreeStates(fresh.filter(s => s.id === candidate.id))
        const changed = recheckGuardCandidate(candidate.id, fresh, {
          verdict: health.verdict,
          nowMs: Date.now(),
          ...(Object.keys(flags.policy).length > 0 ? { policy: flags.policy } : {}),
          protectedSessionIds: selfSessionIds(),
        })
        if (changed) {
          failed.push({ id: candidate.id, error: `skipped: session changed before reap (${changed})` })
          continue
        }
        await reapSession(found.url, found.token, candidate.id, candidate.idleSec)
        closed.push(candidate)
      } catch (err) {
        failed.push({ id: candidate.id, error: errText(err) })
      }
    }
  }

  let after: { verdict: HealthVerdict; reasons: readonly string[] } | null = null
  let escalation = "none"
  let remaining = {
    alive: selection.counts.alive,
    busy: selection.counts.busy,
    keepAlive: selection.counts.keepAlive,
  }
  if (!flags.dryRun && closed.length > 0) {
    // Report post-cleanup numbers in the marker, not the pre-cleanup snapshot.
    try {
      sessions = await fetchSessions(found.url)
      remaining = summarizeRemaining(sessions)
    } catch {
      remaining = {
        alive: Math.max(0, selection.counts.alive - closed.length),
        busy: selection.counts.busy,
        keepAlive: selection.counts.keepAlive,
      }
    }
  }

  if (!flags.dryRun && health.verdict === "CRIT" && flags.state) {
    const state: GuardState = {
      verdict: "CRIT",
      reasons: health.reasons,
      at: startedAt,
      expiresAt: new Date(nowMs + GUARD_STATE_TTL_MS).toISOString(),
      closed,
      remaining,
    }
    try {
      await writeGuardState(flags.state, state)
    } catch (err) {
      process.stderr.write(`agentproto host guard: could not write state marker: ${errText(err)}\n`)
    }
  }

  if (!flags.dryRun && health.verdict !== "CRIT" && flags.state) {
    try {
      await clearGuardState(flags.state)
    } catch {
      // A missing marker is the common case.
    }
  }

  if (!flags.dryRun && health.verdict === "CRIT") {
    if (flags.settleMs > 0) await new Promise(r => setTimeout(r, flags.settleMs))
    try {
      const input = await gatherHealthInput({
        local: false,
        ...(flags.budgetMs !== undefined ? { budgetMs: flags.budgetMs } : {}),
      })
      const post = computeHostHealth(input, DEFAULT_HEALTH_THRESHOLDS)
      after = { verdict: post.verdict, reasons: post.reasons }
      sessions = await fetchSessions(found.url)
      remaining = summarizeRemaining(sessions)
      if (post.verdict !== "CRIT" && flags.state) await clearGuardState(flags.state)
    } catch (err) {
      after = { verdict: "CRIT", reasons: [`re-check failed: ${errText(err)}`] }
    }

    if (after.verdict === "CRIT" && flags.escalate) {
      const prompt = escalationPrompt({
        healthReasons: after.reasons.length > 0 ? after.reasons : health.reasons,
        closed,
        failed,
        remaining,
        sessions,
      })
      const existing = sessions.find(
        s => isAliveSession(s) && s.label === GUARD_ESCALATION_LABEL && !closed.some(c => c.id === s.id),
      )
      const target = flags.notifySession ?? existing?.id
      try {
        if (target) {
          await httpPostJson(`${found.url}/sessions/${encodeURIComponent(target)}/prompt?wait=false`, {
            prompt,
            queue: true,
          }, found.token)
          escalation = `notified ${target}`
        } else if (flags.agent) {
          const spawned = await httpPostJson<{ session?: { id?: string }; id?: string }>(
            `${found.url}/sessions/agent`,
            { adapter: flags.agent, prompt, label: GUARD_ESCALATION_LABEL },
            found.token,
          )
          const id = spawned?.session?.id ?? spawned?.id ?? "unknown"
          escalation = `spawned ${flags.agent} as ${id}`
        } else {
          escalation = "skipped (no --agent or --notify-session configured)"
        }
      } catch (err) {
        escalation = `FAILED: ${errText(err)}`
      }
    }
  }

  const report = {
    at: startedAt,
    verdict: health.verdict,
    dryRun: flags.dryRun,
    action: selection.action,
    reasons: health.reasons,
    selection,
    closed,
    failed,
    after,
    escalation,
  }
  if (flags.log) {
    try {
      await appendLog(flags.log, report)
    } catch (err) {
      process.stderr.write(`agentproto host guard: could not write log: ${errText(err)}\n`)
    }
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n")
  } else {
    process.stdout.write(
      humanReport({
        verdict: health.verdict,
        dryRun: flags.dryRun,
        selection,
        closed,
        failed,
        after,
        escalation,
        logPath: flags.log,
      }),
    )
  }
  return 0
}
