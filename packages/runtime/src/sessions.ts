/**
 * Sessions registry — tracks long-lived child processes spawned by
 * the agentproto daemon (terminals, agent CLIs, custom commands).
 *
 * The registry lives in-memory for the daemon's lifetime; a recent
 * snapshot also persists to `~/.agentproto/sessions.json` so a fresh
 * daemon restart can show "you had these running before" instead of
 * losing all visibility on a crash.
 *
 * Each session owns:
 *   - identity: id, kind, workspace slug, command + args, started time
 *   - lifecycle: status (starting/running/exited/killed/error)
 *   - output:    last N lines (ring buffer) for instant attach + a
 *                Node EventEmitter for live streaming consumers
 *
 * Consumers:
 *   - HTTP routes (GET /sessions, /sessions/:id, /sessions/:id/stream,
 *     POST /sessions/:id/kill)
 *   - CLI `agentproto sessions` (TUI navigation + attach)
 *   - guilde-web Active tab (session cards + terminal viewer)
 */

import type { AcpMcpServer, AcpPermissionResolution } from "@agentproto/acp"
import type { SessionMode } from "@agentproto/acp/client"
import { spawn, type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdirSync, writeFileSync, promises as fs, readFileSync, existsSync } from "node:fs"
import { RESUME_STRATEGIES } from "./resume-strategies.js"
import { readCommandLogEntry, writeCommandLogEntry } from "./command-log.js"
import { readToolCallRecords as readToolCallRecordLines, writeToolCallRecord } from "./tool-call-log.js"
import { readUsageSnapshots as readUsageSnapshotLines } from "./usage-snapshot-log.js"
import { extractCommandArgs, type ToolCallRecord } from "./tool-call-record.js"
import { decideRule, loadHooksConfig } from "./hooks-config.js"
import { runShellGate } from "./supervisor.js"
import { deriveSessionTitle, MAX_LENGTH as TITLE_MAX_LENGTH } from "./session-title.js"
import {
  regenerateActivitySummary,
  type SessionActivitySummary,
} from "./session-activity.js"
import type {
  AuthMethod,
  ContextProfile,
  EffortLevel,
  Posture,
  RouteSpec,
} from "./session-config.js"
import type { CostBudget } from "@agentproto/auth"
import type {
  SessionEventBus,
  SessionAwaitingQuestion,
  SessionConfigChangedEvent,
} from "./session-event-bus.js"
import { resolvePosture } from "./canonical-posture.js"
import { tryParseModelRef } from "@agentproto/model-catalog/route-identity"
import {
  composeSessionObservers,
  filterSessionObserver,
  type SessionObserver,
} from "./session-observer.js"
import { formatToolCall, formatToolResult } from "./tool-presenter.js"
import { createTranscriptWriter, sessionEventsPath } from "./transcript-writer.js"
import {
  appendConversationRecord,
  resolveNativeLink,
  type ConversationIndexRecord,
} from "./conversation-index.js"
import {
  BUCKETS_ROOT,
  bucketSessionsFile,
  listBuckets,
  mergeBucketRows,
  migrateLegacySessionsFile,
  readBucketRows,
  readRegisteredSlugs,
  resolveBucketSlug,
  writeBucketSnapshot,
  writeBucketSnapshotSync,
} from "./workspace-buckets.js"
import { createTerminalTranscriptWriter } from "./terminal-transcript-writer.js"
import { deriveSessionUsage, plausibleContextUsed, type SessionUsage } from "./usage.js"
import { resolveWorktreeIdentity } from "./worktree-identity.js"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { randomUUID } from "node:crypto"

/**
 * Minimal shape we need from a driver-agent-cli session — kept as a
 * structural type so the runtime package doesn't take a hard
 * dependency on @agentproto/driver-agent-cli (the http-server route
 * imports it and passes the constructed session in).
 */
export interface AgentSessionLike {
  sessionId: string
  /** OS-level process id of the spawned child, when the driver owns a
   *  real subprocess. Mirrored onto `SessionDescriptor.pid` at
   *  `spawnAgent` time so `processAlive` can be computed without
   *  adapter-specific forensics. Undefined for drivers that don't
   *  expose a process (e.g. a future non-subprocess transport). */
  pid?: number
  send(message: unknown): AsyncIterable<AgentStreamEvent>
  cancel(): Promise<void>
  /** Resolve a permission request the driver parked in permission-hold mode
   *  (see the pending-permissions inbox below). `requestId` is the driver's
   *  own stable id, surfaced on the `agent-prompt` event's `toolCallId`.
   *  Returns true when a matching parked request was resolved. Absent for
   *  drivers that don't model held permissions (sandbox proxy, future
   *  transports). */
  respondPermission?(
    requestId: string,
    resolution: AcpPermissionResolution,
  ): boolean | Promise<boolean>
  /**
   * Switch the active model on this LIVE session — mirrors
   * `@agentproto/driver-agent-cli`'s `AgentCliRuntimeSession.setModel`
   * without importing it (this package stays driver-decoupled, same
   * reasoning as the rest of this structural interface). Optional: absent
   * for a session shape that doesn't support live model switching (a
   * sandboxed proxy session, or a future non-agent-cli transport) —
   * `SessionsRegistry.setModel` treats a missing method as
   * `{applied:false, reason:"not-supported"}` rather than throwing.
   */
  setModel?(modelId: string): Promise<SetSessionModelResult>
  /**
   * Switch the reasoning/compute budget on this LIVE session — mirrors
   * `@agentproto/driver-agent-cli`'s `AgentCliRuntimeSession.setEffort`
   * (ACP `session/set_config_option(configId:"effort")`), same driver-decoupled
   * structural-mirror reasoning as `setModel` above. Optional: absent for a
   * session shape with no live config surface (sandboxed proxy, future
   * transport) — `SessionsRegistry.setEffort` treats a missing method as
   * `{applied:false, reason:"not-supported"}` rather than throwing.
   */
  setEffort?(effort: string): Promise<SetSessionEffortResult>
  /**
   * Switch the native posture (harness mode) on this LIVE session — mirrors
   * `@agentproto/driver-agent-cli`'s `AgentCliRuntimeSession.setSessionMode`
   * (ACP `session/set_mode`). Optional, same treatment as `setModel`/`setEffort`.
   */
  setSessionMode?(modeId: string): Promise<SetSessionModeResult>
  /**
   * The harness's advertised session modes captured at connect time
   * (`SessionModeState.availableModes`, #482 ACP capability read-surface).
   * `SessionsRegistry.setPosture` resolves a requested posture against this to
   * decide native-live vs restart (SPEC §3.4a). Absent/empty for arms with no
   * native mode registry — treated as "no native mode", so any posture pick
   * routes to restart.
   */
  readonly availableModes?: readonly SessionMode[]
  close(): Promise<void>
}

/** Result of `SessionsRegistry.setModel` — see that method's doc comment. */
export interface SetSessionModelResult {
  applied: boolean
  /** The model id now active. Present only when `applied` is true. */
  model?: string
  /** Present only when `applied` is false — see
   *  `@agentproto/driver-agent-cli`'s `SetModelResult` for the reason
   *  vocabulary this passes through verbatim. */
  reason?: string
  /**
   * Present only on the model↔route guard refusal (SPEC risk R2 / §4.4): the
   * requested model's route-identity crosses the session's current route/vendor
   * boundary, which a live `setModel` cannot perform (route is a spawn-time
   * `ANTHROPIC_BASE_URL`, not a live ACP config option). The daemon refuses the
   * live switch (`applied:false, reason:"requires-restart"`) rather than
   * silently keeping the old endpoint, and hands back the override a
   * restart-with-override (step 6) should carry to apply model + route together.
   */
  suggestedOverride?: { route: RouteSpec; model: string }
}

/**
 * Result of `SessionsRegistry.setEffort` — mirrors the driver's
 * `SetEffortResult` (see `AgentSessionLike.setEffort`). Effort is a per-model
 * capability (SPEC §3.9); a rejected label is a soft `{applied:false, reason}`
 * (SPEC risk R7), never thrown.
 */
export interface SetSessionEffortResult {
  applied: boolean
  /** The effort label now active. Present only when `applied` is true. */
  effort?: string
  /** Present only when `applied` is false — passes the driver's reason through
   *  verbatim (`"not-supported"`, or the wrapper's own rejection detail). */
  reason?: string
}

/** Result of a mid-session `setSessionMode` attempt on the driver session —
 *  structural mirror of `@agentproto/driver-agent-cli`'s `SetSessionModeResult`,
 *  used by {@link AgentSessionLike.setSessionMode}. */
export interface SetSessionModeResult {
  applied: boolean
  /** The mode id that took effect. Present only when `applied` is true. */
  modeId?: string
  /** Present only when `applied` is false — the driver's reason verbatim. */
  reason?: string
}

/**
 * Result of `SessionsRegistry.setPosture` (SPEC §4.2, build step 5). A posture
 * that maps to a native advertised harness mode is switched LIVE via
 * `setSessionMode` (`applied:true`); one with no native mode (prompt-injected /
 * env-applied) is NOT forced live — it resolves
 * `{applied:false, reason:"requires-restart"}` so the caller routes it through
 * the restart-with-override path (step 6, not implemented here).
 */
export interface SetSessionPostureResult {
  applied: boolean
  /** The posture now active. Present only when `applied` is true. */
  posture?: Posture
  /** The native harness mode id switched to — present only on a native
   *  (`applied:true`) switch, so a caller can echo exactly what took effect. */
  modeId?: string
  /** Present only when `applied` is false — `"requires-restart"` when the
   *  posture has no native mode (prompt/env apply-path needs a fresh spawn),
   *  `"not-supported"` for a session with no live mode surface, or the harness's
   *  own rejection detail when a native switch was attempted and refused. */
  reason?: string
  /** How the requested posture resolved against the harness's advertised modes
   *  (`native` | `prompt` | `noop` | `unavailable`, from `resolvePosture`) —
   *  lets the caller distinguish "needs restart because prompt-injected" from a
   *  genuine native-switch rejection. */
  resolution?: "native" | "prompt" | "noop" | "unavailable"
}

/**
 * Minimal PTY surface — structurally compatible with
 * @agentproto/acp/tunnel's PtyProcess (node-pty's IPty wrapper). The
 * runtime declares its own so this package stays native-free; the
 * cli's pty-factory util constructs values that satisfy both.
 */
export interface PtyProcess {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(handler: (data: string) => void): void
  onExit(handler: (event: { exitCode: number; signal?: number }) => void): void
}

export interface PtyFactoryOptions {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  cols: number
  rows: number
}

export type PtyFactory = (opts: PtyFactoryOptions) => PtyProcess

export interface AgentStreamEvent {
  kind: string
  text?: string
  /** Correlates a "tool-call" with its later "tool-result" (and an
   *  "agent-prompt" with the permission it's asking about) — see
   *  @agentproto/acp's `StreamEvent`. */
  toolCallId?: string
  toolName?: string
  /** Tool-call input, e.g. an ACP `tool_call`'s `arguments` — see @agentproto/acp's `StreamEvent`. */
  arguments?: unknown
  /** True when a "tool-call" event ENRICHES one already announced under the
   *  same `toolCallId` (the agent knew the input only after announcing the
   *  call) rather than announcing a new one — see @agentproto/acp's
   *  `StreamEvent`. Consumers merge by toolCallId; it is not a second call. */
  isUpdate?: boolean
  /** Tool-call output, e.g. an ACP `tool_call_update`'s `result` — see @agentproto/acp's `StreamEvent`. */
  result?: unknown
  isError?: boolean
  reason?: string
  error?: { message: string; code?: number; data?: unknown }
  /** Structured options offered by an "agent-prompt" event (e.g. an ACP
   *  `requestPermission` callback surfaced as a clarifying question rather
   *  than auto-answered). Typed `unknown` — like `@agentproto/acp`'s own
   *  `StreamEvent["options"]` — so this structural type stays assignable
   *  from any driver's runtime session without a hard dependency on its
   *  exact option shape (`{optionId,name,kind}` for ACP, or whatever a
   *  future driver reports); `normalizeAgentPromptOptions` narrows it
   *  defensively at the one place it's consumed. */
  options?: unknown
  /** "agent-prompt" tool-call input, e.g. an ACP `requestPermission`'s
   *  `toolCall.rawInput` (a Bash tool's command string) — see
   *  @agentproto/acp's `StreamEvent`'s `agent-prompt` kind. Harness-shaped
   *  and untyped; don't assume a stable schema across adapters. */
  rawInput?: unknown
  /** "plan" event entries — see @agentproto/acp's `StreamEvent`'s `plan` kind. */
  entries?: Array<{ content: string; priority: string; status: string }>
  /** "usage_update" context-window size (tokens). */
  size?: number
  /** "usage_update" tokens currently in context. */
  used?: number
  /** "usage_update" cumulative session cost, when the adapter reports one. */
  cost?: { amount: number; currency: string }
  /** "usage_update" cumulative input/output token counts, when the adapter
   *  reports them (lets the daemon price a session whose adapter gives tokens
   *  but no `cost`). */
  tokensIn?: number
  tokensOut?: number
}

/**
 * Defensively narrow an "agent-prompt" event's `options` (typed `unknown`
 * — see `AgentStreamEvent.options`) into a flat label list. Accepts plain
 * strings, or objects exposing `label`/`name`/`id`/`optionId` (covers both
 * a hypothetical `{id,label}` shape and ACP's actual `{optionId,name,kind}`
 * `requestPermission` options) without assuming either driver-specific
 * shape at the type level.
 */
function normalizeAgentPromptOptions(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const labels = raw
    .map(o => {
      if (typeof o === "string") return o
      if (o && typeof o === "object") {
        const r = o as Record<string, unknown>
        const label = r.label ?? r.name ?? r.id ?? r.optionId
        if (typeof label === "string") return label
      }
      return undefined
    })
    .filter((s): s is string => typeof s === "string")
  return labels.length > 0 ? labels : undefined
}

/**
 * Narrow an `agent-prompt` event's `options` (typed `unknown`) into the ACP
 * `{ optionId, name?, kind? }` permission-option shape for the pending inbox.
 * Drops entries without a string `optionId` — those can't be responded to.
 */
function normalizePermissionOptions(
  raw: unknown,
): Array<{ optionId: string; name?: string; kind?: string }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ optionId: string; name?: string; kind?: string }> = []
  for (const o of raw) {
    if (!o || typeof o !== "object") continue
    const r = o as Record<string, unknown>
    if (typeof r.optionId !== "string") continue
    out.push({
      optionId: r.optionId,
      ...(typeof r.name === "string" ? { name: r.name } : {}),
      ...(typeof r.kind === "string" ? { kind: r.kind } : {}),
    })
  }
  return out
}

/**
 * Map an inbox decision onto one of the offered permission options.
 *   - explicit `optionId` wins (must be one of the offered options)
 *   - approve → an `allow_*` option (allow-always when `scope: "always"` and
 *     one is offered, otherwise allow-once, otherwise any allow-flavored)
 *   - deny → a `reject_*` option (undefined when none is offered → the caller
 *     resolves the request as `cancelled`)
 * Returns `null` only for an approve with no allow-flavored option — a hard
 * error (the request can't be granted through any offered option).
 */
function selectPermissionOptionId(
  options: ReadonlyArray<{ optionId: string; kind?: string }>,
  input: { decision: "approve" | "deny"; optionId?: string; scope?: "once" | "always" },
): { optionId: string } | { cancelled: true } | null {
  if (input.optionId) {
    return options.some(o => o.optionId === input.optionId)
      ? { optionId: input.optionId }
      : null
  }
  const kindStarts = (prefix: string) =>
    options.find(o => typeof o.kind === "string" && o.kind.startsWith(prefix))
  if (input.decision === "approve") {
    const chosen =
      (input.scope === "always"
        ? options.find(o => o.kind === "allow_always")
        : options.find(o => o.kind === "allow_once")) ??
      kindStarts("allow") ??
      // Some agents label the grant "proceed"/"yes" without an `allow_` kind —
      // fall back to the first non-reject option before giving up.
      options.find(o => !(typeof o.kind === "string" && o.kind.startsWith("reject")))
    return chosen ? { optionId: chosen.optionId } : null
  }
  // deny — prefer an explicit reject option; else cancel the request outright.
  const reject = options.find(o => o.kind === "reject_once") ?? kindStarts("reject") ?? kindStarts("deny")
  return reject ? { optionId: reject.optionId } : { cancelled: true }
}

/**
 * Classify what a tool call blocks the turn on, from its tool name alone.
 * Powers `SessionDescriptor.blockedOn`: "subagent" for an `agent_start`
 * (the turn is waiting on a spawned child agent), "command" for shell /
 * terminal execution tools. Anything else — including fast local tools —
 * returns undefined and leaves the descriptor untouched. Matching is
 * intentionally loose on the command side (bash/terminal/command
 * substrings) so adapter-native tool names (e.g. claude-code's "Bash")
 * classify without a per-adapter table.
 */
function classifyBlockedOn(toolName?: string): "subagent" | "command" | undefined {
  if (!toolName) return undefined
  const n = toolName.toLowerCase()
  if (n === "agent_start") return "subagent"
  if (/^(command_execute|terminal_start)$|bash|terminal|command/.test(n)) return "command"
  return undefined
}

/**
 * Release `blockedOn` — the thing the turn was waiting on is no longer
 * pending.
 *
 * `blockedOn` is a claim about the PRESENT ("this turn is waiting on a
 * command right now"), so every path that disproves the claim has to clear
 * it. Keying the release solely on a tool-result whose `toolCallId` matches
 * made the flag latch: a tool that FAILS emits `error`, never a tool-result,
 * so the session kept advertising "blocked on command · <id>" for the rest of
 * the turn while the agent had long since recovered and moved on. The turn's
 * `finally` did eventually clear it, which is why the lie was invisible on
 * short turns and glaring on long ones.
 */
function releaseBlockedOn(desc: SessionDescriptor): void {
  desc.blockedOn = undefined
  desc.pendingToolCallId = undefined
}

/**
 * True when a thrown value represents a turn ABORT rather than a genuine
 * error — a cancelled/killed turn surfaces as a DOMException-style
 * `AbortError` (`name`) or Node's `ABORT_ERR` (`code`). Lets the turn
 * finalizer synthesize a `turn-end` tagged `"aborted"` instead of
 * mislabelling a deliberate cancel as a turn error. Kill-driven aborts are
 * additionally caught by inspecting the descriptor status at the call site.
 */
function isAbortError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false
  const name = "name" in err ? err.name : undefined
  const code = "code" in err ? err.code : undefined
  return name === "AbortError" || code === "ABORT_ERR"
}

export const SESSIONS_FILE_PATH = (): string =>
  resolve(homedir(), ".agentproto", "sessions.json")

/** Mint a session id in the registry's own format. Exported so a spawner
 *  (session-spawn.ts) can pre-generate one BEFORE the child session starts —
 *  e.g. to bake it into the child's own MCP callback URL as `callerSessionId`
 *  — and hand it in via `SpawnAgentInput.id` / `SpawnSessionInput.id`. */
export function mintSessionId(): string {
  return `sess_${randomUUID().slice(0, 8)}`
}

export type SessionKind = "terminal" | "agent-cli" | "command" | "browser"
export type SessionStatus =
  | "starting"
  | "running"
  | "exited"
  | "killed"
  | "error"

/**
 * Thrown by `sendPrompt` / `enqueuePrompt` when the target agent-cli
 * session is dead (status exited/killed/error) and either isn't
 * resumable or its resume attempt already failed. Carries the actual
 * `status` so ingress layers (MCP `agent_prompt`, HTTP
 * `POST /sessions/:id/prompt`) can report a truthful, structured error
 * instead of the prompt silently going nowhere — see the "prompt to a
 * dead session" bug this type fixes at its throw site in
 * `validateAgentTurn`.
 */
export class SessionNotAliveError extends Error {
  readonly sessionId: string
  readonly status: SessionStatus
  constructor(sessionId: string, status: SessionStatus, caller: string) {
    super(`${caller}: session "${sessionId}" is not alive (status=${status})`)
    this.name = "SessionNotAliveError"
    this.sessionId = sessionId
    this.status = status
  }
}

/**
 * The billing-auth resolver's OBSERVABLE echo, recorded on a session
 * descriptor. `mode` + `fingerprint` are always present when recorded (a
 * credential resolved); `provider` / `credentialSource` / `setEnv` are the
 * multi-provider resolver's additions (DECISION 9③/10②) — optional for
 * back-compat with descriptors from before that resolver shipped.
 */
export interface SessionAuthEcho {
  mode: "subscription" | "api-key"
  fingerprint: string
  provider?: string
  credentialSource?:
    | "explicit-config"
    | "providers-store"
    | "claude-code-oauth"
    | "cli-local-login"
    | "none"
  setEnv?: string
}

/**
 * The `access` axis's descriptor ECHO (SPEC §3.6/§3.7) — a non-secret
 * description of the NAMED auth profile attached to the session, recorded so a
 * client chip can NAME the wallet ("Jeremy Max") without re-resolving it. This
 * is deliberately separate from {@link SessionAuthEcho}, which stays as-is: the
 * `auth` echo is the resolver's observable output (mode + credential
 * fingerprint), this is the profile IDENTITY the operator selected. NEVER the
 * credential — `profileRef` resolves through `@agentproto/auth` at read time
 * (`packages/auth/src/profile-types.ts:24`, #470). `profileRef` is always set
 * when this object is present (the profile is the reason it exists); the rest
 * mirror the `AuthProfile` fields the chip renders.
 */
export interface SessionAccessProfileEcho {
  profileRef: string
  label?: string
  /** Billing endpoint, deliberately distinct from the model's vendor. */
  endpoint: string
  method: AuthMethod
}

export interface SessionDescriptor {
  id: string
  kind: SessionKind
  workspaceSlug: string
  /** What was actually run — quoted joined for display purposes
   *  (`bash -lc "claude --resume xyz"`). */
  command: string
  pid: number | null
  status: SessionStatus
  startedAt: string
  endedAt?: string
  exitCode?: number
  /** Set alongside `status: "killed"` when the session ended NOT because an
   *  operator targeted it (`kill()`) but because of an AUTOMATIC teardown:
   *   - `"daemon-restart"` — the daemon process it lived in went away out from
   *     under it: a hard crash discovered at next boot
   *     (`loadHistorySnapshot`'s wasAlive reclassification), or a graceful
   *     shutdown/restart that force-kills whatever's still busy
   *     (`shutdownImpl`).
   *   - `"idle-reaped"` — the idle-session reaper (`reapIdle`, PR-6) retired a
   *     long-idle agent-cli row to free its adapter process. Deliberately kept
   *     lazy-resumable (adapterSessionId/cwd intact) so a later prompt revives
   *     it, but NEVER eager-resumed on boot — the eager pass (#638) gates on
   *     `endedReason === "daemon-restart"`, so an `"idle-reaped"` row is
   *     naturally excluded and a resume-storm of dead work is avoided.
   *  Absent for every other terminal path (operator kill, natural exit, turn
   *  error) — the session's own fault, or at least not an automatic sweep's.
   *  Lets the UI show "crashed with the daemon" / "reaped while idle" instead
   *  of a bare "killed" that reads as deliberate. */
  endedReason?: "daemon-restart" | "idle-reaped"
  /** Whether a turn was actually in flight the INSTANT `status` flipped to
   *  "killed" — captured before anything else runs, because `busy` itself
   *  cannot be trusted after the fact: `runAgentTurn`'s `finally` is what
   *  clears `busy`, and that `finally` never fires for a generator that's
   *  never resumed (a killed child mid-tool-call, or a dead daemon), so a
   *  post-hoc read of `busy` on a killed session may just be showing you
   *  whatever it froze at. This field exists because `status: "killed"`
   *  alone can't tell a human's Stop mid-turn apart from a supervisor
   *  reaping a child that had already finished — both leave `exitCode:
   *  null`, and `turnsCompleted` alone is too weak (a session killed
   *  mid-SECOND-turn also has `turnsCompleted: 1`). `killedMidTurn: true`
   *  paired with any `turnsCompleted` means interrupted; `false`/absent
   *  alongside `turnsCompleted > 0` means the work was done before the
   *  kill — see activityFor in the vscode package for the read. Set by
   *  `kill()`, `shutdownImpl`'s force-kill, and `loadHistorySnapshot`'s
   *  wasAlive reclassification; absent for every other terminal path. */
  killedMidTurn?: boolean
  /** Last time anything was written to stdout/stderr. Lets the UI
   *  spot stuck sessions ("running for 2h, last output 12min ago"). */
  lastOutputAt?: string
  /** Last time ANY adapter-process activity was observed — ACP
   *  JSON-RPC traffic, protocol-level events, not just ring-buffer
   *  output lines. Stays current during long tool-call chains where
   *  `lastOutputAt` goes stale. Updated on incoming session/update
   *  notifications AND on outbound RPC calls. ISO 8601. */
  lastActivityAt?: string
  /** Whether the underlying OS process is still alive. Computed via
   *  `process.kill(pid, 0)` at read time (list()/get()) — cheap,
   *  zero-overhead, standard POSIX check. Absent when `pid` is null
   *  (no process to check). Never persisted — recomputed fresh on
   *  every read since it's a live OS query, stale the instant it's
   *  written to disk. */
  processAlive?: boolean
  /** DERIVED, read-time only (never persisted — stripped by `snapshotRows`,
   *  stamped by `stampInterrupted` in list()/get()/findByIdOrName). True when
   *  this session died with a turn in flight under a daemon restart —
   *  `killedMidTurn && endedReason === "daemon-restart"` — the interrupted-turn
   *  marker (§4 of the session-survivability contract). Surfaces to
   *  `session_list` / `session_monitor` so a human or orchestrator can tell a
   *  session that came back idle from one that came back with dropped work
   *  that was NOT re-run. Cleared on the next successful turn-end (which clears
   *  the underlying `killedMidTurn`/`endedReason`). The in-place resume path
   *  never auto-retries the interrupted prompt. */
  interrupted?: boolean
  /** How many in-place resume attempts have FAILED in a row for this session
   *  (§5 cap/backoff). Incremented on every failed `maybeResumeAgent` attempt —
   *  the resume throws, the adapter rejects the id, or the spawn returns null —
   *  and reset on the next successful turn-end (a resume that then runs a turn
   *  to completion has demonstrably recovered). PERSISTED (unlike the derived
   *  `interrupted`): the counter has to outlive the daemon so a launchd
   *  KeepAlive crash-loop can't re-attempt a broken session past the cap on
   *  each fresh boot — N daemon crashes eager-resume a row at most
   *  `MAX_RESUME_ATTEMPTS` times TOTAL, not N×cap. Once it reaches
   *  `MAX_RESUME_ATTEMPTS` the lazy path stops spawning and fails loud
   *  (`ResumeDisabledError` → "use session_restart"); the eager pass (PR-4)
   *  skips the row via `canResume`. Absent (never `0`) until the first
   *  failure. */
  resumeAttempts?: number
  /** ISO 8601 timestamp of the most recent FAILED in-place resume attempt
   *  (§5). Stamped alongside every `resumeAttempts` increment; cleared with the
   *  counter on a successful turn-end. Lets an operator see how recently the
   *  backoff last tripped. Absent until the first failure. */
  lastResumeAt?: string
  /** Free-text label the spawner can attach (e.g. conversation id,
   *  operator name) so the UI can group/filter. */
  label?: string
  /** Derived from the session's FIRST prompt — what this conversation is
   *  about, for a UI that would otherwise show the adapter's argv. Distinct
   *  from `label`, which the spawner supplies. A derived `title` now OUTRANKS
   *  a spawn-supplied `label` in the display chain (see `sessionDisplayName`
   *  in session-title.ts) — only a `label` a *human* wrote via `session_rename`
   *  (flagged `renamedByUser`) beats it. */
  title?: string
  /** True only when a HUMAN renamed this session via `session_rename`
   *  (`renameSession`) — never for a spawner-supplied `label`. It's the one
   *  signal that makes a `label` outrank the derived `title` in
   *  `sessionDisplayName`: a spawn slug ("auto-title-precedence-fix") must not
   *  shadow the useful derived title, but a user's deliberate rename must.
   *
   *  Back-compat: sessions persisted before this flag existed carry a `label`
   *  (possibly a stale spawn slug, possibly an old user rename — the pre-flag
   *  rename write-path targeted `label` too, so the two are indistinguishable
   *  on disk) with NO flag. `sessionDisplayName` treats an absent flag on a
   *  labelled session as `true` so those old renames are never lost — only
   *  NEW spawns, which now stamp `renamedByUser: false` explicitly, let the
   *  derived title win over the spawn label. */
  renamedByUser?: boolean
  /** SECONDARY, auto-regenerating "activity" line — what this session is
   *  CURRENTLY doing, distinct from and NEVER a substitute for the frozen
   *  `title`. Recomputed on turn-end (throttled) via the SAME heuristic
   *  `summarize_session` serves the overview panel (`regenerateActivitySummary`
   *  → `summarizeLines` + `deriveSessionState`) — no LLM. Persisted (spread with
   *  every other field into the snapshot) so a client — the VSCode Sessions
   *  tree — can render it as the row's secondary line from `session_list`
   *  alone, WITHOUT opening the session or calling `summarize_session` per row.
   *
   *  Two invariants (see `regenerateActivitySummary`): it NEVER writes `title`,
   *  and it is NEVER regenerated for a session a human renamed (`renamedByUser`)
   *  — that session's activity semantics are frozen. The documented swap point
   *  for an optional LLM summariser is `regenerateActivitySummary`; the default
   *  stays heuristic. Absent until the first turn-end regenerates it. */
  activitySummary?: SessionActivitySummary
  /** Housekeeping-only visibility flag: hides the session from `list()`'s
   *  default view (`session_list`, `GET /sessions`, panels) once set. Never
   *  touches the daemon otherwise — the process is already gone by the time
   *  this is set (see the terminal-status guard on `archiveSession`), the
   *  transcript stays fully readable via `get()`/`findByIdOrName` (neither
   *  filters on it), and `list({ includeArchived: true })` still returns it.
   *  Set by `archiveSession`/`unarchiveSession` (session-tools.ts's
   *  `session_archive`/`session_unarchive`), persisted like every other
   *  descriptor field, and round-trips through `loadHistorySnapshot` on
   *  reboot since it's carried by the same `...desc` spread every other
   *  field is. Absent (not `false`) for every descriptor from before this
   *  field existed — treated the same as `false` everywhere it's read. */
  archived?: boolean
  /** True when the session was spawned under a real PTY (node-pty)
   *  instead of `child_process.spawn`. PTY sessions carry raw ANSI
   *  bytes (alt-screen, key bindings, colors); attach goes through
   *  WS /sessions/:id/pty rather than SSE /sessions/:id/stream. */
  pty?: boolean
  /** User-friendly slug supplied at spawn time. Optional; when set,
   *  attach/stop/kill commands accept it as an alias for the id. */
  name?: string
  /** Argv that was spawned. Persisted so `agentproto sessions restart`
   *  can clone the original shape without re-tokenizing the display
   *  `command` string. Empty for agent-cli sessions (we record
   *  `adapterSlug` separately). */
  argv?: readonly string[]
  /** Working directory the session was spawned in. Cloned by restart. */
  cwd?: string
  /** Root of the git worktree the session was spawned in — the session→
   *  worktree edge, resolved from `cwd` at spawn time
   *  (`resolveWorktreeIdentity`). Distinct from `cwd`, which may be a
   *  subdirectory of it. Absent when `cwd` isn't inside a linked worktree (a
   *  plain checkout, a non-repo dir) and for every session persisted before
   *  this field existed.
   *
   *  Recorded rather than computed at read time because it can't be
   *  recovered later: a worktree removed after the session ran leaves nothing
   *  on disk to re-resolve. */
  worktreePath?: string
  /** Generation id of that worktree, read at spawn from the provision marker
   *  (`agentproto-worktree.json` in the worktree's private gitdir, written by
   *  `worktree.provision`). Absent whenever `worktreePath` is, and also for a
   *  worktree created by a bare `git worktree add` — nothing writes a marker
   *  there. The marker is what distinguishes generations, so a
   *  `worktreePath` without an id identifies a PATH, which a later worktree
   *  may reuse; the pair identifies one specific worktree. */
  worktreeId?: string
  /** Pull requests opened while this session was acting on a code host.
   *
   * This is deliberately session provenance rather than workspace state: a
   * session may open more than one PR, and the same workspace can have many
   * independent sessions. It is append-only and persists with the descriptor
   * so a restarted daemon can still show the hand-off / review links. */
  openedPrs?: readonly OpenedPullRequest[]
  /** Adapter slug for agent-cli sessions — restart uses this with
   *  `/sessions/agent` to spin up a fresh ACP runtime. Undefined for
   *  pty/command kinds. */
  adapterSlug?: string
  /**
   * Canonical harness slug for agent-cli sessions — the same identity as
   *  `adapterSlug`, recorded under the canonical axis name. Falls back to
   *  `adapterSlug` when not explicitly set. Undefined for pty/command kinds. */
  harness?: string
  /**
   * AIP-45 mode the session was spawned with (`AgentCliStartOptions.config.
   * mode` — e.g. claude-code's `plan`/`accept-edits`, a gateway preset mode
   * like `moonshot`). Undefined for the adapter's default/native mode.
   * Recorded so a client can tell whether a candidate model switch stays
   * within THIS mode (live-switchable via `setModel`) or needs a different
   * one (`AgentCliModelEntry.mode` on the target) — a mode change is
   * spawn-time env/argv rewiring (e.g. `ANTHROPIC_BASE_URL`), which
   * `POST /sessions/:id/model` cannot perform on a live process; that case
   * is surfaced to clients as `requires-restart`, never silently attempted.
   */
  mode?: string
  /** The model the session was requested to run (echoed back at spawn). */
  model?: string
  // ── Decomposed per-session config axes (SPEC §3.1/§3.7,
  //    `agentproto-session-config-axes`). Each is the DESCRIPTOR ECHO of one
  //    orthogonal axis, recorded here so a picker chip renders that axis
  //    independently instead of decoding the compound legacy `mode` string
  //    above (SPEC §3.8). All optional and `...desc`-spread-persisted like
  //    every other field, so they round-trip through `loadHistorySnapshot`
  //    and read as "adapter default" when absent on a pre-existing
  //    descriptor (SPEC risk R6). This step adds the SHAPE + round-trip only;
  //    the live-config verbs (`agent_set_effort`/`_posture`) and the
  //    restart-override that WRITE them are later build steps.
  /** Reasoning / compute budget the session resolved to (SPEC §3.1 axis 2).
   *  A LIVE-switchable axis; echoed here so the effort chip re-opens on it. */
  effort?: EffortLevel
  /** What the agent may DO (SPEC §3.1 axis 5) — an agentproto-canonical
   *  posture or a raw `{ harnessModeId }` sourced from the harness's ACP mode
   *  registry (SPEC §3.4a). */
  posture?: Posture
  /** Endpoint / gateway rail (SPEC §3.1 axis 4). `baseUrl` is carried only
   *  for a custom gateway the catalog can't resolve; `access` is downstream
   *  of this axis (SPEC §1c). */
  route?: RouteSpec
  /** What enters context (SPEC §3.1 axis 5b) — `"lean"` drops bundled skills. */
  contextProfile?: ContextProfile
  /** The `access` axis echo (SPEC §3.6/§3.7): the NAMED auth profile attached
   *  to the session, so the access chip can name the wallet. Distinct from the
   *  `auth` fingerprint echo below, which stays as-is — see
   *  {@link SessionAccessProfileEcho}. NEVER the credential. */
  accessProfile?: SessionAccessProfileEcho
  /**
   * Deterministic billing-auth mode + a non-secret credential fingerprint,
   * recorded at spawn time for adapters that resolved an explicit
   * credential (today: claude-code — see `AgentCliAuth.modes` in
   * `@agentproto/driver-agent-cli`). The "verifiability" answer to "what
   * was used": `mode` is the resolved `"subscription" | "api-key"`;
   * `fingerprint` is `credentialFingerprint(mode, credential)` — e.g.
   * `"subscription · sk-ant-oat…3f9c"` — NEVER the raw credential. Absent
   * when no credential resolved (every adapter besides claude-code, in
   * practice) or for a sandboxed spawn (the box's own daemon resolves its
   * own credential independently). Surfaced in `agentproto sessions
   * --watch`'s DETAIL pane and `agent_sessions_list`.
   *
   * Carries the resolver's OBSERVABLE echo (DECISION 9③/10②): `provider`,
   * `credentialSource`, and the `setEnv` actually set — so a verifier checks
   * the RESOLUTION, not the model's self-report. These are optional for
   * back-compat with descriptors persisted before the multi-provider resolver.
   */
  auth?: SessionAuthEcho
  /** Cumulative estimated USD cost of the session — best-effort, refreshed
   *  on each turn-end from the adapter's usage reader (e.g. hermes reads its
   *  state.db). Absent for adapters with no usage source. */
  costUsd?: number
  /** Cumulative input / output token counts (same source + cadence as costUsd). */
  tokensIn?: number
  tokensOut?: number
  /** Context-window size + tokens-in-context from the latest `usage_update`
   *  event (ACP adapters that report a context window). Refreshed live as
   *  usage_update events arrive, not just at turn-end. */
  contextSize?: number
  contextUsed?: number
  /** Where `costUsd` came from — `"adapter"` (adapter's own reader or a
   *  usage_update cost block), `"computed"` (tokens × in-repo catalog price),
   *  `"no-pricing"` (tokens present but the model isn't in the catalog — cost
   *  deliberately left undefined), or `"none"`. Stamped at each turn-end. */
  usageSource?: import("./usage.js").UsageSource
  /** ACP-level session id (the adapter's own handle — claude-code's
   *  conversation id, hermes' chat id, …). Set at spawnAgent time
   *  from `agentSession.sessionId`. Survives across daemon restarts
   *  via sessions.json so `restart` can pass it as `resumeSessionId`
   *  and reattach to the prior conversation history. */
  adapterSessionId?: string
  /** MCP servers mounted into the agent's session at spawn time
   *  (orchestrator WP1). Persisted so the resume/re-spawn path can
   *  re-mount the same host-chosen toolset instead of resuming a
   *  capability-stripped agent. The current `AcpMcpServer` shape is
   *  `{ name, transport, ref? }` — a reference, NOT inline credentials
   *  — so this carries no secrets today. Should the shape ever grow
   *  headers/tokens, NEVER log this field's contents. */
  mcpServers?: AcpMcpServer[]
  /** Provider-specific resume hints sniffed from the session's
   *  output. claude-code prints `claude --resume <uuid>` on exit;
   *  we capture that uuid as `claudeResumeId`. On `restart`, when a
   *  hint is present, agentproto prefers a PTY spawn with the
   *  provider's native resume command (`claude --resume <id>`) over
   *  the ACP-level resume — works wherever the provider persisted
   *  the session, not just when the ACP wrapper did.
   *
   *  Keys are adapter-specific so future adapters can add their own
   *  ("hermesResumeId", etc.) without changing this type. */
  resumeMetadata?: Record<string, string>
  /** Set by the orchestration layer when the agent emits an
   *  "awaiting-input" turn-end. Cleared on the next turn start.
   *  Used by `session_monitor` to fast-return without subscribing. */
  awaitingInput?: boolean
  /**
   * Structured detail on WHY the session is awaiting input, when it can be
   * determined — lets an orchestrator distinguish "blocked on a real
   * question" from "just finished a turn" without re-reading raw output.
   * `source: "structured"` comes from a driver-reported ACP-style prompt
   * (`AgentStreamEvent.options`, e.g. a tool permission request);
   * `source: "heuristic"` is a best-effort guess from the tail of the
   * transcript (trailing "?" + an optional enumerated option list) for
   * drivers that don't report structured prompts. Cleared alongside
   * `awaitingInput` on the next turn start. */
  awaitingQuestion?: SessionAwaitingQuestion
  /** True while this session (spawned in permission-hold mode) has at least
   *  one permission request parked in the inbox awaiting a human/orchestrator
   *  decision. Distinct from `awaitingInput` (a conversational question) — a
   *  held permission is resolved via `permissions_respond` / `agentproto
   *  permissions approve|deny`, not a normal prompt. Set when a request is
   *  registered, cleared when the last pending one for this session resolves.
   *  Absent (never `false`) for sessions with no held permissions. */
  awaitingPermission?: boolean
  /** Count of turns that have fully completed (turn-end emitted) on this
   *  session. Lets `session_monitor` fast-return for a session that already
   *  finished its turn before the wait subscribed — a fast turn that ends
   *  in "completed" (not "awaiting-input") leaves no other persisted
   *  signal (status stays "running", busy clears). 0 = never ran a turn,
   *  so a freshly-spawned idle session is NOT mistaken for done. */
  turnsCompleted?: number
  /** True while a turn is actively running (mirror of the internal
   *  runtime `busy` flag). Lets `session_monitor` distinguish "idle after a
   *  finished turn" from "mid-turn" so it doesn't fast-return a stale
   *  turn-end while the NEXT turn is still generating. */
  busy?: boolean
  /** What the in-flight turn is currently blocked on, when classifiable
   *  from the pending tool call: a spawned sub-agent (`agent_start`) or a
   *  shell/terminal command. Deliberately NO "user" variant — waiting on
   *  the user is already covered by `awaitingInput`/`awaitingQuestion`.
   *
   *  Set on tool-call; released (see `releaseBlockedOn`) on the MATCHING
   *  tool-result, on `error` (a failing tool never emits a result), on the
   *  next assistant `text-delta` (the model has the floor, so nothing is
   *  pending), at turn start, and in the turn's finally. A claim about the
   *  present tense — anything that disproves it must clear it. */
  blockedOn?: "subagent" | "command"
  /** toolCallId of the tool-call that set `blockedOn`. A tool-result only
   *  clears `blockedOn` when its toolCallId matches — so a nested or
   *  interleaved tool finishing first can't clear the flag early. */
  pendingToolCallId?: string
  /** Session id of the orchestrator that spawned this session, set when
   *  the spawn arrived via the scoped orchestrator sub-gateway (the
   *  token carried the spawner's identity). Absent for direct `/mcp`
   *  spawns (the root operator). Powers the subtree scoping of
   *  list/kill and the per-parent child quota (orchestrator WP4).
   *  Persisted so the tree survives a daemon restart. */
  parentSessionId?: string
  /** Source label — the channel/harness this session was spawned from
   *  ("codex", "cowork", "vscode", "cron", …). Descriptor-only; groups the
   *  session under a source node in the tree. */
  origin?: string
  /** Id of the session that invoked this one, when the daemon genuinely
   *  knows it (cron's own recordCommand/spawnAgent calls, other
   *  daemon-internal callers holding a real session id). Best-effort: a
   *  `command_execute` call arriving through the shared daemon-wide MCP
   *  server has no per-caller binding, so this is left absent rather than
   *  guessed — see `origin` for the (always-set) coarser provenance label. */
  callerSessionId?: string
  /** Recursion depth in the orchestrator tree: a direct (root) spawn is
   *  depth 0; a session spawned by a depth-d orchestrator is d+1. Used
   *  by the depth-cap guard. Persisted alongside `parentSessionId`.
   *  Treated as 0 when absent (legacy rows / direct spawns that predate
   *  WP4). */
  depth?: number
  /** Id of the most recently-completed `kind: "command"` session spawned
   *  with the same `cwd`, found at spawn time — see `recordCommand` and
   *  `findPriorCommandSessionId`. Deliberately a REFERENCE, not copied
   *  content: a new session's own ring buffer / structured transcript
   *  never gets a prior command_execute's stdout/stderr spliced in, it
   *  just gets told where to look (`command_log_tail({sessionId})` or
   *  `agent_export`/`command_list` resolve the id into the full record).
   *  Set on `spawnAgent`/`spawnPty` when the registry already has a
   *  matching command session; absent otherwise (including for legacy
   *  rows persisted before this field existed). */
  priorCommandSessionId?: string
  /** Id of the prior session this one continues from — set when this
   *  session was spawned by `session_restart` (or the cron scheduler's
   *  `prompt-session` action), even when the resume attempt itself
   *  couldn't establish continuity: a fresh fallback spawn (adapter
   *  rejected the resume id as "not found") is still "restarted from"
   *  the prior session, just without conversation history carried over.
   *  Absent for a session spawned directly (not via restart). Persisted
   *  on the STORED descriptor (not just grafted onto the restart
   *  result's JSON, as it used to be) so it survives a `list()`/`get()`
   *  poll refresh and a daemon restart — see `resumeVia` for how the
   *  continuity was (or wasn't) established, and the transcript panel's
   *  chain-walk (vscode package) for the read side. */
  resumedFrom?: string
  /** Human-readable resume path used to arrive at `resumedFrom` — e.g.
   *  "resumed via claude --resume" (provider-native PTY resume) or
   *  "resumed via ACP" (adapter-level resume), or `""` when no
   *  continuity was established (a fresh fallback spawn — see
   *  `resumedFrom`). Only meaningful alongside `resumedFrom`; absent
   *  (never `""`) for a session that wasn't spawned via restart. */
  resumeVia?: string
  /** Free-form spawn-time hints stamped by the spawner — a small string map,
   *  same shape as `TaskRecord.meta`. Today's only key is `boardId`
   *  (`agent_start.boardId` → the Task ledger's board resolution prefers it
   *  over the `parentSessionId` lineage walk — see task-ledger.ts), but the
   *  field is deliberately generic so future spawn-time hints ride it
   *  without a schema change. Persisted via the same `...desc` spread as
   *  every other field, so it survives a daemon restart. */
  meta?: Record<string, string>
  // ── Browser-session fields (kind="browser") ──────────────────────────────
  /** Adapter id that drives this session (e.g. "camofox", "bureau"). */
  browserAdapterId?: string
  /** Port the browser service listens on. */
  browserPort?: number
  /** Base URL of the browser service (e.g. "http://127.0.0.1:9377"). */
  browserBaseUrl?: string
  /** Execution location — "local" (default) or "cloud". */
  browserLocation?: "local" | "cloud"
  /** True when this agent-cli session is running inside a sandbox (`agent_start.sandbox`)
   *  rather than as a local subprocess — there's no local PID to check, so
   *  `processAlive` never applies (it's already absent whenever `pid` is null). */
  remote?: boolean
  /** Provider-assigned sandbox id (`BootedSandbox.sandboxId`), when `remote` is true. */
  sandboxId?: string
  /** What session close does to the box (PR3 lifecycle) — `"kill"` (the
   *  default, ephemeral) or `"pause"` (keeps `sandboxId` reconnectable via
   *  `agent_start.sandbox.reuse`). Only set when `remote` is true. */
  sandboxTeardown?: "kill" | "pause"
}

interface SessionRuntime {
  desc: SessionDescriptor
  /** Set when the session is a raw spawn (`kind: "command"|"terminal"`).
   *  Agent sessions don't expose the underlying process — the
   *  driver-agent-cli runtime owns it. */
  child?: ChildProcess
  /** Set when the session is an agent-cli (multi-turn). The registry
   *  keeps it alive across turns; sendPrompt(id, prompt) re-uses it. */
  agentSession?: AgentSessionLike
  /** Adapter slug — only set for agent sessions, helps the UI render
   *  "claude-code" / "hermes" badges. */
  adapterSlug?: string
  /** Set when the session is a PTY (spawnPty). Bytes flow through
   *  pty.onData → recentBytes ring + emitter "data" event. */
  pty?: PtyProcess
  /** Per-subscriber size requests for the PTY. Min cols/rows
   *  across the live set is what we actually call pty.resize with
   *  (mirrors tmux's "smallest attached client wins" rule). */
  ptySubscribers?: Map<number, { cols: number; rows: number }>
  /** Ring buffer of recent stdout+stderr lines. Capped so a runaway
   *  child can't blow the daemon's heap. */
  recentLines: string[]
  /** Ring buffer of recent PTY bytes for replay-on-attach. Total
   *  size capped at RECENT_BYTES_CAP — oldest chunks dropped first. */
  recentBytes: Buffer[]
  recentBytesSize: number
  emitter: EventEmitter
  /** True while a turn is in flight. POST /sessions/:id/prompt rejects
   *  with 409 when busy — the agent can only handle one turn at a
   *  time per session. */
  busy: boolean
  /** Buffer for partial text-delta fragments — agent text events
   *  arrive as chunks, we coalesce them across deltas and split on
   *  newlines so each line lands as a discrete ring-buffer entry. */
  textBuf: string
  /** Same as textBuf but for `thought` events. Some agents (hermes)
   *  stream chain-of-thought as one delta per token, which made the
   *  ring buffer unreadable when each token got its own
   *  `[thought]` line — coalesce the same way text-delta does. */
  thoughtBuf: string
  /** In-flight resume promise. Deduplicates concurrent prompt
   *  attempts on a dead agent session — only one resume call hits
   *  the adapter, the rest await this promise. Cleared once
   *  resolved (success or failure). */
  resumePromise?: Promise<void>
  /** Async stop callback for browser sessions (kind="browser").
   *  Called by kill() best-effort — the descriptor is already flipped
   *  to "killed" before this fires. */
  browserStop?: () => Promise<void>
  /** Guard: true once session:exited has been emitted to sessionEvents.
   *  Prevents duplicate emissions when both kill() and an OS exit event fire. */
  exitedEmitted?: boolean
  /** Per-session cost cap. When set, the turn-end finally block checks
   *  the accumulated costUsd against this ceiling and kills the session
   *  if exceeded. */
  maxCostUsd?: number
  /** Windowed cost-budget cap (phase 4). Recorded here for provenance/read-back;
   *  DISTINCT from `maxCostUsd` — it never kills the session. Enforcement is a
   *  governance policy auto-attached at spawn time (`policy:failed` on windowed
   *  overage), not this turn-end block. */
  costBudget?: CostBudget
  /** Best-effort usage reader called after each turn. The adapter returns
   *  accumulated cost/token counts which are mirrored onto the descriptor. */
  readUsage?: () => Promise<{ costUsd?: number; tokensIn?: number; tokensOut?: number } | null>
  /** True once an authoritative cost has been observed from the adapter —
   *  either its `readUsage` returned a `costUsd`, or a `usage_update` carried
   *  a `cost` block. Drives the `"adapter"` vs `"computed"` source decision at
   *  turn-end. */
  adapterReportedCost?: boolean
  /** True when the session was spawned in permission-hold mode — its
   *  `agent-prompt` events carry respondable permission requests that get
   *  registered in the pending-permissions inbox. Default false. */
  permissionHold?: boolean
}

const RECENT_LINES_CAP = 500
const RECENT_BYTES_CAP = 64 * 1024
const PERSIST_DEBOUNCE_MS = 1_500

/** Shared, never-mutated empty set — the `heldIdsByBucket` lookup for a
 *  bucket this process has never placed anything in falls back to this
 *  instead of allocating a fresh empty `Set` on every persist. */
const EMPTY_ID_SET: ReadonlySet<string> = new Set()

/** Record that this daemon process has, at some point, placed session
 *  `id` in bucket `slug` — see `heldIdsByBucket`'s docblock at its
 *  declaration in `createSessionsRegistry` for why this has to be
 *  monotonic (never remove an id once added). Shared by the boot-time
 *  load path (`loadHistorySnapshot`) and the live resolve path
 *  (`groupRowsByBucket`) so both feed the same set. */
function markHeldId(map: Map<string, Set<string>>, slug: string, id: string): void {
  let set = map.get(slug)
  if (!set) {
    set = new Set()
    map.set(slug, set)
  }
  set.add(id)
}

/** Cap on the number of historical descriptors loaded from ONE
 *  sessions.json at boot. Older entries (by startedAt) are dropped
 *  on overflow — newest history wins. Adjust upward if the file
 *  starts feeling sparse; downward if the dashboard takes too long
 *  to render.
 *
 *  Per BUCKET, not per daemon (AIP-46 §Per-bucket bounds). That falls
 *  out of the load path calling `loadHistorySnapshot` once per bucket
 *  file rather than once over a pooled one, so this constant never has
 *  to know buckets exist — but the distinction is the whole point of
 *  the partition, so it is worth stating where the number lives.
 *
 *  When it WAS global, retention was a race between workspaces: the cap
 *  was spent by whoever was busiest, and the workspace that lost history
 *  was the one that had done nothing. A daemon pooling a few hundred rows
 *  across several workspaces reaches this ceiling in ordinary use, at
 *  which point a workspace holding a handful of rows loses them to a
 *  neighbour's busy afternoon. Per-bucket, a workspace's history is
 *  bounded by its own volume and nothing else's, so this is now a
 *  readability bound rather than a budget to contest. */
const HISTORY_CAP = 200

/** Bound on how long `enqueuePrompt({interrupt: true})` waits for a
 *  cancelled turn to actually settle (busy → false) before giving up.
 *
 *  This is NOT the "a few event-loop turns" happy path — ACP's
 *  `session/cancel` is a fire-and-forget notification (resolves on
 *  stdin flush, before the adapter has even seen it), and a genuinely
 *  wedged mid-tool-call turn (the case this bound exists for) can take
 *  the adapter's own full force-cancel grace period plus a stdio
 *  round-trip to actually yield. Exported so tests assert against the
 *  real value instead of a hardcoded duplicate. */
export const INTERRUPT_SETTLE_TIMEOUT_MS = 60_000

/** Compute `desc.processAlive` from `desc.pid` via the standard POSIX
 *  "signal 0" check — `process.kill(pid, 0)` throws `ESRCH` (or
 *  `EPERM`, treated as "exists but not ours") when the process is
 *  dead, and is a no-op (no actual signal delivered) when it succeeds.
 *  Mutates `desc` in place; called at read time (list()/get()) rather
 *  than persisted, since it's a live OS query that goes stale the
 *  instant it's written to disk. */
function stampProcessAlive(desc: SessionDescriptor): void {
  if (desc.pid === null || desc.pid === undefined) {
    delete desc.processAlive
    return
  }
  try {
    process.kill(desc.pid, 0)
    desc.processAlive = true
  } catch {
    desc.processAlive = false
  }
}

/** Compute the DERIVED `desc.interrupted` marker (§4 interrupted-turn
 *  contract): true iff the session died with a turn in flight under a daemon
 *  restart (`killedMidTurn && endedReason === "daemon-restart"`). Mutates
 *  `desc` in place; called at read time (list()/get()/findByIdOrName) — never
 *  persisted, since it derives entirely from two fields that ARE persisted, and
 *  it must go false the moment the next successful turn-end clears those. When
 *  the condition doesn't hold the field is deleted rather than set false, so a
 *  session that was never interrupted carries no `interrupted` key at all
 *  (same convention as `processAlive`). */
function stampInterrupted(desc: SessionDescriptor): void {
  if (desc.killedMidTurn === true && desc.endedReason === "daemon-restart") {
    desc.interrupted = true
  } else {
    delete desc.interrupted
  }
}

/**
 * Eligibility predicate for in-place resume of a dead row (§5 of the
 * session-survivability contract). True only for an agent-cli session that
 * carries everything the resume path needs — an `adapterSlug`, the
 * provider-native `adapterSessionId` that ACP `loadSession` rehydrates the
 * conversation from, and a `cwd` to re-spawn the adapter in — and that isn't
 * archived. PTY (`pty: true`) and generic `command` rows are never in-place
 * resumable: a PTY is raw screen+shell state the daemon can't reconstruct, and
 * a `command` is a one-shot. Both revive only via new-id `session_restart`.
 *
 * The EAGER resume-on-boot pass (PR-4) layers `endedReason === "daemon-restart"`
 * on TOP of this base predicate, so it never resurrects an operator kill. That
 * clause is deliberately NOT here: the lazy resume-on-prompt path treats a
 * deliberate prompt to a killed row as explicit operator intent and honours it
 * (§5). Keeping the base predicate free of the reason check is what lets PR-4
 * add the stricter gate without changing lazy behaviour.
 */
export function isResumable(desc: SessionDescriptor): boolean {
  return (
    desc.kind === "agent-cli" &&
    !!desc.adapterSlug &&
    !!desc.adapterSessionId &&
    !!desc.cwd &&
    !desc.archived
  )
}

/**
 * Cap on consecutive FAILED in-place resume attempts before a session stops
 * being auto-resumed (§5 "Cap/backoff — no resurrect-forever"). A session whose
 * adapter crashes on every resume must not be retried on every prompt forever,
 * and — because `resumeAttempts` is PERSISTED — this also bounds a launchd
 * KeepAlive daemon crash-loop: across N daemon boots the eager pass (PR-4)
 * re-attempts each broken row at most this many times TOTAL, not N×cap. Named
 * (not an inline `3`) so the lazy path, the eager pass, and the tests all agree
 * on the number.
 */
export const MAX_RESUME_ATTEMPTS = 3

/**
 * Cap-aware eligibility for in-place resume: `isResumable` (the descriptor has
 * everything the resume path needs) AND the session hasn't already burned
 * through `MAX_RESUME_ATTEMPTS` consecutive failed attempts. This is the shared
 * gate the lazy resume-on-prompt path enforces (fail loud with
 * `ResumeDisabledError` once it returns false on a resumable row) and that the
 * eager resume-on-boot pass (PR-4) reuses — the eager pass layers
 * `endedReason === "daemon-restart"` on top, exactly as it layers that clause
 * on `isResumable`. Kept separate from `isResumable` so the base
 * eligibility (kind/essentials/not-archived) and the attempt cap stay
 * independently testable.
 */
export function canResume(desc: SessionDescriptor): boolean {
  return isResumable(desc) && (desc.resumeAttempts ?? 0) < MAX_RESUME_ATTEMPTS
}

/**
 * Thrown by the lazy resume path when a resumable session has already failed to
 * resume `MAX_RESUME_ATTEMPTS` times in a row (`canResume` false on a row that
 * `isResumable`). Fail-loud and terminal: no further adapter spawn is
 * attempted, and the prompter is told to fall back to new-id `session_restart`
 * rather than re-prompting a session that will never come back in place. Carries
 * the id + attempt count so ingress layers can report a structured error.
 */
export class ResumeDisabledError extends Error {
  readonly sessionId: string
  readonly attempts: number
  constructor(sessionId: string, attempts: number) {
    super(
      `resume disabled after ${MAX_RESUME_ATTEMPTS} failed attempts — use session_restart`,
    )
    this.name = "ResumeDisabledError"
    this.sessionId = sessionId
    this.attempts = attempts
  }
}

/** Why an eager (boot-time) in-place resume of one row was skipped without
 *  ever reaching the adapter. Distinct from a `failed` outcome (the adapter WAS
 *  asked and refused / the worktree was gone): a skip is a decision made from
 *  the descriptor alone. */
export type EagerResumeSkipReason =
  /** No such session in the registry (raced a forget). */
  | "unknown"
  /** Already has a live agent session — nothing to resume (idempotent). */
  | "already-live"
  /** Fails the base `isResumable` predicate (not agent-cli / no
   *  adapterSessionId / archived / PTY / command). */
  | "not-resumable"
  /** Resumable, but didn't die from a daemon restart — the eager pass never
   *  resurrects operator kills / errored / naturally-exited rows (§5). */
  | "not-daemon-restart"
  /** Already burned through `MAX_RESUME_ATTEMPTS` — the persisted cap (§5). */
  | "cap-exhausted"
  /** `worktreeId` is pinned but the marker at `cwd` names a different
   *  generation (or is gone) — refuse to resume into the wrong worktree (§5). */
  | "worktree-generation-mismatch"

/** Why an eager in-place resume of one row failed after being attempted. */
export type EagerResumeFailReason =
  /** `cwd` no longer exists on disk (worktree GC'd/removed) — counts a resume
   *  attempt, same as a spawn that failed (§5). */
  | "cwd-missing"
  /** The adapter was asked and declined (returned null / threw — typically
   *  "session not found") or the resume hook is unwired. The row is left
   *  dead-but-lazy-resumable — the eager pass NEVER fresh-spawns (an unprompted
   *  fresh spawn burns tokens for nothing; that fallback is `session_restart`
   *  territory only). */
  | "resume-failed"

/** Outcome of a single eager (boot-time) in-place resume — the per-row result
 *  the bounded boot pass tallies into its summary. */
export type EagerResumeOutcome =
  | { status: "resumed" }
  | { status: "skipped"; reason: EagerResumeSkipReason }
  | { status: "failed"; reason: EagerResumeFailReason }

/** Find the most recently-completed `kind: "command"` session whose `cwd`
 *  matches, for stamping `priorCommandSessionId` on a freshly spawned
 *  agent-cli/PTY session in the same workspace. Scans the in-memory
 *  registry (not the filesystem) — that's the same source of truth
 *  `command_list`/`session_list({kind:"command"})` themselves read from,
 *  including sessions restored from sessions.json at boot. A pure map
 *  scan over what's typically a handful of entries; no I/O, so nothing to
 *  fail here the way a filesystem lookup could. */
function findPriorCommandSessionId(
  liveSessions: Map<string, SessionRuntime>,
  cwd: string,
): string | undefined {
  let best: SessionRuntime | undefined
  for (const rt of liveSessions.values()) {
    if (rt.desc.kind !== "command" || rt.desc.cwd !== cwd) continue
    const bestTs = best ? (best.desc.endedAt ?? best.desc.startedAt) : undefined
    const candidateTs = rt.desc.endedAt ?? rt.desc.startedAt
    if (!best || candidateTs > bestTs!) best = rt
  }
  return best?.desc.id
}

/**
 * The route-identity a session is currently pinned to, for the model↔route
 * guard (SPEC risk R2 / §4.4). Prefers the explicit `route` axis echo when the
 * session recorded one; otherwise derives it from the current model ref's
 * `@route` (which defaults to the vendor for a direct ref — `anthropic/claude…`
 * ⇒ route `anthropic`). `undefined` when neither is known (a bare/legacy model
 * id with no route axis), which the guard treats as "route unknown → don't
 * block" so it never refuses a same-endpoint switch on incomplete information.
 */
function currentRouteOf(desc: SessionDescriptor): string | undefined {
  if (desc.route?.gateway) return desc.route.gateway
  if (desc.model) return tryParseModelRef(desc.model)?.route
  return undefined
}

/** Spread-ready worktree identity for a spawn path's `cwd` — see
 *  `SessionDescriptor.worktreePath`. Returns `{}` (not `{worktreePath:
 *  undefined}`) for the common case of a cwd outside any worktree, so the
 *  descriptor keeps the keys absent rather than persisting nulls into
 *  sessions.json. */
function worktreeFields(
  cwd: string,
): Pick<SessionDescriptor, "worktreePath" | "worktreeId"> {
  const identity = resolveWorktreeIdentity(cwd)
  if (!identity) return {}
  return identity.worktreeId === undefined
    ? { worktreePath: identity.worktreePath }
    : { worktreePath: identity.worktreePath, worktreeId: identity.worktreeId }
}

/** Strip CSI / SGR ANSI sequences so resume-pattern matching works
 *  on dim/coloured output. Liberal regex covering most cases — we
 *  don't need byte-perfect parsing here. */
function stripAnsiCodes(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
}

/** Lines the ring buffer itself injects (turn separators, [tool] /
 *  [thought] / [awaiting input] markers) — never real transcript content,
 *  so the heuristic below skips them when looking for a trailing question. */
const SYNTHETIC_LINE = /^(?:──|\[)/

const OPTION_LINE_PATTERN = /^(?:[-*•]|\d+[.)]|[a-zA-Z][.)])\s+(.+)$/

/** Best-effort fallback for drivers that never report a structured
 *  "agent-prompt" (i.e. every currently-supported adapter — none emits
 *  ACP's `requestPermission` as a surfaced clarifying question today, they
 *  auto-answer it). A clarifying question's shape in a transcript is the
 *  question line followed by its enumerated options ("1. yes", "- retry",
 *  "a) skip", ...), so this scans backwards from the end of the transcript
 *  collecting a trailing run of option-shaped lines, then checks whether
 *  the line just before that run ends in "?". Always tagged
 *  `source: "heuristic"` so callers know this is a guess, not an
 *  authoritative signal. */
function deriveHeuristicQuestion(
  recentLines: string[],
): SessionAwaitingQuestion | undefined {
  const visible = recentLines
    .map(stripAnsiCodes)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !SYNTHETIC_LINE.test(l))
  if (visible.length === 0) return undefined

  const options: string[] = []
  let i = visible.length - 1
  while (i >= 0 && options.length < 6) {
    const m = OPTION_LINE_PATTERN.exec(visible[i]!)
    if (!m) break
    options.unshift(m[1]!.trim())
    i--
  }
  if (i < 0) return undefined
  const candidate = visible[i]!
  if (!candidate.endsWith("?")) return undefined
  return { text: candidate, ...(options.length > 0 ? { options } : {}), source: "heuristic" }
}

/**
 * A `session/request_permission` request parked by a permission-hold session,
 * awaiting a human/orchestrator decision through the cross-session inbox
 * (`permissions_list` / `permissions_respond`, `GET /permissions` /
 * `POST /permissions/:id`, `agentproto permissions ls|approve|deny`).
 */
export interface PendingPermission {
  /** Stable id — the driver's own request id, unique across sessions. Pass to
   *  `respondPermission`. */
  id: string
  sessionId: string
  /** ACP tool-call id the request was raised for (== `id` today; kept distinct
   *  so a future driver can surface a separate correlation id). */
  toolCallId: string
  /** Tool title/kind the agent is asking permission for, when known. */
  toolName?: string
  /** Human-readable "Allow X?" line. */
  text: string
  /** Options the agent offered (ACP `requestPermission` shape). */
  options: Array<{ optionId: string; name?: string; kind?: string }>
  /** ISO timestamp the request was parked. */
  requestedAt: string
  /**
   * The tool call's raw input (e.g. a Bash tool's command string), carried
   * through from the ACP `agent-prompt` event's `rawInput` field when the
   * driver supplied one. Harness-shaped and untyped — don't assume a stable
   * schema across adapters.
   */
  rawInput?: unknown
}

/** How a caller resolves a pending permission — an explicit `optionId` wins
 *  over the `decision`→option mapping (approve → an allow-flavored option,
 *  deny → a reject-flavored option). `scope: "always"` prefers an
 *  allow-always option when the request offers one. */
export interface PermissionRespondInput {
  decision: "approve" | "deny"
  optionId?: string
  scope?: "once" | "always"
}

export type PermissionRespondResult =
  | { ok: true; permission: PendingPermission; decision: "approve" | "deny"; optionId?: string }
  | {
      ok: false
      error: "not_found" | "session_gone" | "no_matching_option" | "unsupported"
      message: string
    }

export interface SessionsRegistry {
  spawn(input: SpawnSessionInput): SessionDescriptor
  /** Adopt a ChildProcess that was spawned outside the registry —
   *  e.g. by the tunnel server when the host dispatches a spawn
   *  frame. The registry attaches its stdout/stderr listeners and
   *  tracks the descriptor so the child shows up in /sessions and
   *  the LocalDaemonSessionsCard. The caller keeps lifecycle
   *  ownership (kill / wait); this is purely for observability.
   *  Returns the descriptor for the registered session. */
  register(input: RegisterSessionInput): SessionDescriptor
  /** Register an already-built agent session (caller resolves the
   *  adapter + builds the runtime). Sets kind="agent-cli", consumes
   *  the optional initial prompt synchronously, returns the
   *  descriptor. The agent stays alive — call `sendPrompt(id, ...)`
   *  for follow-up turns until `kill(id)` closes it. */
  spawnAgent(input: SpawnAgentInput): SessionDescriptor
  /** Spawn a process under a real PTY (node-pty). Bytes flow through
   *  the registry's byte ring buffer + emitter; attach with
   *  `attachPty(id, ...)`. Throws when the registry was constructed
   *  without a `spawnPty` factory (node-pty optional dep missing). */
  spawnPty(input: SpawnPtyInput): SessionDescriptor
  /** Register a COMPLETED `command_execute` (or cron `kind:"command"`
   *  action) invocation as its own `kind: "command"` session. Unlike
   *  `spawn`/`spawnAgent`/`spawnPty`, there's no live process to track —
   *  the command already ran to completion via `runCommand` before this
   *  is called — so the descriptor is minted already "finished"
   *  (status exited/error, startedAt backdated by `durationMs`,
   *  endedAt now) and its full result is written to that session's own
   *  `events.jsonl` (see command-log.ts), the same per-id path an
   *  agent-cli session's structured transcript uses. Synchronous: the
   *  descriptor (and its id) is available immediately, the JSONL write
   *  itself is fire-and-forget internally. */
  recordCommand(input: RecordCommandInput): SessionDescriptor
  /** Record a successfully-created pull request against an existing session.
   * Idempotent for the same adapter + URL, which makes a retry after a
   * response-loss safe without duplicating provenance. Returns undefined
   * when the session was removed before the result could be recorded. */
  recordOpenedPr(
    sessionId: string,
    input: RecordOpenedPrInput,
  ): SessionDescriptor | undefined
  /** Read back a `kind:"command"` session's full logged result (the
   *  `CommandLogEntry` `recordCommand` wrote). Resolves to null when the
   *  session isn't a command session or has no recorded entry. Routed
   *  through the registry (rather than callers importing
   *  `readCommandLogEntry` directly) so the read always targets the same
   *  base directory `recordCommand` wrote to — that dir is test-overridable
   *  (`transcriptDir`) and callers outside sessions.ts have no other way
   *  to know it. */
  readCommandLog(sessionId: string): Promise<import("./command-log.js").CommandLogEntry | null>
  /** Read back every normalized `ToolCallRecord` a session has logged —
   *  the unified entries `tool_calls_list` reads. Works for a
   *  `kind:"command"` session (recordCommand writes exactly one) and for a
   *  `kind:"agent-cli"` session (transcript-writer writes one per finished
   *  tool call). Routed through the registry for the same base-directory
   *  reason as `readCommandLog`. Returns `[]` rather than throwing when the
   *  session has none. */
  readToolCallRecords(sessionId: string): Promise<ToolCallRecord[]>
  /** Read back every durable `usage_snapshot` a session has logged, in
   *  on-disk order — the cumulative per-turn/exit snapshots the usage-rollup
   *  surface aggregates. Routed through the registry for the same
   *  base-directory reason as `readToolCallRecords`. Returns `[]` rather than
   *  throwing when the session has none. */
  readUsageSnapshots(
    sessionId: string,
  ): Promise<import("./usage-rollup.js").UsageSnapshotRecord[]>
  /** Register an already-running browser service adapter as a tracked
   *  session (kind="browser"). Idempotent by identity — each call
   *  mints a fresh session id. The `stop` callback is invoked by
   *  `kill()` best-effort. */
  registerBrowser(input: RegisterBrowserInput): SessionDescriptor
  /** Send a follow-up turn to a live agent session and AWAIT it. Throws
   *  when the session is missing, not an agent-cli kind, dead (exited/
   *  killed/error and unresumable — `SessionNotAliveError`), or busy
   *  (mid-turn). The events stream into the existing ring buffer +
   *  line emitter so /stream consumers see them as they arrive.
   *
   *  `opts.interrupt` behaves exactly as it does on `enqueuePrompt`:
   *  a mid-turn session has its in-flight turn cancelled and settled
   *  before admission, so this prompt redirects the SAME live session
   *  instead of hitting the busy rejection. Ignored (identical to the
   *  default) when the session is idle. Omitted or `false` reproduces
   *  the previous mid-turn rejection byte-for-byte. */
  sendPrompt(
    id: string,
    message: unknown,
    opts?: { interrupt?: boolean }
  ): Promise<void>
  /** Fire-and-forget variant of `sendPrompt` for the TURN ITSELF only.
   *  Admission (resume attempt + the missing/wrong-kind/dead/busy
   *  checks `sendPrompt` throws) is AWAITED before this resolves, so a
   *  dead or busy session rejects instead of silently reporting
   *  success — only resolves once the turn has actually started.
   *  Errors during the turn's own execution (network drop, child died
   *  mid-turn) are pushed into the ring buffer as `[error]` lines so
   *  `/stream` subscribers see them. Used by the web UI's chat input
   *  and MCP `agent_prompt`, where a long turn would otherwise freeze
   *  the caller.
   *
   *  `opts.interrupt` lets a caller redirect a mid-turn session instead
   *  of hitting the busy rejection: the in-flight turn is cancelled
   *  (`agentSession.cancel()`), admission waits for that turn to
   *  actually settle (busy flips false — no fixed sleep), then the new
   *  prompt is admitted + fired on the SAME live session. Ignored
   *  (identical to the default) when the session is idle. Omitted or
   *  `false` reproduces today's mid-turn rejection byte-for-byte. */
  enqueuePrompt(
    id: string,
    message: unknown,
    opts?: { interrupt?: boolean }
  ): Promise<void>
  /** Eagerly resume ONE dead-but-resumable agent-cli session IN PLACE,
   *  WITHOUT a prompt — the boot-time counterpart to the lazy resume that
   *  `sendPrompt`/`enqueuePrompt` trigger on the first prompt after a restart
   *  (session-survivability plan §5, PR-4). Routes through the exact same
   *  `maybeResumeAgent` code path as the lazy trigger, so #634's billing-auth
   *  re-resolution, #635's `session:resumed` event + interrupted banner, and
   *  #636's persisted attempt cap all apply for free.
   *
   *  Eager-eligibility is stricter than the lazy path: on top of `isResumable`
   *  it requires `endedReason === "daemon-restart"` (idle-or-mid-turn killed by
   *  a restart — never an operator kill, natural exit, error, or archive) and
   *  `canResume` (under the attempt cap). It adds the two eager-only pre-flights
   *  the lazy path deliberately skips: `cwd`-exists-on-disk (a missing worktree
   *  fails clean and COUNTS an attempt) and worktree-generation match (a marker
   *  mismatch skips without an attempt). It NEVER fresh-spawns — an adapter that
   *  rejects the id leaves the row dead-but-lazy-resumable, reported as
   *  `failed:"resume-failed"`, rather than minting a new session (that fallback
   *  is `session_restart`'s alone). Idempotent + no-throw: an already-live,
   *  ineligible, or cap-exhausted row returns a `skipped` outcome without
   *  touching the adapter, so the bounded boot pass can call it per row and
   *  tally the results. */
  resumeOnBoot(id: string): Promise<EagerResumeOutcome>
  /** Cancel the in-flight turn on a live agent-cli session and leave the
   *  session itself alive and idle — the bare "interrupt, no next prompt"
   *  primitive `sendPrompt`/`enqueuePrompt`'s `opts.interrupt` arm lacks
   *  on its own, since that arm always exists to redirect onto a NEW
   *  prompt. Reuses the same `interruptInFlightTurn` helper those two
   *  share.
   *
   *  Idempotent by design: idle, unknown-alive (starting/running only —
   *  same liveness `validateAgentTurn` checks), or already-terminal
   *  (exited/killed/error) all resolve `{ wasBusy: false }` rather than
   *  throwing — a no-op interrupt is not an error. Throws only when the
   *  id is unknown, or when `cancel()` itself rejects ("does not support
   *  interrupt", propagated from `interruptInFlightTurn`). */
  interruptSession(id: string): Promise<{ wasBusy: boolean }>
  /**
   * Switch the model on a LIVE agent-cli session without restarting it —
   * the mid-session counterpart to `spawnAgent`'s `input.model` (which
   * only applies at spawn time). Delegates to the driver session's own
   * `setModel` (see `AgentSessionLike.setModel`), which dispatches on the
   * adapter's `models.apply` strategy (`config`/`command`/`arg`) and never
   * throws on a rejected switch.
   *
   * On `{applied:true}`, updates `SessionDescriptor.model` so
   * `session_list`/SSE reflect the switch and emits a
   * `session:config-changed {axis:"model"}` event on the session event bus
   * (plus a back-compat `session:model-changed` alias). On `{applied:false}`
   * the descriptor and event bus are untouched — nothing changed, so nothing
   * to announce.
   *
   * Throws (not a structured result) for the two "this request doesn't
   * even make sense" cases: an unknown session id, or a session that
   * isn't an agent-cli kind (or whose driver session predates `setModel`
   * entirely) — both are caller errors, not an adapter's refusal.
   */
  setModel(id: string, modelId: string): Promise<SetSessionModelResult>
  /**
   * Announce a single `SessionConfig` axis change on the session event bus
   * (SPEC step 6). `setModel` emits its `session:config-changed` event inline,
   * but restart-with-override (`restartAgentSession`, session-restart-core.ts)
   * lives OUTSIDE the registry — it re-resolves auth and re-spawns a fresh
   * session — so it announces each changed axis (access/route/posture/…) of the
   * new session through this one method rather than reaching into the private
   * event bus. No-op when the registry was constructed without a `sessionEvents`
   * bus (the emit is best-effort observability, never load-bearing). The caller
   * builds the fully-typed event (axis + value already reflected on the new
   * descriptor); the registry only forwards it. */
  emitConfigChanged(ev: SessionConfigChangedEvent): void
  /**
   * Switch the reasoning/compute budget (effort) on a LIVE agent-cli session
   * without restarting it — the live-effort verb (SPEC §4.2, build step 5),
   * `POST /sessions/:id/effort` + `agent_set_effort`. Delegates to the driver
   * session's `setEffort` (ACP `set_config_option(configId:"effort")`); effort
   * is model-dependent (SPEC §3.9), so a label the current model rejects is a
   * soft `{applied:false, reason}` (SPEC risk R7), never thrown.
   *
   * On `{applied:true}` updates `SessionDescriptor.effort` and emits
   * `session:config-changed {axis:"effort"}`; on `{applied:false}` the
   * descriptor and bus are untouched. Throws (caller error, not an adapter
   * refusal) for an unknown session id or a non-agent-cli session — same
   * contract as `setModel`.
   */
  setEffort(id: string, effort: string): Promise<SetSessionEffortResult>
  /**
   * Switch the posture on a LIVE agent-cli session (SPEC §4.2, build step 5),
   * `POST /sessions/:id/posture` + `agent_set_posture`. When the requested
   * posture maps to a NATIVE advertised harness mode (`resolvePosture` →
   * `native`), it's switched live via the driver's `setSessionMode`
   * (`applied:true`, descriptor + `session:config-changed {axis:"posture"}`
   * emitted). When there is NO native mode (prompt-injected / env-applied /
   * a raw mode the session no longer advertises), it is NOT forced live — it
   * resolves `{applied:false, reason:"requires-restart"}` so the caller routes
   * it through restart-with-override (step 6, not implemented here). Throws for
   * an unknown session id or a non-agent-cli session, same as `setModel`.
   */
  setPosture(id: string, posture: Posture): Promise<SetSessionPostureResult>
  /** Stamp `lastActivityAt` on a live agent-cli session's descriptor
   *  and schedule a debounced persist. Called from the `onActivity`
   *  callback threaded down through the driver → ACP client, which
   *  fires on ANY adapter-process traffic (not just ring-buffer
   *  output) — see `SessionDescriptor.lastActivityAt`. No-op when the
   *  id is unknown (session already forgotten). */
  pulseActivity(id: string): void
  /** Every non-archived session, newest `startedAt` first — the daemon's
   *  canonical lister (`session_list`, `GET /sessions`, panels, subtree
   *  scoping). Archived sessions are excluded UNLESS `includeArchived` is
   *  true — the default keeps a housekeeping flag from becoming a second,
   *  silent filter every caller has to know about, while
   *  `{ includeArchived: true }` is there for `session_list`'s own opt-in
   *  and for any subtree/authorization computation (`collectSubtree`) that
   *  needs the FULL parent→child graph to stay connected — a subtree BFS
   *  fed the filtered list would silently orphan the non-archived
   *  descendants of an archived ancestor, since each edge is keyed off the
   *  CHILD's own record. `get()`/`findByIdOrName()` are unaffected by this
   *  flag entirely — a transcript stays directly openable by id no matter
   *  how it's archived. */
  list(opts?: { includeArchived?: boolean }): SessionDescriptor[]
  get(id: string): SessionDescriptor | undefined
  /** Archive a TERMINAL-status session (exited/killed/error) — sets
   *  `archived: true` and persists. Pure housekeeping: hides the row from
   *  `list()`'s default view, nothing else. Refuses (throws) a still-alive
   *  session (running/starting) — archiving one would hide it from the
   *  daemon's own default view while it keeps working unattended, which is
   *  a worse foot-gun than the flag is trying to solve. Idempotent: already
   *  archived is a no-op success. Throws when the id is unknown. */
  archiveSession(id: string): SessionDescriptor
  /** Unarchive — the inverse, no status guard (an archived session was
   *  terminal when archived, and archiving never touched daemon state, so
   *  there is nothing to re-validate). Throws only when the id is
   *  unknown. */
  unarchiveSession(id: string): SessionDescriptor
  /** Bulk garbage-collect terminal-status sessions: archive (default,
   *  reversible) or `forget` (drop the descriptor to reclaim sessions.json
   *  space — the native conversation on disk survives + stays importable).
   *  Never touches a live session. `olderThanDays` keeps more-recent ones;
   *  `onlyIds` scopes to an allowlist (an orchestrator subtree). Returns the
   *  affected ids. */
  gcSessions(opts: {
    olderThanDays?: number
    forget?: boolean
    onlyIds?: ReadonlySet<string>
  }): { mode: "archived" | "forgotten"; ids: string[]; count: number }
  /** Set or clear a session's user-facing name (`PATCH /sessions/:id`, the
   *  `session_rename` MCP verb). Each of `title`/`label`: a non-empty string
   *  sets that field (trimmed, capped to the derivation's `MAX_LENGTH` by
   *  code point); an empty/whitespace-only string or `null` CLEARS it (the
   *  UI reverts to the derived title / friendly fallback); `undefined`
   *  leaves it untouched. Persists via the same `schedulePersist` every
   *  descriptor mutation uses, and emits `session:renamed` so live UIs
   *  repaint. Pure display state — never touches the live agent. Throws when
   *  the id is unknown. */
  renameSession(
    id: string,
    patch: { title?: string | null; label?: string | null },
  ): SessionDescriptor
  /** Subscribe to a session's output. Returns an unsubscribe fn.
   *  Initial backfill: synchronously invokes `onLine` once for each
   *  line currently in the ring buffer so attaches show context. */
  attach(
    id: string,
    onLine: (line: string, stream: "stdout" | "stderr") => void
  ): (() => void) | null
  /** Subscribe to a session's structured events.jsonl records as they're
   *  written — the live-push half of `GET /sessions/:id/events/stream`'s
   *  replay-then-subscribe handoff. Thin passthrough to the transcript
   *  writer's own `subscribe` (see transcript-writer.ts for the exactly-
   *  once contract this enables); no backfill, no existence check — a
   *  session id with no writer state simply never calls back. Returns an
   *  unsubscribe fn. */
  subscribeToRecords(
    id: string,
    onRecord: (record: Record<string, unknown>) => void
  ): () => void
  /** Subscribe to a PTY session's byte stream. Returns a control
   *  handle (write/resize/detach) and null when the session is
   *  missing or not a PTY kind. Replays the ring buffer
   *  synchronously before live frames start. Initial `cols`/`rows`
   *  are required so the registry can compute min-size across
   *  subscribers; recompute on every `resize` call. */
  attachPty(
    id: string,
    initial: { cols: number; rows: number },
    onData: (chunk: Buffer) => void,
    onExit: (event: { exitCode: number; signal?: number }) => void
  ): {
    write(data: string): void
    resize(cols: number, rows: number): void
    detach(): void
  } | null
  /** Find a session by exact id OR exact name match. Returns the
   *  descriptor or undefined. Used by HTTP/MCP routes so callers
   *  can refer to "claude-main" instead of "sess_a3f8c1b2". */
  findByIdOrName(query: string): SessionDescriptor | undefined
  /** Write a chunk of text to a PTY session's stdin. Returns true
   *  on success, false when the session is missing or not a PTY.
   *  Single-shot variant of attachPty().write — useful for MCP
   *  tools that drive a session through tool calls. */
  writeTerminalInput(id: string, data: string): boolean
  /** Snapshot the recent PTY byte buffer as one Buffer. Newest
   *  bytes at the end; `lastBytes` caps the returned size from the
   *  tail. Returns null when the session is missing or not a PTY. */
  readTerminalOutput(id: string, lastBytes?: number): Buffer | null
  kill(id: string, signal?: NodeJS.Signals): boolean
  /** Retire a long-idle agent-cli session to free its adapter process — the
   *  primitive the idle-session reaper (`runIdleReapPass`, PR-6) drives on a
   *  periodic sweep. Terminates the underlying adapter/child the SAME graceful
   *  way `kill()` does (agentSession.close() + SIGTERM), flips the row to
   *  `killed` with `endedReason: "idle-reaped"`, and — unlike `kill()`, which
   *  leaves the closed binding referenced — CLEARS the in-memory agentSession
   *  binding so the row is immediately lazy-resumable: a later prompt revives
   *  it in place through `maybeResumeAgent` (adapterSessionId/cwd are left
   *  intact). Emits `session:reaped` (naming the reaper) alongside the usual
   *  `session:exited` (carrying `reason: "idle-reaped"`). The row and its
   *  transcript are NOT deleted.
   *
   *  Purely mechanical: the caller (the sweep) owns the idle/threshold/
   *  never-reap policy. This method only guards the two invariants a reap must
   *  never violate — it refuses (returns false, no-op) a session that is not a
   *  live (`running`) agent-cli row (so a PTY/command/terminal or an
   *  already-terminal row is never touched). `idleMs` is stamped onto the
   *  emitted `session:reaped` event for observability. Returns true iff a row
   *  was actually reaped. */
  reapIdle(id: string, idleMs?: number): boolean
  /** List permission requests currently parked in the pending-permissions
   *  inbox across all permission-hold sessions, newest last. Optionally
   *  filtered to one session. */
  listPendingPermissions(filter?: { sessionId?: string }): PendingPermission[]
  /** Resolve a parked permission by id — maps the decision (or explicit
   *  optionId) to one of the offered options, resolves the held driver RPC,
   *  clears the session's awaiting-permission state, and emits
   *  `session:permission-resolved`. */
  respondPermission(
    id: string,
    input: PermissionRespondInput,
  ): Promise<PermissionRespondResult>
  /** Stop tracking a session (after it exited and the user clicked
   *  "clear"). Doesn't kill — use `kill` first. */
  forget(id: string): boolean
  /** Stop persisting + close all sessions. Killed children are not
   *  awaited — the daemon shutdown loop handles process tree teardown. */
  shutdown(): void
}

export interface RegisterBrowserInput {
  /** Adapter id (e.g. "camofox", "bureau", "chromium"). */
  adapterId: string
  /** Port the browser service listens on. */
  port: number
  /** Base URL of the browser service (e.g. "http://127.0.0.1:9377"). */
  baseUrl: string
  /** Execution location — "local" (default) or "cloud". Included in the
   *  dedup key so a cloud call never returns a pre-existing local session. */
  location?: "local" | "cloud"
  /** PID of the service process — undefined when managed by launchd/systemd. */
  pid?: number
  /** True when the service was already healthy before this call (idempotent start). */
  wasAlreadyRunning: boolean
  /** Initial lifecycle status. "running" when the service is confirmed
   *  healthy; "starting" when a non-blocking cold start returned before the
   *  service finished converging (health-wait continues in the background and
   *  `browser_status` / `list_browsers` flip it to running once up).
   *  Defaults to "running" when omitted. */
  status?: Extract<SessionStatus, "running" | "starting">
  /** Async shutdown callback — called by kill() best-effort. */
  stop: () => Promise<void>
  label?: string
}

export interface RegisterSessionInput {
  /** Pre-existing child process to adopt (e.g. from a tunnel spawn). */
  child: ChildProcess
  /** Stable id — typically the tunnel's execId so callers cross-ref. */
  id: string
  workspaceSlug: string
  /** Display label for the descriptor's `command` field. */
  command: string
  kind?: SessionKind
  label?: string
}

export interface SpawnAgentInput {
  workspaceSlug: string
  cwd: string
  /** Optional pre-set id — lets the spawner (session-spawn.ts) mint the
   *  id BEFORE `agentSession` is started, so it can be baked into the
   *  child's own `mcpServers` callback URL as `callerSessionId` (PR 7 /
   *  Gap 7 provenance) — the id has to exist before the child's static
   *  MCP config is written, which is before `spawnAgent` itself returns
   *  one. Same pattern as `SpawnSessionInput.id`. Omit to generate one
   *  here, as before. */
  id?: string
  /** Driver-built session ready to receive turns. Caller resolves
   *  the adapter, calls createAgentCliRuntime(handle).start({cwd}),
   *  and hands the result here. */
  agentSession: AgentSessionLike
  /** Adapter slug for the descriptor (display only). */
  adapterSlug: string
  /** Canonical harness slug — recorded on the descriptor; defaults to adapterSlug. */
  harness?: string
  /** Optional initial prompt to dispatch immediately. The promise
   *  the registry returns resolves AFTER the spawn — the prompt
   *  runs in the background, projecting events into the ring
   *  buffer. Skip to spawn idle. */
  initialPrompt?: string
  label?: string
  /** Title to stamp on the descriptor up-front, BEFORE the `initialPrompt`
   *  turn runs. Set by the spawn path from the CALLER's ask (`input.prompt`),
   *  so the self-heal in `runAgentTurn` never derives a title from the
   *  role-prefixed COMPOSED prompt it dispatches as the first turn. */
  title?: string
  /** Pretty command for the descriptor (display only). */
  commandPreview?: string
  /** MCP servers mounted at spawn time. Persisted on the descriptor so
   *  the resume/re-spawn path can re-mount the same toolset (orchestrator
   *  WP1). */
  mcpServers?: AcpMcpServer[]
  /** Spawning orchestrator's session id — set when the spawn arrived
   *  through the scoped sub-gateway (orchestrator WP4). Recorded on the
   *  descriptor for subtree scoping + quota accounting. */
  parentSessionId?: string
  /** Source label for the new session (channel/harness). */
  origin?: string
  /** Recursion depth for the new session (orchestrator WP4). Defaults to
   *  0 when omitted (direct/root spawn). */
  depth?: number
  /** Free-form spawn-time hints, recorded verbatim onto
   *  {@link SessionDescriptor.meta} (e.g. `agent_start.boardId` →
   *  `meta.boardId`). See that field's doc for the contract. */
  meta?: Record<string, string>
  /** Requested model id — recorded on the descriptor for display + echo. */
  model?: string
  /** AIP-45 mode the session was spawned with — recorded onto
   *  {@link SessionDescriptor.mode}. See that field's doc for why a client
   *  needs it (mode-mismatch detection for mid-session model switching). */
  mode?: string
  /** Resolved auth echo (mode + fingerprint + provider/source/setEnv) —
   *  recorded verbatim onto {@link SessionDescriptor.auth}. See that field's
   *  doc for the full contract; the caller (`session-spawn.ts`) computes this
   *  via the billing-auth resolver, never passing the raw credential here. */
  auth?: SessionAuthEcho
  /** Decomposed config-axis echoes (SPEC §3.7) — recorded verbatim onto the
   *  matching {@link SessionDescriptor} fields, the same optional-spread way
   *  `model`/`mode`/`auth` are. All optional; a caller that resolved an axis
   *  passes its echo so the descriptor round-trips it and the picker re-opens
   *  on it. See each descriptor field's doc for the axis contract. */
  effort?: EffortLevel
  posture?: Posture
  route?: RouteSpec
  contextProfile?: ContextProfile
  /** Named auth-profile echo for the `access` axis (SPEC §3.6). Non-secret —
   *  see {@link SessionAccessProfileEcho}. */
  accessProfile?: SessionAccessProfileEcho
  /** Prior session id this spawn continues from — set by `restartAgentSession`
   *  (session-restart-core.ts) when this is a restart, recorded verbatim onto
   *  {@link SessionDescriptor.resumedFrom}. Absent for a direct (non-restart)
   *  spawn. */
  resumedFrom?: string
  /** Human-readable resume path, recorded onto {@link SessionDescriptor.resumeVia}.
   *  Threaded through alongside `resumedFrom` — see that field's doc. */
  resumeVia?: string
  /** Hard ceiling on cumulative session cost (USD). When set and the
   *  adapter's usage reader reports a higher cost at a turn-end, the session
   *  is stopped (best-effort, turn-granular — caps continuation, can't abort
   *  a turn mid-flight). */
  maxCostUsd?: number
  /** Windowed cost-budget cap (phase 4). Stored on the runtime for read-back;
   *  the spawn layer auto-attaches a governance policy that enforces it. Never
   *  kills the session — see {@link SessionRuntime.costBudget}. */
  costBudget?: CostBudget
  /** Best-effort usage reader, called on each turn-end to refresh the
   *  cost/token fields on the descriptor. Adapter-specific (e.g. hermes
   *  reads its state.db keyed by the adapter session id). Omit for adapters
   *  with no usage source. */
  readUsage?: () => Promise<{ costUsd?: number; tokensIn?: number; tokensOut?: number } | null>
  /** Opt this session into Langfuse tracing (prompt/completion + tool spans +
   *  tokens/cost). Effective opt-in is `trace ?? opts.langfuseTracingDefault ?? false`. */
  trace?: boolean
  /** True when `agentSession` is a `SandboxAgentSessionProxy` (`agent_start.sandbox`)
   *  rather than a local subprocess-backed session — stamped onto the descriptor
   *  as `remote` since there's no local PID to report. */
  remote?: boolean
  /** Provider-assigned sandbox id, when `remote` is true. */
  sandboxId?: string
  /** What session close does to the box, when `remote` is true — see
   *  `SessionDescriptor.sandboxTeardown`. */
  sandboxTeardown?: "kill" | "pause"
  /** True when the driver session was started in permission-hold mode
   *  (`AgentCliStartOptions.permissionHold`) — its `agent-prompt` events carry
   *  respondable permission requests. Gates whether the registry registers
   *  them in the pending-permissions inbox. Default false. */
  permissionHold?: boolean
}

export interface SpawnSessionInput {
  kind: SessionKind
  workspaceSlug: string
  /** Path of the workspace root (for the child's cwd). The registry
   *  doesn't validate it against the workspaces config — caller has
   *  already resolved this. */
  cwd: string
  /** Argv. First element is the binary; rest are passed verbatim. */
  argv: string[]
  /** Extra env on top of the daemon's process.env. */
  env?: Record<string, string>
  /** Optional pre-set id (lets the spawner reference the session
   *  before the spawn returns — useful for telemetry). */
  id?: string
  label?: string
  /** Keep the child's stdin open (default: closed). Most spawned
   *  agents are non-interactive and emit a warning when stdin is a
   *  pipe with no writer (claude-code prints "no stdin data
   *  received in 3s, proceeding without it"). Closing stdin lets
   *  them skip the wait. PTY/terminal kinds that genuinely need
   *  bidirectional IO should opt in via `keepStdin: true` and the
   *  caller is then responsible for writing to `child.stdin`. */
  keepStdin?: boolean
}

export interface SpawnPtyInput {
  workspaceSlug: string
  cwd: string
  argv: string[]
  /** Initial PTY dimensions. The registry uses min(cols, rows) across
   *  active subscribers thereafter — these are the seed values used
   *  before anyone attaches. */
  cols: number
  rows: number
  /** Extra env on top of process.env. TERM/LANG/PATH are forced by
   *  the factory layer (node-pty.spawn options); don't try to clear
   *  them here. */
  env?: Record<string, string>
  /** User-friendly slug. Used by `findByIdOrName(query)`. Must not
   *  collide with an existing session's name. */
  name?: string
  label?: string
  /** Parent attribution + depth — same semantics as `SpawnAgentInput`
   *  (orchestrator WP4): set when the spawn came through a scoped
   *  sub-gateway so `session_tree` shows the PTY under its spawner. */
  parentSessionId?: string
  /** Source label for the new session (channel/harness). */
  origin?: string
  depth?: number
  /** Restart lineage — same semantics as `SpawnAgentInput.resumedFrom` /
   *  `resumeVia`, recorded onto {@link SessionDescriptor.resumedFrom} /
   *  {@link SessionDescriptor.resumeVia}. Set by `session_restart` for the
   *  pty-native/pty-plain branches (session-tools.ts). */
  resumedFrom?: string
  resumeVia?: string
}

export interface RecordCommandInput {
  workspaceSlug: string
  /** Working directory the command actually ran in (post cwd-anchoring).
   *  Matched against a fresh session's cwd by `findPriorCommandSessionId`. */
  cwd: string
  command: string
  args: string[]
  /** Fields mirror `command-tools.ts`'s `ExecuteResult` — kept inline here
   *  (rather than importing that type) so sessions.ts has no dependency
   *  on command-tools.ts. */
  exitCode: number
  signal: string | null
  durationMs: number
  stdout: string
  stderr: string
  truncated?: boolean
  label?: string
  /** Source label for this command session — same semantics as
   *  `SpawnAgentInput.origin`/`SpawnPtyInput.origin`. Callers should always
   *  pass a concrete value (`command_execute` defaults to
   *  "command_execute" when its caller didn't supply one) so a command
   *  session is never left unlabeled. */
  origin?: string
  /** Id of the session that invoked this one, when the caller genuinely
   *  knows it — see `SessionDescriptor.callerSessionId`. */
  callerSessionId?: string
}

/** A pull request that a session successfully opened through a code-host
 * driver. `openedAt` is assigned by the registry so callers cannot claim a
 * different timeline. */
export interface OpenedPullRequest {
  adapter: string
  number: number
  url: string
  openedAt: string
}

export interface RecordOpenedPrInput {
  adapter: string
  number: number
  url: string
}

/**
 * Hook the registry uses to rebuild a dead agent session on demand.
 * Invoked when a prompt arrives for an agent-cli session whose
 * `agentSession` was lost (typically daemon restart). Returns a fresh
 * `AgentSessionLike` bound to the same upstream conversation via
 * `resumeSessionId`, OR null if resume isn't possible (adapter gone,
 * upstream rejected). When null, the prompt path surfaces the same
 * "not an agent session" error as before — caller knows the row is a
 * ghost.
 *
 * The CLI wires this into the registry by passing in a closure that
 * calls `resolveAgentAdapter(slug)?.startSession({cwd, resumeSessionId})`,
 * which is the same path the gateway's POST /sessions/agent uses.
 */
export type AgentSessionResumer = (input: {
  adapterSlug: string
  cwd: string
  resumeSessionId: string
  /** The full prior descriptor of the row being resumed. Threaded so the
   *  hook can re-resolve billing-auth (mode from `descriptor.auth.mode`,
   *  named profile from `descriptor.accessProfile`, model/route from the
   *  descriptor) exactly as a fresh spawn / `session_restart` does — never
   *  inheriting the daemon's ambient env (the lazy-resume "money bug"). */
  descriptor: SessionDescriptor
  /** MCP servers to re-mount on the resumed session — threaded from the
   *  descriptor's persisted `mcpServers` so the re-spawned agent keeps the
   *  same host-chosen toolset it had on the initial spawn (orchestrator
   *  WP1). Omitted for legacy rows spawned before this was persisted. */
  mcpServers?: AcpMcpServer[]
  /** Forwarded to the re-spawned adapter's `startSession({ onActivity })`
   *  so the resumed session keeps pulsing `lastActivityAt` the same way
   *  the original spawn did. */
  onActivity?: () => void
}) => Promise<AgentSessionLike | null>

export function createSessionsRegistry(opts?: {
  /** Override the persistence path — tests pin a tmpdir.
   *
   *  Setting this also opts OUT of per-workspace partitioning: it names
   *  one exact file, and one file is by definition unpartitioned. The
   *  knob predates partitioning (it exists so a test can assert on the
   *  file the gateway would have written) and keeping its meaning literal
   *  is what lets those tests keep working unchanged. Production passes
   *  neither this nor `bucketsRoot` and gets buckets. To exercise
   *  partitioning in a test, pin `bucketsRoot` instead. */
  persistPath?: string
  /** Root of the per-workspace state buckets — tests pin a tmpdir.
   *  Defaults to `~/.agentproto/workspaces` (AIP-46 §State partitioning).
   *  Ignored when `persistPath` is set. */
  bucketsRoot?: string
  /** Path to the workspaces registry that bucket resolution consults —
   *  tests pin a tmpdir. Defaults to `~/.agentproto/workspaces.json`.
   *  Only the registry's slugs are read; a slug that isn't in it lands
   *  in the `default` bucket. */
  workspacesConfigPath?: string
  /** Disable persistence entirely. */
  persist?: boolean
  /** PTY factory (node-pty wrapper). When omitted, `spawnPty()`
   *  throws — the daemon advertises PTY support only when the cli
   *  layer resolved node-pty successfully. */
  spawnPty?: PtyFactory
  /** Hook called when a prompt arrives for an agent-cli session whose
   *  agentSession binding is gone (daemon restart). When provided,
   *  the registry transparently resumes the session via the adapter's
   *  resumeSessionId before dispatching the turn. When omitted,
   *  killed agent-cli sessions surface the legacy "not an agent
   *  session" error and the user must spawn fresh. */
  resumeAgent?: AgentSessionResumer
  /** When provided, the registry translates internal lifecycle transitions
   *  (turn-end, awaiting-input, exit) into SessionEvents on this bus. */
  sessionEvents?: SessionEventBus
  /** Override the structured-transcript base directory. Defaults to a
   *  `sessions` sibling of `persistPath` (`~/.agentproto/sessions` in
   *  production) — tests that already pin `persistPath` to a tmpdir get
   *  transcript isolation for free without also having to pass this. */
  transcriptDir?: string
  /** Shared, opt-in Langfuse session observer. Built once in the bootstrap
   *  from eval-reporter creds. Events only reach it for sessions in the
   *  registry's traced-session set — see `langfuseTracingDefault`. */
  langfuseTracer?: SessionObserver
  /** Default per-session tracing opt-in when `SpawnAgentInput.trace` is
   *  omitted. Defaults to false (tracing off). */
  langfuseTracingDefault?: boolean
}): SessionsRegistry {
  // `persistPath` names one exact file, so passing it means "don't
  // partition" (see its docblock). Absent it, state partitions per
  // workspace under `bucketsRoot` — AIP-46 §State partitioning — and
  // this path is only still consulted as the legacy artifact to migrate
  // FROM, read-only, once.
  const legacyPath = opts?.persistPath ?? SESSIONS_FILE_PATH()
  const partitioned = !opts?.persistPath
  const bucketsRoot = opts?.bucketsRoot ?? BUCKETS_ROOT()
  const workspacesConfigPath = opts?.workspacesConfigPath
  const persist = opts?.persist ?? true
  // Unchanged in both modes: transcripts still live in the shared
  // `~/.agentproto/sessions/`. AIP-46 §Layout makes them a per-bucket
  // SHOULD rather than a MUST precisely because moving them is its own
  // change — the read side has callers that ignore this base dir and
  // resolve off `homedir()` directly (`http-server.ts`,
  // `transcript-export.ts`), so a partial move loses transcripts rather
  // than partitioning them. Tracked as follow-up; `bucketTranscriptDir`
  // holds the path rule for it.
  const transcriptBaseDir = opts?.transcriptDir ?? join(dirname(legacyPath), "sessions")
  const baseTranscriptWriter = createTranscriptWriter({ baseDir: transcriptBaseDir })
  // Sibling writer for PTY (`terminal`) sessions — same per-id directory,
  // a `terminal.jsonl` file instead of `events.jsonl` since raw bytes
  // (not structured StreamEvents) are what a PTY has to persist.
  const terminalTranscriptWriter = createTerminalTranscriptWriter({ baseDir: transcriptBaseDir })
  // The transcript writer is the first (today only) per-session observer. The
  // composite fans every prompt/event/usage/close call out to its members, so
  // additional observers (e.g. an opt-in Langfuse session tracer) attach here
  // without touching any of the turn-loop call sites below. With a single
  // member the behaviour is identical to calling the writer directly.
  const tracedSessions = new Set<string>()
  const extraObservers: readonly SessionObserver[] = opts?.langfuseTracer
    ? [filterSessionObserver(opts.langfuseTracer, (id) => tracedSessions.has(id))]
    : []
  const transcriptWriter: SessionObserver = composeSessionObservers([
    baseTranscriptWriter,
    ...extraObservers,
  ])
  const ptyFactory = opts?.spawnPty
  const resumeAgent = opts?.resumeAgent
  const sessionEvents = opts?.sessionEvents
  const sessions = new Map<string, SessionRuntime>()
  // Cross-session pending-permissions inbox: every request parked by a
  // permission-hold session, keyed by the driver's stable request id.
  // Insertion order is preserved so `listPendingPermissions` reads oldest→
  // newest without a sort.
  const pendingPermissions = new Map<string, PendingPermission>()
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  // Monotonically-growing PTY-subscriber id. Detach is O(1) on
  // Map.delete(subId), so we never reuse — overflow at Number.MAX_-
  // SAFE_INTEGER would take ~285 years at 1M attaches/sec.
  let nextSubId = 1
  // Guards `shutdown()` from running twice — double-stop happens in
  // serve --interactive's Ctrl-C race; without this, the second
  // call writes an empty snapshot over the real one.
  let shutdownDone = false

  // ── boot-time history load ──
  // Read sessions.json synchronously at construction so the dashboard
  // shows historical sessions immediately on daemon restart. Anything
  // that was "running" or "starting" when the daemon last died gets
  // marked "killed" — we have no way to know if the orphan child
  // survived the daemon's exit, and pretending it's still alive would
  // make attach calls fail mysteriously.
  //
  // Historical entries are GHOSTS: descriptor only, no child / no
  // agentSession / no pty. Calls like kill(id) / attach(id) work on
  // them but degrade to no-ops (the underlying process is gone). The
  // session's `endedAt` is set to now when we infer a kill, so the
  // dashboard ages them from this boot rather than the daemon's last
  // life.
  //
  // Partitioned mode reads one snapshot PER BUCKET, which is what makes
  // HISTORY_CAP a per-bucket bound (AIP-46 §Per-bucket bounds) without
  // the cap itself having to know buckets exist: each call caps its own
  // file, so a busy workspace can no longer spend a quiet one's budget.
  //
  // Buckets a workspace once had but has no live rows in are still
  // tracked (`knownBuckets`) so a later persist rewrites them empty
  // rather than leaving a stale file behind.
  const knownBuckets = new Set<string>()
  // The bucket each LOADED (historical) session's rows actually came
  // from, keyed by session id. This is the authoritative home for a
  // loaded row — `groupRowsByBucket` persists it back here regardless
  // of whether `desc.workspaceSlug` still resolves against a (possibly
  // transiently unreadable) registry. Sessions with no entry here are
  // new this boot and resolve normally via `resolveBucketSlug`. See the
  // 2026-07-18 bucket-clobber incident: without this, a registry read
  // that failed for one persist cycle made every loaded row look
  // unregistered, relocating it to `default` and emptying its real
  // bucket on write.
  const sourceBucketOf = new Map<string, string>()
  // Every session id this daemon process has EVER placed in a given
  // bucket — at load time (a row read from that bucket's file at boot)
  // or at resolve time (a new session that landed there via
  // `resolveBucketSlug`). Grows monotonically: an id is added once and
  // never removed, even after the session itself is forgotten
  // (`sessions.delete`). This is what lets `mergeBucketRows` tell a
  // genuinely FOREIGN on-disk row (never held by us — safe to preserve)
  // apart from one this daemon deliberately removed (held here once,
  // absent from `rows` now — must NOT be resurrected). See
  // `mergeBucketRows`'s docblock in `workspace-buckets.ts`.
  const heldIdsByBucket = new Map<string, Set<string>>()
  if (persist) {
    if (partitioned) {
      // Read-only on the legacy artifact, once, guarded by its own
      // marker — see `migrateLegacySessionsFile`.
      migrateLegacySessionsFile({
        root: bucketsRoot,
        legacyFile: legacyPath,
        registered: readRegisteredSlugs(workspacesConfigPath),
      })
      for (const slug of listBuckets(bucketsRoot)) {
        knownBuckets.add(slug)
        loadHistorySnapshot(
          bucketSessionsFile(bucketsRoot, slug),
          sessions,
          sessionEvents,
          slug,
          sourceBucketOf,
          heldIdsByBucket,
        )
      }
    } else {
      loadHistorySnapshot(legacyPath, sessions, sessionEvents)
    }
  }
  // Frozen at boot, deliberately never mutated again — distinct from
  // `knownBuckets`, which keeps growing as new rows resolve into
  // buckets over the daemon's life. This one answers "did THIS daemon
  // instance actually read what was on disk for this bucket", which is
  // exactly the question a merge-before-write needs: a bucket that
  // shows up in `knownBuckets` later (a brand-new session resolved into
  // it) was never read, so writing it verbatim would silently discard
  // whatever another process already put there.
  const bootLoadedBuckets = new Set(knownBuckets)

  // Belt-and-suspenders: `process.on("exit")` runs even on uncaught
  // throws, terminal-close (SIGHUP), and any termination path that
  // bypassed the regular SIGINT/SIGTERM cleanup. The handler must be
  // sync (Node won't await async there); we already use sync IO in
  // `shutdown()` so this is safe. Idempotency guard inside shutdown
  // prevents a double-write when both this handler and the explicit
  // SIGINT path fire.
  const onProcessExit = (): void => {
    shutdownImpl()
  }
  if (persist) {
    process.on("exit", onProcessExit)
  }

  // Emit session:exited once per session, deduplicated via exitedEmitted flag.
  const emitExited = (rt: SessionRuntime): void => {
    if (rt.exitedEmitted) return
    // A dying session must never leave a held permission RPC dangling — cancel
    // its parked requests (resolves them as `cancelled`) before anything else.
    // Runs even when no bus is wired, so the driver RPC always settles.
    cancelPendingPermissionsForSession(rt)
    if (!sessionEvents) return
    rt.exitedEmitted = true
    sessionEvents.emit({
      type: "session:exited",
      sessionId: rt.desc.id,
      exitCode: rt.desc.exitCode,
      status: rt.desc.status as "exited" | "killed" | "error",
      label: rt.desc.label,
      ts: new Date().toISOString(),
      ...(rt.desc.endedReason ? { reason: rt.desc.endedReason } : {}),
    })
  }

  // ── Pending-permissions inbox helpers ────────────────────────────────
  //
  // A permission-hold session surfaces each `session/request_permission` as an
  // `agent-prompt` StreamEvent (see the driver's ACP arm). `projectEvent`
  // routes that here to register a PendingPermission and emit
  // `session:permission-request`; `respondPermission` resolves it back through
  // the held driver RPC.

  /** Recompute `desc.awaitingPermission` from the live pending set — true iff
   *  the session still has at least one parked request. */
  const refreshAwaitingPermission = (rt: SessionRuntime): void => {
    let has = false
    for (const p of pendingPermissions.values()) {
      if (p.sessionId === rt.desc.id) {
        has = true
        break
      }
    }
    if (has) rt.desc.awaitingPermission = true
    else delete rt.desc.awaitingPermission
  }

  /** Register a permission request surfaced by an `agent-prompt` event on a
   *  permission-hold session, and announce it on the bus. */
  const registerPendingPermission = (
    rt: SessionRuntime,
    evt: AgentStreamEvent,
  ): void => {
    const id = evt.toolCallId
    if (!id) return // nothing to respond to — treat as a plain awaiting-input
    const options = normalizePermissionOptions(evt.options)
    const toolName = evt.toolName
    const text =
      evt.text ?? (toolName ? `Allow "${toolName}"?` : "The agent is requesting permission.")
    const pending: PendingPermission = {
      id,
      sessionId: rt.desc.id,
      toolCallId: id,
      ...(toolName ? { toolName } : {}),
      text,
      options,
      requestedAt: new Date().toISOString(),
      ...(evt.rawInput !== undefined ? { rawInput: evt.rawInput } : {}),
    }
    pendingPermissions.set(id, pending)
    rt.desc.awaitingPermission = true
    schedulePersist()
    if (sessionEvents) {
      sessionEvents.emit({
        type: "session:permission-request",
        sessionId: rt.desc.id,
        permissionId: id,
        ...(toolName ? { toolName } : {}),
        text,
        ...(rt.desc.label ? { label: rt.desc.label } : {}),
        ts: pending.requestedAt,
      })
    }
  }

  /** Cancel (resolve as `cancelled`) every request parked for a dying session
   *  so no held driver RPC dangles. Emits `session:permission-resolved` with
   *  `decision: "cancelled"` for each. Best-effort — the driver session may
   *  already be closing. */
  const cancelPendingPermissionsForSession = (rt: SessionRuntime): void => {
    for (const [id, pending] of pendingPermissions) {
      if (pending.sessionId !== rt.desc.id) continue
      pendingPermissions.delete(id)
      try {
        void rt.agentSession?.respondPermission?.(id, { cancelled: true })
      } catch {
        // driver already gone — the RPC is moot
      }
      if (sessionEvents) {
        sessionEvents.emit({
          type: "session:permission-resolved",
          sessionId: rt.desc.id,
          permissionId: id,
          decision: "cancelled",
          ...(rt.desc.label ? { label: rt.desc.label } : {}),
          ts: new Date().toISOString(),
        })
      }
    }
    delete rt.desc.awaitingPermission
  }

  /**
   * Resolve a parked permission by id — maps the decision (or explicit
   * optionId) to one of the offered options, resolves the held driver RPC,
   * clears the session's awaiting-permission state, and emits
   * `session:permission-resolved`. Body of the public `respondPermission`
   * API method, factored out so the `action:"gate"` path in the
   * `agent-prompt` handler below (which resolves a permission itself, from
   * a shell exit code rather than a human/orchestrator call) can reuse the
   * exact same resolution logic instead of duplicating it.
   */
  const resolvePendingPermission = async (
    id: string,
    input: PermissionRespondInput,
  ): Promise<PermissionRespondResult> => {
    const pending = pendingPermissions.get(id)
    if (!pending) {
      return {
        ok: false,
        error: "not_found",
        message: `no pending permission "${id}" (unknown or already resolved)`,
      }
    }
    const rt = sessions.get(pending.sessionId)
    if (!rt || !rt.agentSession) {
      // Session vanished between registration and response — drop the stale
      // entry so it stops showing up in the inbox.
      pendingPermissions.delete(id)
      if (rt) refreshAwaitingPermission(rt)
      return {
        ok: false,
        error: "session_gone",
        message: `session "${pending.sessionId}" for permission "${id}" is no longer alive`,
      }
    }
    const respond = rt.agentSession.respondPermission
    if (!respond) {
      return {
        ok: false,
        error: "unsupported",
        message: `session "${pending.sessionId}" driver does not support held permissions`,
      }
    }
    const selected = selectPermissionOptionId(pending.options, input)
    if (selected === null) {
      return {
        ok: false,
        error: "no_matching_option",
        message:
          `permission "${id}" offers no ${input.decision === "approve" ? "allow" : "reject"}` +
          `-flavored option; pass an explicit optionId (one of: ${pending.options
            .map(o => o.optionId)
            .join(", ")})`,
      }
    }
    // Resolve the held driver RPC — the agent's turn unblocks with the chosen
    // outcome. Clear inbox state BEFORE awaiting so a slow driver can't leave
    // a resolved request visible.
    pendingPermissions.delete(id)
    const chosenOptionId = "optionId" in selected ? selected.optionId : undefined
    // The request is resolved either way — the agent's turn resumes, so it is
    // no longer awaiting a human. Mirrors how a new turn clears these.
    delete rt.desc.awaitingInput
    rt.desc.awaitingQuestion = undefined
    refreshAwaitingPermission(rt)
    const okResolved = await respond(id, selected)
    if (sessionEvents) {
      sessionEvents.emit({
        type: "session:permission-resolved",
        sessionId: pending.sessionId,
        permissionId: id,
        decision: input.decision,
        ...(chosenOptionId ? { optionId: chosenOptionId } : {}),
        ...(rt.desc.label ? { label: rt.desc.label } : {}),
        ts: new Date().toISOString(),
      })
    }
    schedulePersist()
    if (!okResolved) {
      // The driver had already resolved this request (race with a
      // session-death cancel). Report success anyway — the inbox entry is
      // gone and the caller's intent is moot.
      return { ok: true, permission: pending, decision: input.decision, ...(chosenOptionId ? { optionId: chosenOptionId } : {}) }
    }
    return {
      ok: true,
      permission: pending,
      decision: input.decision,
      ...(chosenOptionId ? { optionId: chosenOptionId } : {}),
    }
  }

  /**
   * Append one record to this session's workspace-bucket conversation
   * index (`conversation-index.ts`) — the persisted, append-only memo of
   * the session ↔ native-transcript link (DESIGN.md §6). Called at every
   * point the link is freshly known: spawn (`spawnAgent`), an ACP-level
   * resume (`maybeResumeAgent`), and a native graceful-exit resume-hint
   * (`sniffResumeHints`).
   *
   * Best-effort by design, same discipline as `persistSnapshot` and the
   * transcript writer: a filesystem hiccup here must never throw into the
   * turn path, so every failure is caught and only logged. Fire-and-forget
   * (`void`) — none of the three call sites has anything useful to do
   * with a write's completion, and none of them is on a path a caller is
   * blocked on.
   *
   * `adapterSessionIdOverride` is for the graceful-exit resume-hint call
   * site: a raw-PTY claude session may never have gotten an ACP
   * `adapterSessionId` at all, and the printed `claude --resume <uuid>`
   * IS that same id space (the on-disk `.jsonl` uuid — see
   * resume-strategies.ts's fsProbe docblock), so it's the more current
   * value to record even when `desc.adapterSessionId` is already set.
   *
   * Gated on `persist` AND `partitioned` — the same two flags
   * `schedulePersist`/`persistSnapshot` already answer to:
   *   - `persist: false` (most of this file's own tests) means "write
   *     nothing to disk, ever" — honour that for this store too.
   *   - a caller that passed an explicit `persistPath` (single pooled
   *     file — `sessions.test.ts`'s own convention) is opting OUT of the
   *     per-workspace-bucket architecture entirely, and `bucketsRoot` in
   *     that mode still defaults to the REAL `~/.agentproto/workspaces`
   *     unless separately overridden — `persistSnapshot` never touches it
   *     either in this mode (see `partitioned` branch below), so this
   *     shouldn't either.
   * Neither override (production, and `sessions-partitioning.test.ts`
   * which HOME-isolates) ⇒ both true ⇒ this proceeds normally.
   */
  const recordConversationLink = (
    rt: SessionRuntime,
    adapterSessionIdOverride?: string,
  ): void => {
    if (!persist || !partitioned) return
    const desc = rt.desc
    if (desc.kind !== "agent-cli") return
    const adapterSlug = desc.adapterSlug
    const adapterSessionId = adapterSessionIdOverride ?? desc.adapterSessionId
    const cwd = desc.cwd
    if (!adapterSlug || !adapterSessionId || !cwd) return
    void (async () => {
      try {
        const native = await resolveNativeLink({ cwd, adapterSlug, adapterSessionId })
        const registered = readRegisteredSlugs(workspacesConfigPath)
        const slug = resolveBucketSlug(desc.workspaceSlug, registered)
        const record: ConversationIndexRecord = {
          sessionId: desc.id,
          workspace: slug,
          cwd,
          adapterSlug,
          adapterSessionId,
          ...(native ? { native } : {}),
          agentprotoTranscript: sessionEventsPath(desc.id, transcriptBaseDir),
          ...(desc.title ? { title: desc.title } : {}),
          startedAt: desc.startedAt,
          ...(desc.endedAt ? { endedAt: desc.endedAt } : {}),
        }
        await appendConversationRecord(bucketsRoot, slug, record)
      } catch (err) {
        console.warn(
          `[sessions] conversation-index write failed for ${desc.id}: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    })()
  }

  const schedulePersist = (): void => {
    if (!persist) return
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      void persistSnapshot()
    }, PERSIST_DEBOUNCE_MS)
  }

  /** Descriptors as they go to disk. `processAlive` and `interrupted` are
   *  DERIVED, read-time fields (see stampProcessAlive / stampInterrupted) —
   *  strip them before writing so a restored descriptor is never seen with a
   *  stale value before the next list()/get() recomputes it fresh
   *  (`interrupted` re-derives from the persisted `killedMidTurn`/
   *  `endedReason`, so nothing is lost by not persisting it). */
  const snapshotRows = (): SessionDescriptor[] =>
    Array.from(sessions.values()).map(s => {
      const { processAlive: _processAlive, interrupted: _interrupted, ...rest } = s.desc
      return rest
    })

  /** Group the live registry by bucket, re-reading the workspaces
   *  registry each time so a workspace registered mid-run starts
   *  bucketing without a daemon restart.
   *
   *  A row this daemon LOADED from disk (`sourceBucketOf`) goes back to
   *  the bucket it came from, full stop — never recomputed from
   *  `workspaceSlug` against the registry, so a registry read that fails
   *  or races a concurrent writer for one persist cycle cannot relocate
   *  rows that are already correctly homed (2026-07-18 bucket-clobber
   *  incident). Only sessions with no recorded source — new this boot —
   *  resolve via `resolveBucketSlug`, same as always: an unregistered new
   *  session still lands in `default` (AIP-46 semantics, unchanged).
   *
   *  Every known bucket gets an entry even when it has no rows left —
   *  otherwise forgetting a bucket's last session would leave its old
   *  snapshot on disk to be re-loaded at the next boot.
   *
   *  Also stamps `heldIdsByBucket` for every row it places — the id is
   *  recorded against the bucket it resolves to THIS round, whether that
   *  came from `sourceBucketOf` or fresh resolution, so `rowsToWrite`'s
   *  merge backstop can tell "never held by us" (safe to preserve from
   *  disk) apart from "held once, gone now" (a deliberate forget, must
   *  not resurrect) even for a bucket this daemon never loaded at
   *  boot. */
  const groupRowsByBucket = (): Map<string, SessionDescriptor[]> => {
    const registered = readRegisteredSlugs(workspacesConfigPath)
    const groups = new Map<string, SessionDescriptor[]>()
    for (const slug of knownBuckets) groups.set(slug, [])
    for (const desc of snapshotRows()) {
      const slug = sourceBucketOf.get(desc.id) ?? resolveBucketSlug(desc.workspaceSlug, registered)
      markHeldId(heldIdsByBucket, slug, desc.id)
      const list = groups.get(slug)
      if (list) list.push(desc)
      else groups.set(slug, [desc])
    }
    for (const slug of groups.keys()) knownBuckets.add(slug)
    return groups
  }

  /** What to actually write for one bucket in a persist round.
   *
   *  A bucket this daemon authoritatively loaded at boot
   *  (`bootLoadedBuckets`) is written exactly as computed — it may
   *  legitimately shrink, e.g. the user forgot a session (`d` in the
   *  TUI) and this daemon's in-memory view is the freshest truth there
   *  is for it.
   *
   *  A bucket it never loaded gets merged against whatever is on disk
   *  first. That's the case a daemon which never read a bucket at boot —
   *  a second/skewed-build instance, one that only loaded its own
   *  workspace — hits the moment ANY row (even a single brand-new
   *  session) happens to resolve into it: without the merge, writing
   *  `rows` verbatim would silently discard every row already on disk
   *  that this process's memory never held. `heldIdsByBucket` bounds the
   *  merge so it only ever RESTORES foreign rows, never resurrects one
   *  this daemon deliberately forgot — see `mergeBucketRows`. */
  const rowsToWrite = (slug: string, rows: SessionDescriptor[]): unknown[] =>
    bootLoadedBuckets.has(slug)
      ? rows
      : mergeBucketRows(
          readBucketRows(bucketsRoot, slug),
          rows,
          heldIdsByBucket.get(slug) ?? EMPTY_ID_SET,
        )

  const persistSnapshot = async (): Promise<void> => {
    try {
      const savedAt = new Date().toISOString()
      if (partitioned) {
        for (const [slug, rows] of groupRowsByBucket()) {
          await writeBucketSnapshot(bucketsRoot, slug, {
            savedAt,
            sessions: rowsToWrite(slug, rows),
          })
        }
        return
      }
      const snapshot = { savedAt, sessions: snapshotRows() }
      await fs.mkdir(dirname(legacyPath), { recursive: true })
      await fs.writeFile(legacyPath, JSON.stringify(snapshot, null, 2) + "\n")
    } catch (err) {
      // Persistence is best-effort — log only, never throw.
      console.warn(
        `[sessions] persist failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  const appendLine = (
    rt: SessionRuntime,
    line: string,
    stream: "stdout" | "stderr"
  ): void => {
    rt.recentLines.push(line)
    if (rt.recentLines.length > RECENT_LINES_CAP) {
      rt.recentLines.splice(0, rt.recentLines.length - RECENT_LINES_CAP)
    }
    rt.desc.lastOutputAt = new Date().toISOString()
    sniffResumeHints(rt, line)
    rt.emitter.emit("line", { line, stream })
  }

  /**
   * Provider-specific resume-hint sniffer. Looks up the adapter's
   * strategy in `RESUME_STRATEGIES` and runs its `outputHint` regex
   * against each agent-cli line. The captured id is recorded on the
   * descriptor so `agentproto sessions restart` can use it.
   *
   * ANSI-stripped before matching so dim/color codes don't break the
   * pattern. Adapters without a strategy entry (or without an
   * outputHint) are skipped — they fall back to ACP-level resume.
   */
  const sniffResumeHints = (rt: SessionRuntime, line: string): void => {
    if (rt.desc.kind !== "agent-cli") return
    const strategy = rt.desc.adapterSlug
      ? RESUME_STRATEGIES[rt.desc.adapterSlug]
      : undefined
    if (!strategy?.outputHint) return
    const plain = stripAnsiCodes(line)
    const m = plain.match(strategy.outputHint)
    if (m && m[1]) {
      rt.desc.resumeMetadata = {
        ...(rt.desc.resumeMetadata ?? {}),
        [strategy.storeAs]: m[1],
      }
      schedulePersist()
      // Write point 3/3: graceful-exit resume hint. Covers the raw-PTY
      // case where no ACP adapterSessionId was ever set — the captured
      // id is the only handle to this conversation the daemon will have.
      recordConversationLink(rt, m[1])
    }
  }

  /**
   * PTY byte ring buffer. Keeps the last ~64 KiB of raw bytes so a
   * fresh attacher sees the current screenful (alt-screen apps like
   * Claude TUI / vim repaint on next interaction but a snapshot is
   * still better than blank). Drops oldest chunks when over cap;
   * never splits within a chunk — Buffer arithmetic on UTF-8 mid-
   * sequence would corrupt multi-byte glyphs.
   */
  const appendBytes = (rt: SessionRuntime, chunk: Buffer): void => {
    // Durable copy BEFORE the RAM ring drops anything — same ordering
    // rule transcript-writer.ts follows for agent-cli StreamEvents.
    terminalTranscriptWriter.appendChunk(rt.desc.id, chunk)
    rt.recentBytes.push(chunk)
    rt.recentBytesSize += chunk.byteLength
    while (
      rt.recentBytesSize > RECENT_BYTES_CAP &&
      rt.recentBytes.length > 1
    ) {
      const dropped = rt.recentBytes.shift()
      if (dropped) rt.recentBytesSize -= dropped.byteLength
    }
    rt.desc.lastOutputAt = new Date().toISOString()
    rt.emitter.emit("data", chunk)
  }

  /**
   * Recompute the smallest cols/rows across the active subscriber
   * set and resize the PTY accordingly (tmux's "smallest attached
   * client wins" rule). No-op when the subscriber map is empty.
   */
  const reconcilePtySize = (rt: SessionRuntime): void => {
    if (!rt.pty || !rt.ptySubscribers || rt.ptySubscribers.size === 0) return
    let cols = Infinity
    let rows = Infinity
    for (const dim of rt.ptySubscribers.values()) {
      if (dim.cols < cols) cols = dim.cols
      if (dim.rows < rows) rows = dim.rows
    }
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
    try {
      rt.pty.resize(cols, rows)
    } catch {
      // pty may have exited between the emit and the resize — swallow.
    }
  }

  /**
   * Project ACP-style stream events into ring-buffer lines. Keeps
   * the line shape simple so the existing /stream SSE consumer
   * (and the xterm panel) just renders them as-is.
   */
  const projectEvent = (rt: SessionRuntime, evt: AgentStreamEvent): void => {
    switch (evt.kind) {
      case "text-delta":
        // Assistant text means the model has the floor again, so it cannot
        // still be waiting on the tool that blocked it — the result landed
        // (whether or not the adapter bothered to emit one; several don't).
        // This is the catch-all behind the explicit releases below.
        releaseBlockedOn(rt.desc)
        if (evt.text) {
          // text-delta is a stream of chunks — split on newlines so
          // each line lands in the ring buffer separately. Coalesce
          // a trailing fragment via rt.textBuf.
          const combined = rt.textBuf + evt.text
          const lines = combined.split(/\r?\n/)
          rt.textBuf = lines.pop() ?? ""
          for (const line of lines) appendLine(rt, line, "stdout")
        }
        break
      case "thought":
        if (evt.text) {
          // Same coalescing as text-delta — some adapters stream
          // chain-of-thought one token at a time, which would
          // otherwise produce ~100 [thought] lines per turn.
          const combined = rt.thoughtBuf + evt.text
          const lines = combined.split(/\r?\n/)
          rt.thoughtBuf = lines.pop() ?? ""
          for (const line of lines) {
            if (line.trim()) {
              appendLine(rt, `\x1b[2m[thought] ${line}\x1b[0m`, "stdout")
            }
          }
        }
        break
      case "tool-call": {
        // Surface what the turn is now blocked on (sub-agent / command) when
        // the tool name classifies. The toolCallId is remembered so a nested
        // tool's result can't clear an outer tool's block — but a matching
        // result is only ONE of the ways the block ends; see releaseBlockedOn.
        const blocked = classifyBlockedOn(evt.toolName)
        if (blocked) {
          rt.desc.blockedOn = blocked
          rt.desc.pendingToolCallId = evt.toolCallId
        }
        // An enrichment restates a call already announced under this
        // toolCallId (the agent only learned its input afterwards — see
        // @agentproto/acp's tool_call_update handling). The structured
        // transcript merges it by id; the ring buffer must NOT print a second
        // [tool] line for one call.
        if (!evt.isUpdate) {
          appendLine(
            rt,
            `\x1b[36m[tool] ${formatToolCall(evt.toolName ?? "?", evt.arguments)}\x1b[0m`,
            "stdout"
          )
        }
        break
      }
      case "tool-result": {
        if (rt.desc.blockedOn && evt.toolCallId === rt.desc.pendingToolCallId) {
          releaseBlockedOn(rt.desc)
        }
        // Keep this to ONE line per result — some drivers stream huge
        // payloads (file dumps, search hits) and the ring buffer is a
        // fixed-size window, not a log store.
        const summary = formatToolResult(evt.toolName, evt.result, evt.isError ?? false)
        if (summary) {
          appendLine(
            rt,
            evt.isError
              ? `\x1b[31m[tool-error] ${summary}\x1b[0m`
              : `\x1b[2m[tool-result] ${summary}\x1b[0m`,
            evt.isError ? "stderr" : "stdout"
          )
        } else if (evt.isError) {
          appendLine(rt, `\x1b[31m[tool-error]\x1b[0m`, "stderr")
        }
        break
      }
      case "agent-prompt": {
        rt.desc.awaitingInput = true
        const options = normalizeAgentPromptOptions(evt.options)
        if (options) {
          rt.desc.awaitingQuestion = {
            text: evt.text ?? (evt.toolName ? `Allow "${evt.toolName}"?` : "Agent is requesting input."),
            options,
            source: "structured",
          }
        }
        // The rule table (`.agentproto/hooks.json`) generalizes the old
        // `permissionHold` boolean into a per-tool/command decision. An
        // empty or log-only rule set (today's default — see hooks-config.ts)
        // falls through to `fallback`, reproducing the pre-engine behavior
        // exactly: no `.agentproto/hooks.json` or a log-only one changes
        // nothing about whether a request is held.
        const { command, args } = extractCommandArgs(evt.rawInput)
        const workspace = rt.desc.cwd ?? process.cwd()
        const hookRules = loadHooksConfig(workspace)
        const { decision, rule } = decideRule(
          hookRules,
          { tool: evt.toolName ?? "", command, args },
          rt.permissionHold ? "hold" : "allow",
        )
        // Permission-hold sessions park the request in the cross-session inbox
        // so a human/orchestrator can approve/deny it out-of-band. The RPC is
        // held open by the driver until `respondPermission` resolves it. A
        // "deny" decision degrades to the same hold-for-human path — this PR
        // ships the rule-engine + config substrate, not an auto-deny action
        // that blocks real work (see hooks-config.ts); no shipped default
        // config produces "deny" today.
        if (decision === "gate" && rule?.gate && evt.toolCallId) {
          // action:"gate" auto-resolves the held request itself, from a
          // shell command's exit code, instead of waiting on a human — but
          // it still parks it in the pending-permissions inbox first (same
          // as "hold") so a session that dies mid-gate gets cancelled
          // cleanly by `cancelPendingPermissionsForSession` rather than
          // leaking a driver RPC.
          registerPendingPermission(rt, evt)
          const toolCallId = evt.toolCallId
          const gate = rule.gate
          appendLine(
            rt,
            `\x1b[33m[gate] running ${gate.command}${gate.args?.length ? " " + gate.args.join(" ") : ""}\x1b[0m`,
            "stdout",
          )
          void runShellGate(gate, { workspace, sessionCwd: workspace })
            .then(outcome => {
              const passed = outcome.kind === "ran" && outcome.passed
              const detail = outcome.kind === "ran" ? `exit ${outcome.exitCode}` : outcome.message
              appendLine(
                rt,
                passed
                  ? `\x1b[32m[gate] passed (${detail}) — approving\x1b[0m`
                  : `\x1b[31m[gate] failed (${detail}) — denying\x1b[0m`,
                passed ? "stdout" : "stderr",
              )
              return resolvePendingPermission(toolCallId, { decision: passed ? "approve" : "deny" })
            })
            .catch(err => {
              appendLine(
                rt,
                `\x1b[31m[gate] error resolving permission: ${err instanceof Error ? err.message : String(err)}\x1b[0m`,
                "stderr",
              )
            })
        } else if (decision === "hold" || decision === "deny" || decision === "gate") {
          // A "gate" decision with no toolCallId to resolve can't auto-approve
          // or auto-deny (there is nothing to call `respondPermission` with),
          // so it degrades to the same hold-for-human path as "hold"/"deny"
          // rather than silently hanging the request forever.
          registerPendingPermission(rt, evt)
          appendLine(rt, `\x1b[33m[permission] ${evt.text ?? evt.toolName ?? "requesting permission"}\x1b[0m`, "stdout")
        } else {
          appendLine(rt, `\x1b[33m[awaiting input]\x1b[0m`, "stdout")
        }
        break
      }
      case "turn-end": {
        if (evt.reason === "awaiting-input") rt.desc.awaitingInput = true
        // Flush any buffered text/thought fragments as final lines.
        if (rt.thoughtBuf.trim()) {
          appendLine(
            rt,
            `\x1b[2m[thought] ${rt.thoughtBuf}\x1b[0m`,
            "stdout"
          )
        }
        rt.thoughtBuf = ""
        if (rt.textBuf) {
          appendLine(rt, rt.textBuf, "stdout")
          rt.textBuf = ""
        }
        appendLine(
          rt,
          `\x1b[2m── turn-end (${evt.reason ?? "completed"}) ──\x1b[0m`,
          "stdout"
        )
        break
      }
      case "error": {
        // A failing tool reports `error`, NOT a tool-result — so this is the
        // only signal that the thing we were blocked on is done. Without this
        // release the flag survived the failure and the session advertised
        // "blocked on command · <toolCallId>" while the agent worked on.
        releaseBlockedOn(rt.desc)
        const code =
          typeof evt.error?.code === "number" ? ` (code ${evt.error.code})` : ""
        appendLine(
          rt,
          `\x1b[31m[error]${code} ${evt.error?.message ?? "unknown"}\x1b[0m`,
          "stderr"
        )
        // Project the child's stderr tail when define-agent-cli
        // attached it — otherwise the user sees only "Invalid
        // params" and has to dig into the daemon log for context.
        const data = evt.error?.data as
          | { stderr?: unknown }
          | null
          | undefined
        if (data && typeof data === "object" && typeof data.stderr === "string") {
          for (const line of data.stderr.split(/\r?\n/)) {
            if (line) appendLine(rt, `\x1b[2m  ${line}\x1b[0m`, "stderr")
          }
        }
        break
      }
      case "plan": {
        const entries = evt.entries ?? []
        const done = entries.filter(e => e.status === "completed").length
        appendLine(
          rt,
          `\x1b[35m[plan] ${done}/${entries.length} ${entries.map(e => e.content).join("; ")}\x1b[0m`,
          "stdout"
        )
        break
      }
      // "usage_update" is high-frequency telemetry (context size/cost) — the
      // ring buffer isn't the right place for it (cost is surfaced via
      // rt.desc.costUsd at turn-end); it still lands in events.jsonl via the
      // transcript writer tap point. We DO mirror its structured fields onto
      // the descriptor here so the latest context window + any adapter-
      // reported cost/tokens are available live to session_list / session_usage.
      case "usage_update": {
        if (typeof evt.size === "number" && evt.size > 0) rt.desc.contextSize = evt.size
        // `used` claims to be tokens currently in context (see the field's
        // doc comment above) — but at least one adapter's ACP server has
        // been observed sending a cumulative session-lifetime token total
        // in this same field instead, which routinely lands 10-70x past the
        // window. A `used` that exceeds the window it's supposedly inside
        // of is provably not that; `plausibleContextUsed` drops it rather
        // than let a fabricated-looking >100% occupancy figure through.
        if (typeof evt.used === "number" && evt.used > 0) {
          const used = plausibleContextUsed(rt.desc.contextSize, evt.used)
          if (used !== undefined) rt.desc.contextUsed = used
        }
        if (evt.cost) {
          rt.desc.costUsd = evt.cost.amount
          rt.adapterReportedCost = true
        }
        if (typeof evt.tokensIn === "number") rt.desc.tokensIn = evt.tokensIn
        if (typeof evt.tokensOut === "number") rt.desc.tokensOut = evt.tokensOut
        break
      }
    }
  }

  /**
   * Drive one agent turn. Sets busy=true, drains the event stream
   * into the ring buffer, clears busy on completion. Bumps the
   * descriptor status to "error" if the iteration throws (network
   * drop, child died mid-turn).
   */
  /**
   * Shared sync validation for sendPrompt + enqueuePrompt. Throws on
   * missing session / wrong kind / dead session / busy so both code
   * paths surface the exact same error messages — the only difference
   * is whether the caller awaits the turn.
   *
   * Must be called AFTER `maybeResumeAgent(rt)` has already been
   * awaited — a dead-but-resumable agent-cli session only regains
   * `rt.agentSession` there.
   *
   * Liveness is checked via `rt.desc.status`, NOT merely
   * `!rt.agentSession` — `kill()` flips status to "killed" but leaves
   * `rt.agentSession` referencing the now-closed session object (it
   * only calls `.close()`, it doesn't clear the field), so a
   * `!rt.agentSession` check alone would miss a live-killed session
   * and let `runAgentTurn` call `.send()` on a dead connection. Status
   * catches that case too, not just the daemon-restart/dead-and-
   * unresumable case where `agentSession` really is absent. Either way
   * this throws `SessionNotAliveError` (not a generic Error) so
   * ingress can report status/409 truthfully instead of the caller
   * getting back a lie like `{queued: true}`.
   */
  const validateAgentTurn = (id: string, caller: string): SessionRuntime => {
    const rt = sessions.get(id)
    if (!rt) throw new Error(`${caller}: no session "${id}"`)
    if (rt.desc.kind !== "agent-cli") {
      throw new Error(
        `${caller}: session "${id}" is not an agent session (kind=${rt.desc.kind})`
      )
    }
    const isAlive = rt.desc.status === "running" || rt.desc.status === "starting"
    if (!isAlive || !rt.agentSession) {
      throw new SessionNotAliveError(id, rt.desc.status, caller)
    }
    if (rt.busy) {
      throw new Error(
        `${caller}: session "${id}" is mid-turn — wait for it to finish or cancel`
      )
    }
    return rt
  }

  /**
   * Race-free wait for a mid-turn session to settle to idle: resolves
   * the instant `rt.busy` flips false (the same flag `validateAgentTurn`
   * reads), driven by the "busy" event `runAgentTurn`'s finally block
   * emits — never a fixed sleep. Resolves immediately if the turn is
   * already over by the time this is called. Rejects if the turn
   * hasn't settled within `INTERRUPT_SETTLE_TIMEOUT_MS` (a hung/buggy
   * adapter that never delivers a turn-end for the cancelled turn).
   */
  const waitForTurnSettled = (
    rt: SessionRuntime,
    id: string,
    caller: string
  ): Promise<void> => {
    if (!rt.busy) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const onBusy = (busy: boolean): void => {
        if (busy) return
        cleanup()
        resolve()
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        rt.emitter.off("busy", onBusy)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(
          new Error(
            `${caller}: session "${id}" did not settle after interrupt within ${INTERRUPT_SETTLE_TIMEOUT_MS}ms`
          )
        )
      }, INTERRUPT_SETTLE_TIMEOUT_MS)
      rt.emitter.on("busy", onBusy)
    })
  }

  /**
   * The `{interrupt: true}` mid-turn arm, shared by `sendPrompt` and
   * `enqueuePrompt`: cancel the in-flight turn via the session handle's
   * `cancel()` (the CLI-side equivalent of Ctrl-C — ACP `session/cancel`,
   * or an adapter-specific SIGINT for process/PTY-backed adapters), then
   * await the turn actually settling before returning. Does NOT run
   * admission itself — the caller still goes through `validateAgentTurn`
   * afterward, now finding the session idle.
   *
   * `caller` only shapes error messages; both entry points reach the same
   * logic, so a message naming the wrong one would misdirect debugging.
   */
  const interruptInFlightTurn = async (
    rt: SessionRuntime,
    id: string,
    caller: string
  ): Promise<void> => {
    const session = rt.agentSession
    if (!session) {
      // Invariant: `runAgentTurn` requires `agentSession` before it
      // ever sets `busy = true`, and nothing clears the field once set
      // (see the `validateAgentTurn` doc comment on `kill()`) — this
      // only fires if that invariant is ever violated.
      throw new Error(
        `${caller}: session "${id}" is mid-turn but has no live agent session to cancel`
      )
    }
    try {
      await session.cancel()
    } catch (err) {
      throw new Error(
        `${caller}: session "${id}" does not support interrupt — cancelling the in-flight turn failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
    await waitForTurnSettled(rt, id, caller)
  }

  /**
   * Record one FAILED in-place resume attempt (§5 cap/backoff): bump the
   * persisted `resumeAttempts` counter and stamp `lastResumeAt`. Persisted (not
   * in-memory) so the cap survives a daemon restart — a crash-looping daemon
   * can't re-attempt a broken session past `MAX_RESUME_ATTEMPTS` on each boot.
   * Called from both resume failure modes (adapter returned null / resume
   * threw). Reset to idle by the next successful turn-end.
   */
  const recordFailedResume = (rt: SessionRuntime): void => {
    rt.desc.resumeAttempts = (rt.desc.resumeAttempts ?? 0) + 1
    rt.desc.lastResumeAt = new Date().toISOString()
    schedulePersist()
  }

  /**
   * Attempt to resume a dead agent-cli session by re-spawning the
   * adapter with the persisted `adapterSessionId`. The conversation
   * continues from where it left off — ACP's `resumeSessionId`
   * contract guarantees the adapter rehydrates state from the
   * upstream provider (Anthropic / OpenAI / etc.) when supported.
   *
   * Returns silently when:
   *   - resumeAgent hook wasn't provided (older daemon embedding)
   *   - session is already alive (binding present)
   *   - session is a non-agent kind (terminal/command can't resume)
   *   - descriptor lacks adapterSessionId or adapterSlug (legacy row
   *     persisted before resume metadata was tracked)
   *
   * Concurrent prompt arrivals share one resume attempt via
   * `rt.resumePromise`.
   */
  const maybeResumeAgent = async (rt: SessionRuntime): Promise<void> => {
    if (rt.agentSession) return
    if (!resumeAgent) return
    // Descriptor-level eligibility (§5): agent-cli with the resume essentials
    // (adapterSlug, adapterSessionId, cwd) and not archived. PTY/command/
    // archived rows never resume in place — they revive only via new-id
    // session_restart. The eager boot pass (PR-4) layers
    // `endedReason === "daemon-restart"` on top of this predicate; the lazy
    // prompt path here deliberately lets an operator's prompt to any killed
    // row through, treating it as explicit intent.
    if (!isResumable(rt.desc)) return
    // Cap/backoff (§5): a session whose adapter fails to resume must not be
    // retried on every prompt forever. `isResumable` is already true here, so
    // a false `canResume` means the attempt counter has hit
    // MAX_RESUME_ATTEMPTS — refuse to spawn and fail LOUD (no silent no-op, no
    // fourth spawn). The prompter is told to fall back to new-id
    // session_restart. Because `resumeAttempts` is persisted, this also caps a
    // launchd KeepAlive crash-loop's total re-attempts across boots.
    if (!canResume(rt.desc)) {
      throw new ResumeDisabledError(rt.desc.id, rt.desc.resumeAttempts ?? 0)
    }
    const adapterSlug = rt.desc.adapterSlug ?? rt.adapterSlug
    const adapterSessionId = rt.desc.adapterSessionId
    const cwd = rt.desc.cwd
    // isResumable already guaranteed all three; this guard re-narrows the
    // optional descriptor fields for the type-checker.
    if (!adapterSlug || !adapterSessionId || !cwd) return
    if (rt.resumePromise) {
      await rt.resumePromise
      return
    }
    rt.resumePromise = (async () => {
      appendLine(
        rt,
        `── resuming ${adapterSlug} session ${adapterSessionId} ──`,
        "stdout"
      )
      try {
        const fresh = await resumeAgent({
          adapterSlug,
          cwd,
          resumeSessionId: adapterSessionId,
          // The prior descriptor — the hook re-resolves billing-auth off its
          // `auth.mode` echo / `accessProfile` / model / route (money bug fix).
          descriptor: rt.desc,
          // Re-mount the persisted spawn-time toolset (orchestrator WP1).
          ...(rt.desc.mcpServers ? { mcpServers: rt.desc.mcpServers } : {}),
          // Keep pulsing lastActivityAt across a resume the same way the
          // original spawn did.
          onActivity: () => {
            rt.desc.lastActivityAt = new Date().toISOString()
            schedulePersist()
          },
        })
        if (!fresh) {
          appendLine(
            rt,
            `[error] resume failed: adapter '${adapterSlug}' returned null`,
            "stderr"
          )
          recordFailedResume(rt)
          return
        }
        rt.agentSession = fresh
        rt.adapterSlug = adapterSlug
        rt.desc.adapterSessionId = fresh.sessionId
        // The resumed session is a fresh child process — refresh pid so
        // `processAlive` reflects the new process, not the dead one that
        // triggered this resume.
        rt.desc.pid = fresh.pid ?? null
        if (rt.desc.status !== "running") {
          rt.desc.status = "running"
          delete rt.desc.endedAt
          delete rt.desc.exitCode
          rt.emitter.emit("status", rt.desc.status)
        }
        schedulePersist()
        // Write point 2/3: adapterSessionId just refreshed post-resume —
        // the old id's native transcript stops growing, the new one starts.
        recordConversationLink(rt)
        // ── Interrupted-turn contract (§4) ──────────────────────────────
        // Announce the resume on the bus so watchers/policies learn the
        // session is promptable again (distinct from the session:exited that
        // marked its death). When it died with a turn IN FLIGHT under a daemon
        // restart, also warn — in the ring buffer AND durably in events.jsonl —
        // that the dropped turn was NOT re-run: this path never auto-retries a
        // prompt (its tool calls aren't idempotent), the caller must re-issue.
        // `killedMidTurn`/`endedReason` are left in place; the next successful
        // turn-end clears them (and with them the derived `interrupted` field).
        const interrupted =
          rt.desc.killedMidTurn === true &&
          rt.desc.endedReason === "daemon-restart"
        if (interrupted) {
          const banner =
            "── resumed after daemon restart; previous turn was interrupted " +
            "and was NOT re-run — re-prompt to continue ──"
          appendLine(rt, banner, "stdout")
          transcriptWriter.recordEvent(rt.desc.id, { kind: "notice", text: banner })
        }
        sessionEvents?.emit({
          type: "session:resumed",
          sessionId: rt.desc.id,
          interrupted,
          resumedFrom: "daemon-restart",
          ...(rt.desc.label ? { label: rt.desc.label } : {}),
          ts: new Date().toISOString(),
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        appendLine(rt, `[error] resume failed: ${msg}`, "stderr")
        recordFailedResume(rt)
      }
    })()
    try {
      await rt.resumePromise
    } finally {
      rt.resumePromise = undefined
    }
  }

  /**
   * Resolve a session's usage snapshot from the descriptor's accumulated
   * signals: the adapter-reported cost (readUsage or a usage_update cost
   * block) is authoritative; otherwise tokens are priced against the in-repo
   * catalog (`deriveSessionUsage`), or tagged no-pricing when the model is
   * unknown. Pure read of `rt` — mutation is the caller's job.
   */
  const buildUsageSnapshot = (rt: SessionRuntime): SessionUsage =>
    deriveSessionUsage({
      ...(rt.desc.model !== undefined ? { model: rt.desc.model } : {}),
      ...(rt.adapterReportedCost && rt.desc.costUsd !== undefined
        ? { adapterCostUsd: rt.desc.costUsd }
        : {}),
      ...(rt.desc.tokensIn !== undefined ? { tokensIn: rt.desc.tokensIn } : {}),
      ...(rt.desc.tokensOut !== undefined ? { tokensOut: rt.desc.tokensOut } : {}),
      ...(rt.desc.contextSize !== undefined ? { contextSize: rt.desc.contextSize } : {}),
      ...(rt.desc.contextUsed !== undefined ? { contextUsed: rt.desc.contextUsed } : {}),
    })

  /**
   * Write a final `usage_snapshot` recap when an agent session exits (kill,
   * turn error, cost-cap, shutdown). Stamps `usageSource` on the descriptor
   * and skips writing when there's nothing measured (`source: "none"`) so a
   * never-run session doesn't leave an empty transcript file. Must run BEFORE
   * `transcriptWriter.close(id)`.
   */
  const recordExitUsageSnapshot = (rt: SessionRuntime): void => {
    if (rt.desc.kind !== "agent-cli") return
    const usage = buildUsageSnapshot(rt)
    rt.desc.usageSource = usage.source
    if (usage.source === "none") return
    transcriptWriter.recordUsageSnapshot(rt.desc.id, usage)
  }

  const runAgentTurn = async (
    rt: SessionRuntime,
    message: unknown
  ): Promise<void> => {
    if (!rt.agentSession) {
      throw new Error("runAgentTurn: session has no agentSession")
    }
    // `if (!title)`, not "on turn 1": every session already running when this
    // shipped has already had its first prompt, so a turn-1-only check would
    // leave them unnamed forever. This way they self-heal on their NEXT
    // prompt — free, gradual adoption, no backfill. Never overwrites: a
    // conversation is named by what it was first about.
    //
    // `message` is the USER's turn text, NOT a role-prefixed composition — so
    // this derives the title from the actual ask. The one turn where `message`
    // *is* the composed prompt is a spawn's `initialPrompt` (it carries the
    // role disposition ahead of the caller's ask); the spawn path forecloses
    // that by stamping `SpawnAgentInput.title` from `input.prompt` up-front, so
    // `rt.desc.title` is already set and this line is skipped for that turn.
    if (!rt.desc.title) rt.desc.title = deriveSessionTitle(message)
    rt.busy = true
    rt.desc.busy = true             // mirror onto the public descriptor for session_monitor
    rt.emitter.emit("busy", true)
    rt.desc.awaitingInput = false  // clear stale awaiting-input flag from prior turn
    rt.desc.awaitingQuestion = undefined
    releaseBlockedOn(rt.desc)      // clear stale blocked-on from prior turn
    let turnCompleted = false
    // Whether the adapter itself emitted a `turn-end` during this turn.
    // Drives the P5 guarantee: when the event stream ends WITHOUT one
    // (crash / exit / error / abort), the finally block synthesizes a
    // terminal `turn-end` — but only if the adapter didn't already send
    // one, so exactly one is emitted per turn.
    let sawTurnEnd = false
    // Set in `catch` to the abnormal-end reason ("error" | "aborted") so
    // the finally block can tag the synthesized turn-end correctly.
    let abnormalReason: string | undefined
    // Captures the driver's reported `turn-end` reason (e.g.
    // "completed", "watchdog-timeout") so it can ride along on the
    // `session:turn-end` bus event below — otherwise it's dropped after
    // `projectEvent` renders it into the ring buffer.
    let turnEndReason: string | undefined
    // Productivity signals for empty-turn detection: a turn that produces
    // ZERO assistant text AND zero tool calls is a silent no-op (a bad /
    // unrecognized model id, or a provider that returned an empty
    // completion) and must be flagged, not reported as a green turn-end.
    let sawAssistantText = false
    let sawToolCall = false
    // Track tool-call IDs announced during this turn so the finally block can
    // emit synthetic tool-results for adapters that silently drop them.
    const pendingToolCallIds = new Set<string>()
    try {
      appendLine(
        rt,
        `\x1b[2m── ▶ ${typeof message === "string" ? message : JSON.stringify(message)} ──\x1b[0m`,
        "stdout"
      )
      transcriptWriter.recordPrompt(rt.desc.id, message)
      // ACP's `prompt` field expects ContentBlock[] (or a single
      // block). Hosts that send a raw string get auto-wrapped into
      // `{type: "text", text: "..."}` so callers can hand us
      // human-friendly prompts without shaping the wire format.
      const wrapped =
        typeof message === "string" ? { type: "text", text: message } : message
      for await (const evt of rt.agentSession.send(wrapped)) {
        // Capture the structured event to events.jsonl BEFORE
        // projectEvent flattens it into an ANSI ring-buffer line — the
        // only point downstream of the driver where the original
        // shape (tool arguments, plan entries, ...) still exists.
        transcriptWriter.recordEvent(rt.desc.id, evt)
        projectEvent(rt, evt)
        // `text-delta` is the sole assistant-text channel (see projectEvent);
        // a whitespace-only delta doesn't count as real output.
        if (evt.kind === "text-delta" && evt.text?.trim()) sawAssistantText = true
        else if (evt.kind === "tool-call") {
          sawToolCall = true
          if (evt.toolCallId) pendingToolCallIds.add(evt.toolCallId)
        }
        if (evt.kind === "tool-result" && evt.toolCallId) {
          pendingToolCallIds.delete(evt.toolCallId)
        }
        if (evt.kind === "turn-end") {
          sawTurnEnd = true
          turnEndReason = evt.reason
        }
      }
      turnCompleted = true
    } catch (err) {
      // A turn that ends by throwing is either a genuine error or an
      // ABORT (cancel()/kill()). Aborts must not be mislabelled as turn
      // errors — kill() already flipped status to "killed" and emitted
      // session:exited, and cancel() leaves the session alive for the
      // next turn — so only the genuine-error branch marks the session
      // errored. Either way the finally block below still guarantees a
      // terminal turn-end.
      if (isAbortError(err) || rt.desc.status === "killed") {
        abnormalReason = "aborted"
      } else {
        abnormalReason = "error"
        rt.desc.status = "error"
        rt.desc.endedAt = new Date().toISOString()
        appendLine(
          rt,
          `[turn error] ${err instanceof Error ? err.message : String(err)}`,
          "stderr"
        )
        recordExitUsageSnapshot(rt)
        schedulePersist()
        emitExited(rt)
      }
    } finally {
      rt.busy = false
      rt.desc.busy = false           // mirror onto the public descriptor for session_monitor
      rt.emitter.emit("busy", false)
      // Safety net: a tool-call that never receives its tool-result (child
      // crashed, stream ended early) must not leave the session flagged
      // blocked forever — the turn is over, nothing is pending anymore.
      releaseBlockedOn(rt.desc)

      // ── Synthetic tool-results for orphaned pending tool calls ─────────
      // Adapters that execute a tool but silently drop the matching
      // `tool_call_update status=completed` leave the tool card stuck
      // "pending" in every UI consumer. Emit a synthetic `tool-result`
      // before the turn-end so transcript reducers can resolve the segment.
      if (pendingToolCallIds.size > 0) {
        for (const toolCallId of pendingToolCallIds) {
          const synthetic: AgentStreamEvent = {
            kind: "tool-result",
            toolCallId,
            result: null,
            isError: false,
          }
          transcriptWriter.recordEvent(rt.desc.id, synthetic)
          projectEvent(rt, synthetic)
        }
        pendingToolCallIds.clear()
      }

      // ── P5: guarantee exactly one terminal turn-end per turn ──────────
      // If the adapter's event stream ended without a turn-end (generator
      // returned early, subprocess exited, threw, or was aborted), inject
      // one so downstream orchestration can rely on turn-end as a uniform
      // completion signal instead of hanging. Idempotent — `sawTurnEnd`
      // short-circuits when the adapter already produced one.
      if (!sawTurnEnd) {
        const reason =
          abnormalReason ??
          (rt.desc.status === "killed" ? "aborted" : "exited")
        const synthetic: AgentStreamEvent = { kind: "turn-end", reason }
        // Record to the durable transcript first (matches the in-loop
        // order: recordEvent before projectEvent), then flatten into the
        // ring buffer so /stream + events.jsonl consumers both see it.
        transcriptWriter.recordEvent(rt.desc.id, synthetic)
        projectEvent(rt, synthetic)
        sawTurnEnd = true
        turnEndReason = reason
      }

      if (turnCompleted) {
        // Record that a turn finished so a late `session_monitor` (subscribed
        // after a fast turn already ended) can still fast-return.
        rt.desc.turnsCompleted = (rt.desc.turnsCompleted ?? 0) + 1

        // ── Interrupted-turn contract (§4): a SUCCESSFUL turn-end clears the
        // daemon-restart interruption markers, so the derived `interrupted`
        // field (stampInterrupted) goes false — the session has demonstrably
        // recovered and is doing fresh work. Only clears when they're actually
        // set (a resumed-mid-turn row); a no-op for every ordinary turn.
        if (rt.desc.killedMidTurn || rt.desc.endedReason === "daemon-restart") {
          delete rt.desc.killedMidTurn
          delete rt.desc.endedReason
        }

        // ── Cap/backoff reset (§5): a turn that ran to completion proves the
        // session resumed cleanly, so the failed-resume backoff is cleared —
        // resumeAttempts goes back to 0 and lastResumeAt is dropped. Guarded so
        // it's a no-op for the overwhelming majority of turns that never failed
        // a resume (nothing to reset). Co-located with the interruption-marker
        // clear above: both express "this session has demonstrably recovered".
        if (rt.desc.resumeAttempts) {
          delete rt.desc.resumeAttempts
          delete rt.desc.lastResumeAt
        }

        // ── Cost refresh (best-effort) ───────────────────────────────
        // The adapter's own reader (e.g. hermes state.db) is authoritative —
        // a returned `costUsd` marks the session as adapter-priced.
        if (rt.readUsage) {
          try {
            const usage = await rt.readUsage()
            if (usage) {
              if (usage.costUsd !== undefined) {
                rt.desc.costUsd = usage.costUsd
                rt.adapterReportedCost = true
              }
              if (usage.tokensIn !== undefined) rt.desc.tokensIn = usage.tokensIn
              if (usage.tokensOut !== undefined) rt.desc.tokensOut = usage.tokensOut

              // Record a `usage_update` into the transcript so non-claude
              // adapters (hermes reads its state.db here; claude-code emits
              // this inline over ACP) carry the SAME token/cost telemetry in
              // events.jsonl. Only when the reader actually returned a signal
              // — never synthesize a usage event from nothing. Shape is
              // identical to the ACP-arm's usage_update: size/used default to
              // 0 (this reader carries no context-window figure, and
              // `projectEvent` guards on >0 so the 0s never clobber a real
              // size already mirrored onto the descriptor).
              if (
                usage.costUsd !== undefined ||
                usage.tokensIn !== undefined ||
                usage.tokensOut !== undefined
              ) {
                const usageEvent: AgentStreamEvent = {
                  kind: "usage_update",
                  size: 0,
                  used: 0,
                  ...(usage.costUsd !== undefined
                    ? { cost: { amount: usage.costUsd, currency: "USD" } }
                    : {}),
                  ...(usage.tokensIn !== undefined
                    ? { tokensIn: usage.tokensIn }
                    : {}),
                  ...(usage.tokensOut !== undefined
                    ? { tokensOut: usage.tokensOut }
                    : {}),
                }
                transcriptWriter.recordEvent(rt.desc.id, usageEvent)
              }
            }
          } catch {
            // best-effort — swallow
          }
        }

        // ── Resolve usage source (adapter / computed / no-pricing / none)
        //    and write the durable turn-boundary recap. Runs on every
        //    turn-end, even without a session-event bus wired.
        const usage = buildUsageSnapshot(rt)
        rt.desc.usageSource = usage.source
        rt.desc.costUsd = usage.costUsd
        transcriptWriter.recordUsageSnapshot(rt.desc.id, usage)

        // ── Cost cap (best-effort, turn-granular) ────────────────────
        const overBudget =
          rt.maxCostUsd !== undefined &&
          rt.desc.costUsd !== undefined &&
          rt.desc.costUsd > rt.maxCostUsd
        if (overBudget) {
          appendLine(
            rt,
            `[cost-cap] cost $${rt.desc.costUsd} exceeds max $${rt.maxCostUsd} — killing session`,
            "stderr",
          )
          rt.desc.status = "killed"
          rt.desc.endedAt = new Date().toISOString()
          void rt.agentSession?.close().catch(() => undefined)
          void transcriptWriter.close(rt.desc.id)
          tracedSessions.delete(rt.desc.id)
        }

        // ── Empty-turn detection (#1/#2) ─────────────────────────────
        // A turn that completed the normal way (stream ended, no error/
        // abort) yet produced NO assistant text, NO tool call, and isn't
        // awaiting input is a silent no-op — the usual cause is a bad or
        // unrecognized model id, or a provider that returned an empty
        // completion at $0. Flag it loudly (a warning line + `empty` on
        // the bus event) so an orchestrator doesn't mistake a green
        // turn-end for real progress.
        const emptyTurn =
          !sawAssistantText && !sawToolCall && !(rt.desc.awaitingInput ?? false)
        if (emptyTurn) {
          appendLine(
            rt,
            `\x1b[33m[warning] empty turn — no assistant output, no tool call, ` +
              `cost ${rt.desc.costUsd !== undefined ? `$${rt.desc.costUsd}` : "unknown"}. ` +
              `Likely an invalid model id or a provider that returned nothing; ` +
              `verify the model slug (agentproto models <adapter>).\x1b[0m`,
            "stderr",
          )
        }

        // ── Activity summary (secondary dynamic label) ───────────────
        // Regenerate the persisted "what is this session doing now" line
        // from the SAME heuristic `summarize_session` serves the overview
        // panel — no LLM. `regenerateActivitySummary` owns both invariants:
        // it never touches `title`, and it returns null (a no-op) for a
        // human-renamed session or one regenerated too recently (throttle).
        // Swap its body for a model call to upgrade the line later.
        const nextActivity = regenerateActivitySummary(rt.desc, rt.recentLines, Date.now())
        if (nextActivity) {
          rt.desc.activitySummary = nextActivity
          schedulePersist()
        }

        if (sessionEvents) {
          // No driver reports a structured "agent-prompt" today (every
          // currently-supported adapter auto-answers ACP permission
          // requests rather than surfacing them) — fall back to a
          // best-effort scan of the transcript tail so awaiting-input still
          // carries SOME signal beyond a bare boolean.
          if (rt.desc.awaitingInput && !rt.desc.awaitingQuestion) {
            rt.desc.awaitingQuestion = deriveHeuristicQuestion(rt.recentLines)
          }

          const ts = new Date().toISOString()
          sessionEvents.emit({
            type: "session:turn-end",
            sessionId: rt.desc.id,
            awaitingInput: rt.desc.awaitingInput ?? false,
            label: rt.desc.label,
            ts,
            ...(rt.desc.awaitingQuestion ? { question: rt.desc.awaitingQuestion } : {}),
            ...(turnEndReason ? { reason: turnEndReason } : {}),
            ...(emptyTurn ? { empty: true } : {}),
          })
          if (rt.desc.awaitingInput) {
            sessionEvents.emit({
              type: "session:awaiting-input",
              sessionId: rt.desc.id,
              label: rt.desc.label,
              ts,
              ...(rt.desc.awaitingQuestion ? { question: rt.desc.awaitingQuestion } : {}),
            })
          }
        }
        if (overBudget) emitExited(rt)
      } else {
        // ── Abnormal turn end (error / abort) ────────────────────────
        // The adapter's stream broke before a turn-end. We already
        // synthesized the terminal turn-end above; still stamp
        // turnsCompleted and emit the bus turn-end so a `session_monitor`
        // (or any consumer waiting on completion) doesn't hang on a turn
        // that will never signal done through the normal path.
        rt.desc.turnsCompleted = (rt.desc.turnsCompleted ?? 0) + 1
        if (sessionEvents) {
          sessionEvents.emit({
            type: "session:turn-end",
            sessionId: rt.desc.id,
            awaitingInput: rt.desc.awaitingInput ?? false,
            label: rt.desc.label,
            ts: new Date().toISOString(),
            ...(turnEndReason ? { reason: turnEndReason } : {}),
          })
        }
      }
    }
  }

  const wireOutputStreams = (rt: SessionRuntime): void => {
    const onChunk =
      (stream: "stdout" | "stderr") =>
      (chunk: Buffer | string): void => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8")
        for (const line of text.split(/\r?\n/)) {
          if (line.length > 0) appendLine(rt, line, stream)
        }
      }
    // Only called from spawn() which always sets rt.child — narrow
    // here so the stream listeners don't trip the optional-chain.
    if (!rt.child) return
    rt.child.stdout?.on("data", onChunk("stdout"))
    rt.child.stderr?.on("data", onChunk("stderr"))
  }

  return {
    spawn(input) {
      const id = input.id ?? `sess_${randomUUID().slice(0, 8)}`
      if (sessions.has(id)) {
        throw new Error(`sessions.spawn: id "${id}" already in use`)
      }
      const env = { ...process.env, ...(input.env ?? {}) }
      // Filter out Node bookkeeping that confuses subprocesses.
      delete env.NODE_OPTIONS
      const [bin, ...args] = input.argv
      if (!bin) throw new Error("sessions.spawn: argv must include a binary")
      // Close stdin by default — most agent CLIs spawn-and-prompt
      // (claude/codex/aider/etc.) read argv for the prompt and will
      // otherwise sit waiting for piped input. Caller opts in to a
      // writeable stdin via `keepStdin: true` (terminal/PTY kinds).
      const stdinMode = input.keepStdin ? "pipe" : "ignore"
      const child = spawn(bin, args, {
        cwd: input.cwd,
        env: env as NodeJS.ProcessEnv,
        stdio: [stdinMode, "pipe", "pipe"],
      })
      const desc: SessionDescriptor = {
        id,
        kind: input.kind,
        workspaceSlug: input.workspaceSlug,
        command: [bin, ...args].map(quoteArg).join(" "),
        pid: child.pid ?? null,
        status: "starting",
        startedAt: new Date().toISOString(),
        argv: input.argv,
        cwd: input.cwd,
        ...worktreeFields(input.cwd),
        ...(input.label ? { label: input.label } : {}),
      }
      const rt: SessionRuntime = {
        desc,
        child,
        recentLines: [],
        recentBytes: [],
        recentBytesSize: 0,
        emitter: new EventEmitter(),
        busy: false,
        textBuf: "",
        thoughtBuf: "",
      }
      // Don't crash the daemon when no listener is attached — the
      // emitter's "error" event would otherwise propagate.
      rt.emitter.setMaxListeners(50)

      sessions.set(id, rt)
      wireOutputStreams(rt)

      child.once("spawn", () => {
        desc.status = "running"
        rt.emitter.emit("status", desc.status)
        schedulePersist()
      })
      child.once("error", err => {
        desc.status = "error"
        desc.endedAt = new Date().toISOString()
        appendLine(rt, `[spawn error] ${err.message}`, "stderr")
        rt.emitter.emit("status", desc.status)
        schedulePersist()
        emitExited(rt)
      })
      child.once("exit", (code, signal) => {
        if (signal && desc.status !== "killed") desc.status = "killed"
        else if (desc.status === "running" || desc.status === "starting") {
          desc.status = "exited"
        }
        desc.endedAt = new Date().toISOString()
        if (typeof code === "number") desc.exitCode = code
        rt.emitter.emit("status", desc.status)
        schedulePersist()
        emitExited(rt)
      })
      schedulePersist()
      return desc
    },
    register(input) {
      if (sessions.has(input.id)) {
        // Already adopted (re-tracking is a noop). Return the
        // existing descriptor so callers don't have to special-case.
        const existing = sessions.get(input.id)
        if (existing) return existing.desc
      }
      const desc: SessionDescriptor = {
        id: input.id,
        kind: input.kind ?? "command",
        workspaceSlug: input.workspaceSlug,
        command: input.command,
        pid: input.child.pid ?? null,
        status: input.child.killed ? "killed" : "running",
        startedAt: new Date().toISOString(),
        ...(input.label ? { label: input.label } : {}),
      }
      const rt: SessionRuntime = {
        desc,
        child: input.child,
        recentLines: [],
        recentBytes: [],
        recentBytesSize: 0,
        emitter: new EventEmitter(),
        busy: false,
        textBuf: "",
        thoughtBuf: "",
      }
      rt.emitter.setMaxListeners(50)
      sessions.set(input.id, rt)
      wireOutputStreams(rt)
      // Wire exit so the descriptor flips when the adopted child
      // dies — same handlers as spawn() but registered post-hoc
      // because the child is already alive.
      input.child.once("exit", (code, signal) => {
        if (signal && desc.status !== "killed") desc.status = "killed"
        else if (desc.status === "running") desc.status = "exited"
        desc.endedAt = new Date().toISOString()
        if (typeof code === "number") desc.exitCode = code
        rt.emitter.emit("status", desc.status)
        schedulePersist()
        emitExited(rt)
      })
      input.child.once("error", err => {
        desc.status = "error"
        desc.endedAt = new Date().toISOString()
        appendLine(rt, `[child error] ${err.message}`, "stderr")
        rt.emitter.emit("status", desc.status)
        schedulePersist()
        emitExited(rt)
      })
      schedulePersist()
      return desc
    },
    spawnAgent(input) {
      const id = input.id ?? mintSessionId()
      const priorCommandSessionId = findPriorCommandSessionId(sessions, input.cwd)
      const desc: SessionDescriptor = {
        id,
        kind: "agent-cli",
        workspaceSlug: input.workspaceSlug,
        command: input.commandPreview ?? `${input.adapterSlug} (agent)`,
        pid: input.agentSession.pid ?? null,
        status: "running", // driver already started the session
        startedAt: new Date().toISOString(),
        cwd: input.cwd,
        ...worktreeFields(input.cwd),
        adapterSlug: input.adapterSlug,
        harness: input.harness ?? input.adapterSlug,
        // ACP-level session id — sticks across daemon restart so
        // `agentproto sessions restart <id>` can pass it as
        // `resumeSessionId` and the adapter reattaches to the prior
        // conversation rather than starting blank.
        adapterSessionId: input.agentSession.sessionId,
        ...(input.label ? { label: input.label } : {}),
        // Stamp the caller-derived title BEFORE `runAgentTurn` fires below, so
        // the self-heal there never claims the title from the composed prompt.
        ...(input.title ? { title: input.title } : {}),
        // A spawn `label` is NOT a user rename — flag it so the display chain
        // (`sessionDisplayName`) lets the derived `title` outrank it. Only
        // `renameSession` sets this `true`.
        ...(input.label ? { renamedByUser: false } : {}),
        // Persist the spawn-time MCP mounts so resume re-mounts the same
        // toolset (orchestrator WP1). Reference-only shape — no secrets.
        ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
        // Parent attribution + depth (orchestrator WP4). Depth is always
        // recorded (defaults to 0) so subtree/depth logic never has to
        // distinguish "absent" from "root".
        ...(input.parentSessionId
          ? { parentSessionId: input.parentSessionId }
          : {}),
        ...(input.origin ? { origin: input.origin } : {}),
        depth: input.depth ?? 0,
        // Spawn-time hints (e.g. `boardId`) — copied, not aliased, so a
        // caller mutating its own input map can't reach the descriptor.
        ...(input.meta ? { meta: { ...input.meta } } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.auth ? { auth: input.auth } : {}),
        // Decomposed config-axis echoes (SPEC §3.7), same optional-spread
        // shape as `model`/`mode`/`auth` above.
        ...(input.effort ? { effort: input.effort } : {}),
        ...(input.posture !== undefined ? { posture: input.posture } : {}),
        ...(input.route ? { route: input.route } : {}),
        ...(input.contextProfile ? { contextProfile: input.contextProfile } : {}),
        ...(input.accessProfile ? { accessProfile: input.accessProfile } : {}),
        ...(priorCommandSessionId ? { priorCommandSessionId } : {}),
        ...(input.remote ? { remote: true } : {}),
        ...(input.sandboxId ? { sandboxId: input.sandboxId } : {}),
        ...(input.sandboxTeardown ? { sandboxTeardown: input.sandboxTeardown } : {}),
        // Restart lineage (see SessionDescriptor.resumedFrom's doc). `resumeVia`
        // can legitimately be "" (a fresh fallback spawn with no continuity),
        // so it's gated on `!== undefined` rather than truthiness — a truthy
        // gate would silently drop the empty-string case.
        ...(input.resumedFrom ? { resumedFrom: input.resumedFrom } : {}),
        ...(input.resumeVia !== undefined ? { resumeVia: input.resumeVia } : {}),
      }
      if (input.trace ?? opts?.langfuseTracingDefault ?? false) {
        tracedSessions.add(id)
      }
      const rt: SessionRuntime = {
        desc,
        agentSession: input.agentSession,
        adapterSlug: input.adapterSlug,
        recentLines: [],
        recentBytes: [],
        recentBytesSize: 0,
        emitter: new EventEmitter(),
        busy: false,
        textBuf: "",
        thoughtBuf: "",
        maxCostUsd: input.maxCostUsd,
        costBudget: input.costBudget,
        readUsage: input.readUsage,
        ...(input.permissionHold ? { permissionHold: true } : {}),
      }
      rt.emitter.setMaxListeners(50)
      sessions.set(id, rt)
      // Lineage-attribution signal (WP-R3): announce the new session's parent
      // + depth the moment it's registered, so a live tree can nest it under
      // `parentSessionId` without waiting for its next snapshot poll. Rides the
      // same fan-out (EventRing → session_events_poll, webhook notifier) as
      // every other lifecycle event; best-effort, so a bus-less registry no-ops.
      sessionEvents?.emit({
        type: "session:spawned",
        sessionId: id,
        ...(desc.parentSessionId ? { parentSessionId: desc.parentSessionId } : {}),
        ...(desc.label ? { label: desc.label } : {}),
        depth: desc.depth ?? 0,
        ts: new Date().toISOString(),
      })
      appendLine(
        rt,
        `── ${input.adapterSlug} agent session ${input.agentSession.sessionId} (cwd ${input.cwd}) ──`,
        "stdout"
      )
      schedulePersist()
      // Write point 1/3: cwd/adapterSlug/adapterSessionId are all known
      // at spawn — record the link before the first turn even runs.
      recordConversationLink(rt)
      // Fire-and-forget the initial prompt (if any). Errors land in
      // the ring buffer + bump status to "error" but don't reject
      // the spawn — the descriptor was already returned.
      if (input.initialPrompt) {
        void runAgentTurn(rt, input.initialPrompt).catch(err => {
          appendLine(
            rt,
            `[turn error] ${err instanceof Error ? err.message : String(err)}`,
            "stderr"
          )
        })
      }
      return desc
    },
    spawnPty(input) {
      if (!ptyFactory) {
        throw new Error(
          "sessions.spawnPty: no PTY factory configured (node-pty optional dep missing in the daemon)"
        )
      }
      const id = `sess_${randomUUID().slice(0, 8)}`
      // Reject the name only when the prior holder is still alive —
      // killed/exited/error sessions keep their descriptor in the
      // registry for history, but their name is free to reuse so
      // `stop X && terminal --name X` round-trips cleanly.
      if (input.name) {
        for (const rt of sessions.values()) {
          if (rt.desc.name !== input.name) continue
          const status = rt.desc.status
          if (status === "running" || status === "starting") {
            throw new Error(
              `sessions.spawnPty: name "${input.name}" already in use by ${rt.desc.id} (status=${status})`,
            )
          }
          // Free the name on the dead session so id-or-name lookup
          // resolves to the NEW one. The old descriptor stays in the
          // registry (you can still find it by id in the list).
          rt.desc.name = undefined
        }
      }
      const [bin, ...args] = input.argv
      if (!bin) {
        throw new Error("sessions.spawnPty: argv must include a binary")
      }
      // node-pty forces its own minimal env unless we forward — pass
      // process.env merged with caller overrides. The factory layer
      // also forces TERM=xterm-256color so alt-screen apps render.
      const env = { ...(process.env as Record<string, string>), ...(input.env ?? {}) }
      delete env.NODE_OPTIONS
      const pty: PtyProcess = ptyFactory({
        command: bin,
        args,
        cwd: input.cwd,
        env,
        cols: input.cols,
        rows: input.rows,
      })
      const priorCommandSessionId = findPriorCommandSessionId(sessions, input.cwd)
      const desc: SessionDescriptor = {
        id,
        kind: "terminal",
        workspaceSlug: input.workspaceSlug,
        command: [bin, ...args].map(quoteArg).join(" "),
        pid: pty.pid,
        status: "running",
        startedAt: new Date().toISOString(),
        pty: true,
        argv: input.argv,
        cwd: input.cwd,
        ...worktreeFields(input.cwd),
        ...(input.name ? { name: input.name } : {}),
        ...(input.label ? { label: input.label } : {}),
        ...(priorCommandSessionId ? { priorCommandSessionId } : {}),
        // Parent attribution + depth (orchestrator WP4) — same recording
        // rule as spawnAgent above: depth always set so subtree/depth
        // logic never distinguishes "absent" from "root".
        ...(input.parentSessionId
          ? { parentSessionId: input.parentSessionId }
          : {}),
        ...(input.origin ? { origin: input.origin } : {}),
        depth: input.depth ?? 0,
        // Restart lineage — same gating rule as spawnAgent above (`resumeVia`
        // can legitimately be "").
        ...(input.resumedFrom ? { resumedFrom: input.resumedFrom } : {}),
        ...(input.resumeVia !== undefined ? { resumeVia: input.resumeVia } : {}),
      }
      const rt: SessionRuntime = {
        desc,
        pty,
        ptySubscribers: new Map(),
        recentLines: [],
        recentBytes: [],
        recentBytesSize: 0,
        emitter: new EventEmitter(),
        busy: false,
        textBuf: "",
        thoughtBuf: "",
      }
      rt.emitter.setMaxListeners(50)
      sessions.set(id, rt)
      // Lineage-attribution signal (WP-R3) — same rule as spawnAgent above.
      sessionEvents?.emit({
        type: "session:spawned",
        sessionId: id,
        ...(desc.parentSessionId ? { parentSessionId: desc.parentSessionId } : {}),
        ...(desc.label ? { label: desc.label } : {}),
        depth: desc.depth ?? 0,
        ts: new Date().toISOString(),
      })
      pty.onData((chunk: string) => {
        // node-pty emits utf-8 strings. Convert once at the boundary
        // so the ring buffer + emitter consumers all see Buffer.
        appendBytes(rt, Buffer.from(chunk, "utf8"))
      })
      pty.onExit(evt => {
        if (rt.desc.status !== "killed") {
          rt.desc.status = "exited"
        }
        rt.desc.endedAt = new Date().toISOString()
        if (typeof evt.exitCode === "number") rt.desc.exitCode = evt.exitCode
        rt.emitter.emit("exit", evt)
        rt.emitter.emit("status", rt.desc.status)
        void terminalTranscriptWriter.close(rt.desc.id)
        schedulePersist()
        emitExited(rt)
      })
      schedulePersist()
      return desc
    },
    recordCommand(input) {
      const id = `sess_${randomUUID().slice(0, 8)}`
      const now = new Date()
      // Backdate startedAt by durationMs — the command already ran to
      // completion by the time this is called, so this is the best
      // available estimate of when it actually started.
      const startedAt = new Date(now.getTime() - Math.max(0, input.durationMs)).toISOString()
      const argv = [input.command, ...input.args]
      const desc: SessionDescriptor = {
        id,
        kind: "command",
        workspaceSlug: input.workspaceSlug,
        command: argv.map(quoteArg).join(" "),
        pid: null,
        status: input.exitCode === 0 ? "exited" : "error",
        startedAt,
        endedAt: now.toISOString(),
        exitCode: input.exitCode,
        argv,
        cwd: input.cwd,
        ...(input.label ? { label: input.label } : {}),
        ...(input.origin ? { origin: input.origin } : {}),
        ...(input.callerSessionId ? { callerSessionId: input.callerSessionId } : {}),
      }
      const rt: SessionRuntime = {
        desc,
        recentLines: [],
        recentBytes: [],
        recentBytesSize: 0,
        emitter: new EventEmitter(),
        busy: false,
        textBuf: "",
        thoughtBuf: "",
      }
      sessions.set(id, rt)
      // Fire-and-forget: the write is best-effort and must never delay the
      // session's own lifecycle (its internal `.catch` swallows failures).
      // Chained (not parallel): the ToolCallRecord line must land AFTER the
      // CommandLogEntry line, because `readCommandLogEntry` trusts the
      // file's FIRST non-empty line to be the CommandLogEntry — two
      // independent fire-and-forget appendFile calls give no ordering
      // guarantee on their own.
      void writeCommandLogEntry(
        id,
        {
          ts: now.toISOString(),
          command: input.command,
          args: input.args,
          cwd: input.cwd,
          exitCode: input.exitCode,
          signal: input.signal,
          durationMs: input.durationMs,
          stdout: input.stdout,
          stderr: input.stderr,
          ...(input.truncated ? { truncated: true } : {}),
        },
        transcriptBaseDir,
      ).then(() =>
        writeToolCallRecord(
          {
            sessionId: id,
            tool: "command_execute",
            command: input.command,
            args: input.args,
            exitCode: input.exitCode,
            isError: input.exitCode !== 0,
            durationMs: input.durationMs,
            ts: now.toISOString(),
          },
          transcriptBaseDir,
        ),
      )
      schedulePersist()
      // No live process — the session is already over, so emit its
      // `session:exited` right away (mirrors kill()'s "agent-cli has no
      // OS exit event — emit here" rule just below).
      emitExited(rt)
      return desc
    },
    recordOpenedPr(sessionId, input) {
      const rt = sessions.get(sessionId)
      if (!rt) return undefined

      // A network reply can be lost after the forge accepted the create.
      // Repeating the reporting call must not manufacture a second
      // provenance link for the same PR.
      const existing = rt.desc.openedPrs ?? []
      if (!existing.some(pr => pr.adapter === input.adapter && pr.url === input.url)) {
        rt.desc.openedPrs = [
          ...existing,
          {
            adapter: input.adapter,
            number: input.number,
            url: input.url,
            openedAt: new Date().toISOString(),
          },
        ]
        schedulePersist()
      }
      return rt.desc
    },
    async readCommandLog(sessionId) {
      const rt = sessions.get(sessionId)
      if (!rt || rt.desc.kind !== "command") return null
      return readCommandLogEntry(sessionId, transcriptBaseDir)
    },
    async readToolCallRecords(sessionId) {
      return readToolCallRecordLines(sessionId, transcriptBaseDir)
    },
    async readUsageSnapshots(sessionId) {
      return readUsageSnapshotLines(sessionId, transcriptBaseDir)
    },
    registerBrowser(input) {
      const inputLocation = input.location ?? "local"
      // Idempotent: reuse an alive session for the same (adapterId, port, location).
      // Location is part of the key so a cloud call never returns a local session.
      for (const rt of sessions.values()) {
        if (
          rt.desc.kind === "browser" &&
          rt.desc.browserAdapterId === input.adapterId &&
          rt.desc.browserPort === input.port &&
          (rt.desc.browserLocation ?? "local") === inputLocation &&
          (rt.desc.status === "running" || rt.desc.status === "starting")
        ) {
          // Update label on idempotent hit so callers can stamp correlation
          // context (guild/op/workItem) onto a long-lived browser session.
          if (input.label !== undefined) {
            rt.desc.label = input.label
            schedulePersist()
          }
          return rt.desc
        }
      }
      const id = `sess_${randomUUID().slice(0, 8)}`
      const desc: SessionDescriptor = {
        id,
        kind: "browser",
        workspaceSlug: "",
        command: `${input.adapterId} (browser)`,
        pid: input.pid ?? null,
        status: input.status ?? "running",
        startedAt: new Date().toISOString(),
        browserAdapterId: input.adapterId,
        browserPort: input.port,
        browserBaseUrl: input.baseUrl,
        browserLocation: inputLocation,
        ...(input.label ? { label: input.label } : {}),
      }
      const rt: SessionRuntime = {
        desc,
        browserStop: input.stop,
        recentLines: [],
        recentBytes: [],
        recentBytesSize: 0,
        emitter: new EventEmitter(),
        busy: false,
        textBuf: "",
        thoughtBuf: "",
      }
      rt.emitter.setMaxListeners(50)
      sessions.set(id, rt)
      schedulePersist()
      return desc
    },
    async sendPrompt(id, message, opts) {
      const rtPre = sessions.get(id)
      // Same mid-turn arm as enqueuePrompt: cancel + await settle BEFORE
      // admission, so `validateAgentTurn` finds the session idle instead
      // of throwing the busy rejection. Without this, `interrupt` was
      // silently dropped on the blocking path — the caller asked to
      // redirect the session and got a 409 (or, worse, nothing).
      if (opts?.interrupt && rtPre?.busy) {
        await interruptInFlightTurn(rtPre, id, "sendPrompt")
      }
      if (rtPre) await maybeResumeAgent(rtPre)
      const rt = validateAgentTurn(id, "sendPrompt")
      await runAgentTurn(rt, message)
    },
    async enqueuePrompt(id, message, opts) {
      // Admission phase — AWAITED, unlike the turn itself below. This
      // is what makes `{queued: true}` truthful: a dead (exited/
      // killed/error) session gets one resume attempt, then
      // validateAgentTurn throws `SessionNotAliveError` (or the busy /
      // wrong-kind errors) synchronously enough for the caller (MCP
      // `agent_prompt`, HTTP `?wait=false`) to surface it instead of
      // reporting success for a prompt that will never be dispatched.
      const rtPre = sessions.get(id)
      if (!rtPre) {
        throw new Error(`enqueuePrompt: no session "${id}"`)
      }
      // `interrupt` only ever changes behavior on a mid-turn session —
      // an idle session falls straight through to the normal admission
      // path below, byte-identical to `interrupt` omitted/false. Cancel
      // THEN await the turn actually settling (busy → false) BEFORE
      // `validateAgentTurn` runs, so admission is never bypassed — it's
      // only ever reached once the prior turn is genuinely over.
      if (opts?.interrupt && rtPre.busy) {
        await interruptInFlightTurn(rtPre, id, "enqueuePrompt")
      }
      await maybeResumeAgent(rtPre)
      const rt = validateAgentTurn(id, "enqueuePrompt")
      // Execution phase — fire-and-forget from here on. Errors during
      // the turn itself (network drop, child died mid-turn) land in
      // the ring buffer as `[error]` lines so the SSE consumer sees
      // them; admission already succeeded so there's nothing else to
      // report back to the original caller.
      void runAgentTurn(rt, message).catch(err => {
        appendLine(
          rtPre,
          `[error] ${err instanceof Error ? err.message : String(err)}`,
          "stderr"
        )
      })
    },
    async resumeOnBoot(id) {
      const rt = sessions.get(id)
      if (!rt) return { status: "skipped", reason: "unknown" }
      // Idempotent: a row already resumed (this pass or a lazy prompt that
      // raced boot) has nothing to do — never a second spawn.
      if (rt.agentSession) return { status: "skipped", reason: "already-live" }
      // Base eligibility (§5): agent-cli with the resume essentials and not
      // archived. PTY/command/archived rows are never in-place resumable.
      if (!isResumable(rt.desc)) return { status: "skipped", reason: "not-resumable" }
      // Eager-only clause layered on top of the base predicate (§5): the boot
      // pass resurrects ONLY rows the daemon restart itself killed. Operator
      // kills, natural exits, and errors keep the base `isResumable` shape but
      // are deliberately left dead — the lazy prompt path still honours an
      // explicit re-prompt of them, this automatic pass does not.
      if (rt.desc.endedReason !== "daemon-restart") {
        return { status: "skipped", reason: "not-daemon-restart" }
      }
      // Attempt cap (§5): a row that's already burned MAX_RESUME_ATTEMPTS
      // never spawns again — the persisted counter is what bounds a launchd
      // crash-loop across boots (skip, don't count a further attempt).
      if (!canResume(rt.desc)) return { status: "skipped", reason: "cap-exhausted" }
      // Worktree re-association (§5). `cwd` was already required by
      // `isResumable`, so the non-null assertions below are narrowing only.
      const cwd = rt.desc.cwd!
      // (a) cwd gone (worktree GC'd/removed between death and this boot):
      // fail clean and COUNT an attempt — the same debt a spawn into a missing
      // dir would incur, so a permanently-gone worktree can't be retried on
      // every boot forever.
      if (!existsSync(cwd)) {
        appendLine(
          rt,
          `[error] resume skipped: worktree gone — ${cwd} no longer exists; ` +
            `use session_restart with a fresh cwd`,
          "stderr"
        )
        recordFailedResume(rt)
        return { status: "failed", reason: "cwd-missing" }
      }
      // (b) worktreeId pinned but the marker at cwd names a different
      // generation (or is unmarked now): refuse — resuming into the wrong
      // generation would attach the conversation to someone else's checkout.
      // No attempt counted: nothing is broken about the session, the path is
      // just occupied by a different worktree.
      if (rt.desc.worktreeId) {
        const current = resolveWorktreeIdentity(cwd)
        if (current?.worktreeId !== rt.desc.worktreeId) {
          appendLine(
            rt,
            `[error] resume skipped: worktree at ${cwd} is a different ` +
              `generation (${current?.worktreeId ?? "unmarked"} ≠ ` +
              `${rt.desc.worktreeId}); use session_restart`,
            "stderr"
          )
          return { status: "skipped", reason: "worktree-generation-mismatch" }
        }
      }
      // Same code path as the lazy trigger — auth re-resolution, event/banner,
      // and the attempt counter all live inside it. `canResume` was already
      // true above so it won't throw ResumeDisabledError; on adapter refusal it
      // records a failed attempt and returns WITHOUT fresh-spawning, exactly the
      // no-fresh-spawn rule the eager pass needs.
      await maybeResumeAgent(rt)
      return rt.agentSession
        ? { status: "resumed" }
        : { status: "failed", reason: "resume-failed" }
    },
    async interruptSession(id) {
      const rt = sessions.get(id)
      if (!rt) throw new Error(`interruptSession: no session "${id}"`)
      // Same liveness definition as `validateAgentTurn` — a terminal
      // session is a no-op even if `busy` hasn't been flipped false yet
      // (kill() doesn't clear it; `runAgentTurn`'s finally does, and that
      // may not have run yet for a session killed mid-turn).
      const isAlive = rt.desc.status === "running" || rt.desc.status === "starting"
      if (!isAlive || !rt.busy) return { wasBusy: false }
      await interruptInFlightTurn(rt, id, "interruptSession")
      return { wasBusy: true }
    },
    async setModel(id, modelId) {
      const rt = sessions.get(id)
      if (!rt) throw new Error(`setModel: no session "${id}"`)
      if (rt.desc.kind !== "agent-cli" || !rt.agentSession) {
        throw new Error(`setModel: session "${id}" is not an agent-cli session`)
      }
      // Model↔route guard (SPEC risk R2 / §4.4). A live `setModel` can only
      // change the model within the current route — the route is a spawn-time
      // `ANTHROPIC_BASE_URL`, not a live ACP config option. If the requested
      // model's route-identity crosses the session's current route/vendor
      // boundary, refuse the live switch rather than silently keeping the old
      // endpoint (the "pick a gateway model live, keep the old billing rail"
      // hole), and hand back the override a restart-with-override should carry.
      // Lenient by construction: the guard fires ONLY when BOTH the current and
      // target routes are known AND differ — bare/unparseable ids (no `@route`,
      // no vendor slash) leave the route unknown and fall through to a normal
      // live switch, so this never blocks a same-endpoint model change.
      const targetRoute = tryParseModelRef(modelId)?.route
      const currentRoute = currentRouteOf(rt.desc)
      if (targetRoute && currentRoute && targetRoute !== currentRoute) {
        return {
          applied: false,
          reason: "requires-restart",
          suggestedOverride: { route: { gateway: targetRoute }, model: modelId },
        }
      }
      if (!rt.agentSession.setModel) {
        return { applied: false, reason: "not-supported" }
      }
      const result = await rt.agentSession.setModel(modelId)
      if (result.applied) {
        rt.desc.model = result.model ?? modelId
        schedulePersist()
        if (sessionEvents) {
          const ts = new Date().toISOString()
          // Axis-generic notification (SPEC step 4) — the shared event that
          // live-effort/posture (step 5) and restart-override (step 6) also emit.
          sessionEvents.emit({
            type: "session:config-changed",
            sessionId: id,
            axis: "model",
            value: rt.desc.model,
            label: rt.desc.label,
            ts,
          })
          // Back-compat alias — kept so existing `session:model-changed`
          // subscribers keep working (SPEC step 4).
          sessionEvents.emit({
            type: "session:model-changed",
            sessionId: id,
            model: rt.desc.model,
            label: rt.desc.label,
            ts,
          })
        }
      }
      return result
    },
    emitConfigChanged(ev) {
      // Best-effort forward — restart-with-override (session-restart-core.ts)
      // builds the typed event off the NEW descriptor's axis value; the
      // registry only owns the bus, not the event shape.
      sessionEvents?.emit(ev)
    },
    async setEffort(id, effort) {
      const rt = sessions.get(id)
      if (!rt) throw new Error(`setEffort: no session "${id}"`)
      if (rt.desc.kind !== "agent-cli" || !rt.agentSession) {
        throw new Error(`setEffort: session "${id}" is not an agent-cli session`)
      }
      if (!rt.agentSession.setEffort) {
        return { applied: false, reason: "not-supported" }
      }
      const result = await rt.agentSession.setEffort(effort)
      if (result.applied) {
        // The label the wrapper accepted (`result.effort`) is authoritative;
        // fall back to the requested one. Cast: the ACP surface speaks a bare
        // string and the descriptor's echo is the `EffortLevel` superset (SPEC
        // §3.1) — a model-specific value outside the union is still recorded
        // as-echoed rather than dropped.
        rt.desc.effort = (result.effort ?? effort) as EffortLevel
        schedulePersist()
        if (sessionEvents) {
          sessionEvents.emit({
            type: "session:config-changed",
            sessionId: id,
            axis: "effort",
            value: rt.desc.effort,
            label: rt.desc.label,
            ts: new Date().toISOString(),
          })
        }
      }
      return result
    },
    async setPosture(id, posture) {
      const rt = sessions.get(id)
      if (!rt) throw new Error(`setPosture: no session "${id}"`)
      if (rt.desc.kind !== "agent-cli" || !rt.agentSession) {
        throw new Error(`setPosture: session "${id}" is not an agent-cli session`)
      }
      // Resolve the requested posture against the harness's advertised modes
      // (#482 read-surface). Native ⇒ switch live via `setSessionMode`; anything
      // else (prompt-injected / env / a raw mode the session no longer
      // advertises) is NOT forced live — it rides the system prompt or spawn
      // env, so it needs a fresh spawn (SPEC §3.4a/§4.2). We hand back
      // `requires-restart` and let the caller route it through the
      // restart-with-override path (step 6, not implemented here).
      const resolution = resolvePosture(posture, rt.agentSession.availableModes ?? [])
      if (resolution.kind !== "native") {
        return {
          applied: false,
          reason: "requires-restart",
          resolution: resolution.kind,
        }
      }
      if (!rt.agentSession.setSessionMode) {
        return { applied: false, reason: "not-supported", resolution: "native" }
      }
      const result = await rt.agentSession.setSessionMode(resolution.mode.id)
      if (!result.applied) {
        return {
          applied: false,
          resolution: "native",
          ...(result.reason ? { reason: result.reason } : {}),
        }
      }
      rt.desc.posture = posture
      schedulePersist()
      if (sessionEvents) {
        sessionEvents.emit({
          type: "session:config-changed",
          sessionId: id,
          axis: "posture",
          value: posture,
          label: rt.desc.label,
          ts: new Date().toISOString(),
        })
      }
      return { applied: true, posture, modeId: resolution.mode.id, resolution: "native" }
    },
    pulseActivity(id) {
      const rt = sessions.get(id)
      if (!rt) return
      rt.desc.lastActivityAt = new Date().toISOString()
      schedulePersist()
    },
    list(opts) {
      const includeArchived = opts?.includeArchived ?? false
      return Array.from(sessions.values())
        .map(s => s.desc)
        .filter(desc => includeArchived || !desc.archived)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .map(desc => {
          stampProcessAlive(desc)
          stampInterrupted(desc)
          return desc
        })
    },
    get(id) {
      const desc = sessions.get(id)?.desc
      if (desc) {
        stampProcessAlive(desc)
        stampInterrupted(desc)
      }
      return desc
    },
    attach(id, onLine) {
      const rt = sessions.get(id)
      if (!rt) return null
      // Backfill: synchronously replay the ring buffer so attaches
      // see the recent context, then subscribe for new lines.
      for (const line of rt.recentLines) onLine(line, "stdout")
      const handler = (evt: {
        line: string
        stream: "stdout" | "stderr"
      }): void => onLine(evt.line, evt.stream)
      rt.emitter.on("line", handler)
      return () => rt.emitter.off("line", handler)
    },
    subscribeToRecords(id, onRecord) {
      return baseTranscriptWriter.subscribe(id, onRecord)
    },
    attachPty(id, initial, onData, onExit) {
      const rt = sessions.get(id)
      if (!rt || !rt.pty || !rt.ptySubscribers) return null
      // Backfill: flush the byte ring buffer so a fresh attach lands
      // on the recent screenful. Alt-screen apps repaint on next
      // input but a snapshot is still better than blank.
      for (const chunk of rt.recentBytes) onData(chunk)
      // Subscriber registration: a monotonically-growing key so the
      // size map can hold the per-subscriber dims and detach is O(1).
      const subId = nextSubId++
      rt.ptySubscribers.set(subId, { cols: initial.cols, rows: initial.rows })
      reconcilePtySize(rt)
      const dataHandler = (chunk: Buffer): void => onData(chunk)
      const exitHandler = (evt: {
        exitCode: number
        signal?: number
      }): void => onExit(evt)
      rt.emitter.on("data", dataHandler)
      rt.emitter.once("exit", exitHandler)
      return {
        write(data: string): void {
          if (!rt.pty) return
          try {
            rt.pty.write(data)
          } catch {
            // PTY already exited — drop the input silently.
          }
        },
        resize(cols: number, rows: number): void {
          if (!rt.ptySubscribers) return
          rt.ptySubscribers.set(subId, { cols, rows })
          reconcilePtySize(rt)
        },
        detach(): void {
          rt.emitter.off("data", dataHandler)
          rt.emitter.off("exit", exitHandler)
          rt.ptySubscribers?.delete(subId)
          reconcilePtySize(rt)
        },
      }
    },
    findByIdOrName(query) {
      const direct = sessions.get(query)
      if (direct) {
        stampProcessAlive(direct.desc)
        stampInterrupted(direct.desc)
        return direct.desc
      }
      for (const rt of sessions.values()) {
        if (rt.desc.name === query) {
          stampProcessAlive(rt.desc)
          stampInterrupted(rt.desc)
          return rt.desc
        }
      }
      return undefined
    },
    writeTerminalInput(id, data) {
      const rt = sessions.get(id)
      if (!rt || !rt.pty) return false
      try {
        rt.pty.write(data)
        return true
      } catch {
        return false
      }
    },
    readTerminalOutput(id, lastBytes) {
      const rt = sessions.get(id)
      if (!rt || !rt.pty) return null
      const joined = Buffer.concat(rt.recentBytes, rt.recentBytesSize)
      if (typeof lastBytes === "number" && lastBytes > 0 && joined.byteLength > lastBytes) {
        return joined.subarray(joined.byteLength - lastBytes)
      }
      return joined
    },
    kill(id, signal = "SIGTERM") {
      const rt = sessions.get(id)
      if (!rt) return false
      if (
        rt.desc.status === "exited" ||
        rt.desc.status === "killed" ||
        rt.desc.status === "error"
      ) {
        return false
      }
      // Read BEFORE the flip below — see killedMidTurn's docblock: this is
      // the one moment `busy` is still guaranteed live, not whatever it was
      // last set to by a `finally` that may never run again.
      rt.desc.killedMidTurn = rt.desc.busy === true
      rt.desc.status = "killed"
      rt.desc.endedAt = new Date().toISOString()
      // Close agent session first (graceful protocol shutdown), then
      // SIGTERM the underlying child/pty if any. Either branch is a
      // best-effort — the descriptor flip is what the UI surfaces.
      if (rt.agentSession) {
        // Durable usage recap on exit — before close() flushes the stream.
        recordExitUsageSnapshot(rt)
        void rt.agentSession.close().catch(() => undefined)
        void transcriptWriter.close(rt.desc.id)
        tracedSessions.delete(rt.desc.id)
      }
      if (rt.pty) {
        try {
          rt.pty.kill(signal)
        } catch {
          // pty already gone — fall through
        }
        void terminalTranscriptWriter.close(rt.desc.id)
      }
      rt.child?.kill(signal)
      if (rt.browserStop) {
        void rt.browserStop().catch(() => undefined)
      }
      schedulePersist()
      // Agent-cli sessions have no OS exit event — emit here.
      // Child/PTY sessions emit from their exit handlers; the
      // exitedEmitted guard prevents a duplicate from kill() AND exit.
      emitExited(rt)
      return true
    },
    reapIdle(id, idleMs = 0) {
      const rt = sessions.get(id)
      if (!rt) return false
      // Only a LIVE agent-cli row is reapable. A PTY/command/terminal/browser
      // session, or one already terminal, must never be idle-reaped — reaping
      // is an agent-cli-only, lazy-resume-preserving teardown. The sweep
      // already filters for this; the guard keeps the primitive honest for any
      // caller.
      if (rt.desc.kind !== "agent-cli" || rt.desc.status !== "running") {
        return false
      }
      // Read `busy` before the flip (see killedMidTurn's docblock) — a reap
      // only targets an idle session, so this is false in practice, but capture
      // the honest value rather than assume it.
      rt.desc.killedMidTurn = rt.desc.busy === true
      rt.desc.status = "killed"
      rt.desc.endedAt = new Date().toISOString()
      // The one field that makes this a REAP, not a plain kill: an automatic
      // teardown reason that (a) surfaces "reaped while idle" in the UI and (b)
      // — critically — keeps this row OUT of the eager resume-on-boot pass,
      // which gates on `endedReason === "daemon-restart"`. A reaped row must
      // never join a boot-time resume-storm of dead work.
      rt.desc.endedReason = "idle-reaped"
      if (rt.agentSession) {
        // Durable usage recap on exit — before close() flushes the stream.
        recordExitUsageSnapshot(rt)
        void rt.agentSession.close().catch(() => undefined)
        void transcriptWriter.close(rt.desc.id)
        tracedSessions.delete(rt.desc.id)
        // THE difference from kill(): drop the (now-closed) binding so the row
        // is lazy-resumable in the SAME daemon lifetime. `maybeResumeAgent`
        // early-returns while `rt.agentSession` is set (kill() leaves it
        // referencing the closed object), so a reap that didn't clear it would
        // leave a dead session no prompt could revive. adapterSessionId/cwd stay
        // on the descriptor, so `isResumable` still holds.
        rt.agentSession = undefined
      }
      // No PTY/child for an agent-cli row spawned via spawnAgent (the driver
      // owns the process, torn down by close() above), but a registered/adopted
      // one may carry a child — SIGTERM it best-effort, same as kill().
      rt.child?.kill("SIGTERM")
      schedulePersist()
      const banner =
        "── reaped after being idle past the threshold; the adapter process was " +
        "freed. Re-prompt to resume this session in place. ──"
      appendLine(rt, banner, "stdout")
      transcriptWriter.recordEvent(rt.desc.id, { kind: "notice", text: banner })
      // The reaper-specific signal (names the actor + carries how long it was
      // idle) …
      sessionEvents?.emit({
        type: "session:reaped",
        sessionId: rt.desc.id,
        idleMs,
        ...(rt.desc.label ? { label: rt.desc.label } : {}),
        ts: new Date().toISOString(),
      })
      // … alongside the usual lifecycle exit (carrying reason:"idle-reaped" via
      // emitExited, which reads desc.endedReason) so existing session:exited
      // consumers still see the row leave "running".
      emitExited(rt)
      return true
    },
    archiveSession(id) {
      const rt = sessions.get(id)
      if (!rt) throw new Error(`archiveSession: no session "${id}"`)
      // Same liveness definition as `validateAgentTurn`/`kill()` — a
      // still-alive session must be refused rather than silently hidden
      // from the daemon's own default view while it keeps running.
      const isAlive = rt.desc.status === "running" || rt.desc.status === "starting"
      if (isAlive) {
        throw new Error(
          `archiveSession: session "${id}" is still ${rt.desc.status} — only a ` +
            "terminal-status session (exited/killed/error) can be archived."
        )
      }
      rt.desc.archived = true
      schedulePersist()
      stampProcessAlive(rt.desc)
      return rt.desc
    },
    unarchiveSession(id) {
      const rt = sessions.get(id)
      if (!rt) throw new Error(`unarchiveSession: no session "${id}"`)
      rt.desc.archived = false
      schedulePersist()
      stampProcessAlive(rt.desc)
      return rt.desc
    },
    gcSessions(opts) {
      const cutoff =
        opts.olderThanDays !== undefined && opts.olderThanDays > 0
          ? Date.now() - opts.olderThanDays * 86_400_000
          : undefined
      const ids = []
      for (const [id, rt] of sessions) {
        if (opts.onlyIds && !opts.onlyIds.has(id)) continue
        const st = rt.desc.status
        if (st === "running" || st === "starting") continue // never GC a live session
        if (cutoff !== undefined) {
          const tsStr = rt.desc.endedAt ?? rt.desc.startedAt
          const ts = tsStr ? Date.parse(tsStr) : Number.NaN
          if (Number.isFinite(ts) && ts > cutoff) continue // too recent — keep
        }
        if (opts.forget) sessions.delete(id)
        else rt.desc.archived = true
        ids.push(id)
      }
      if (ids.length > 0) schedulePersist()
      return { mode: opts.forget ? "forgotten" : "archived", ids, count: ids.length }
    },
    renameSession(id, patch) {
      const rt = sessions.get(id)
      if (!rt) throw new Error(`renameSession: no session "${id}"`)
      // Each field: undefined ⇒ leave as-is; null / empty-or-whitespace ⇒
      // clear (revert to the derived title / friendly fallback); otherwise
      // trim and cap to the SAME bound the derivation uses (by code point, so
      // an astral char at the boundary isn't split into an orphan surrogate).
      const apply = (field: "title" | "label"): void => {
        const raw = patch[field]
        if (raw === undefined) return
        const trimmed = raw === null ? "" : raw.trim()
        if (trimmed === "") {
          rt.desc[field] = undefined
          return
        }
        const points = Array.from(trimmed)
        rt.desc[field] =
          points.length > TITLE_MAX_LENGTH ? points.slice(0, TITLE_MAX_LENGTH).join("") : trimmed
      }
      apply("title")
      apply("label")
      // This IS the explicit-user-rename write-path (both callers —
      // `PATCH /sessions/:id` and the `session_rename` MCP verb — are
      // human-driven). Flag it so a user's `label` outranks the derived
      // `title` in `sessionDisplayName`; a spawn `label`, set by `spawnAgent`
      // with `renamedByUser: false`, does not.
      rt.desc.renamedByUser = true
      schedulePersist()
      // Announce it so a live UI repaints the name without waiting for its
      // next snapshot poll — same bus every other lifecycle event rides.
      // Fields are included only when set, so a clear reads as "absent" the
      // same way the descriptor now does.
      sessionEvents?.emit({
        type: "session:renamed",
        sessionId: id,
        ...(rt.desc.title !== undefined ? { title: rt.desc.title } : {}),
        ...(rt.desc.label !== undefined ? { label: rt.desc.label } : {}),
        renamedByUser: true,
        ts: new Date().toISOString(),
      })
      stampProcessAlive(rt.desc)
      return rt.desc
    },
    listPendingPermissions(filter) {
      const all = Array.from(pendingPermissions.values())
      const scoped = filter?.sessionId
        ? all.filter(p => p.sessionId === filter.sessionId)
        : all
      // Defensive copies — callers must not mutate the live inbox records.
      return scoped.map(p => ({ ...p, options: p.options.map(o => ({ ...o })) }))
    },
    respondPermission(id, input) {
      return resolvePendingPermission(id, input)
    },
    forget(id) {
      const rt = sessions.get(id)
      if (!rt) return false
      // Don't leak: tear down the emitter so backfill listeners stop.
      rt.emitter.removeAllListeners()
      void transcriptWriter.close(id)
      void terminalTranscriptWriter.close(id)
      tracedSessions.delete(id)
      sessions.delete(id)
      schedulePersist()
      return true
    },
    shutdown() {
      shutdownImpl()
    },
  }

  /**
   * The actual shutdown logic, hoisted so both the explicit
   * `shutdown()` method AND the `process.on("exit")` safety net
   * can call it. Sync (no awaits) so it works in the `exit` event
   * handler.
   *
   * Idempotent — `serve --interactive` calls gateway.stop() twice in
   * some Ctrl-C race paths (parent SIGINT handler + the child-exit
   * promise both fire), and `process.on("exit")` ALSO fires at the
   * end of every termination path. Without the guard, the second
   * call clears the already-empty sessions Map and writes an empty
   * snapshot back to sessions.json, wiping history.
   */
  function shutdownImpl(): void {
    if (shutdownDone) return
    shutdownDone = true
    if (persistTimer) clearTimeout(persistTimer)
    if (persist) {
      try {
        process.off("exit", onProcessExit)
      } catch {
        // ignore — handler may not be installed
      }
    }
    // Mark any still-alive sessions as killed BEFORE the final
    // flush so the snapshot accurately reflects what happened. On
    // the next boot, load reads these and we won't have to guess
    // ("was running last time → assume killed" is then a no-op).
    //
    // These sessions are being force-killed OUTSIDE their own turn loop —
    // `runAgentTurn`'s `finally` (which normally clears busy/awaiting-*)
    // never runs here, so without `clearInFlightFlags` a session that was
    // mid-turn at shutdown would persist as "killed" yet forever "busy".
    // `emitExited` announces the same way `kill()` does, so a watcher
    // subscribed to `sessionEvents` (or polling after reconnect) learns
    // these died with the daemon instead of finding out by accident.
    const nowIso = new Date().toISOString()
    for (const rt of sessions.values()) {
      rt.emitter.removeAllListeners()
      if (
        rt.desc.status === "running" ||
        rt.desc.status === "starting"
      ) {
        rt.desc.status = "killed"
        rt.desc.endedAt = nowIso
        rt.desc.endedReason = "daemon-restart"
        // Same "read busy before it's cleared" rule as kill() — see
        // killedMidTurn's docblock. clearInFlightFlags below zeroes busy
        // right after, so this is the last honest look at it.
        rt.desc.killedMidTurn = rt.desc.busy === true
        clearInFlightFlags(rt.desc)
        if (rt.agentSession) {
          recordExitUsageSnapshot(rt)
          void rt.agentSession.close().catch(() => undefined)
        }
        if (rt.pty) {
          try {
            rt.pty.kill("SIGTERM")
          } catch {
            // already exited
          }
        }
        rt.child?.kill("SIGTERM")
        emitExited(rt)
      }
    }
    void transcriptWriter.closeAll()
    void terminalTranscriptWriter.closeAll()
    // Sync flush so quick sessions (spawned + ended in less than
    // PERSIST_DEBOUNCE_MS) aren't lost. The debounced async write
    // may have been cancelled by clearTimeout above, but a 200-byte
    // sync write at shutdown is cheap and the data needs to land.
    if (persist) {
      try {
        if (partitioned) {
          for (const [slug, rows] of groupRowsByBucket()) {
            writeBucketSnapshotSync(bucketsRoot, slug, {
              savedAt: nowIso,
              sessions: rowsToWrite(slug, rows),
            })
          }
        } else {
          const snapshot = { savedAt: nowIso, sessions: snapshotRows() }
          mkdirSync(dirname(legacyPath), { recursive: true })
          writeFileSync(legacyPath, JSON.stringify(snapshot, null, 2) + "\n")
        }
      } catch {
        // best-effort — same policy as the async path
      }
    }
    sessions.clear()
  }
}

/**
 * Reset the ephemeral in-flight fields a descriptor accumulates mid-turn
 * (busy, awaiting-input/-question/-permission, blockedOn) back to idle.
 * `runAgentTurn`'s own `finally` block does exactly this whenever a turn
 * ends normally — including a live `kill()`, since that aborts the
 * in-flight `send()` and lets the same `finally` run. But a session
 * force-terminated from OUTSIDE that turn loop — the daemon process dying
 * underneath it (discovered at next boot) or a shutdown that SIGTERMs
 * whatever's still busy — never reaches that `finally`, so without this
 * the flags stay frozen at whatever they were the instant the daemon went
 * away: a session can end up "killed" yet forever "busy". Both forced-
 * termination sites below call this before persisting the terminal status.
 */
function clearInFlightFlags(desc: SessionDescriptor): void {
  desc.busy = false
  desc.awaitingInput = false
  desc.awaitingQuestion = undefined
  delete desc.awaitingPermission
  desc.blockedOn = undefined
  desc.pendingToolCallId = undefined
}

/**
 * Read the persisted snapshot at boot and reinflate session
 * descriptors as historical "ghost" entries. Sync-read because this
 * runs once at construction, the file is small (~200 entries), and
 * keeping it sync avoids making createSessionsRegistry async (would
 * cascade through createGateway + every embedding host).
 *
 * Anything that was "running"/"starting" when the daemon last died
 * gets re-classified as "killed" with endedAt=now — we can't tell
 * if the orphan PID survived the daemon's exit, and pretending it's
 * still alive would make attach/kill calls fail mysteriously. Its
 * in-flight fields (busy, awaiting-*, blockedOn) get cleared the same
 * way — see `clearInFlightFlags` — since nothing else will ever clear
 * them for a process that's gone, and `endedReason: "daemon-restart"`
 * is stamped so the UI can tell this apart from an operator kill. When
 * `sessionEvents` is wired, each reclassified ghost also gets a
 * `session:exited` announcement so a watcher polling `session_events_poll`
 * (or long-polling `session_monitor`) learns its session died instead of
 * discovering it later by accident. The descriptor stays in the registry
 * for history; the dashboard sees it under SESSIONS, the user can `d` to
 * forget.
 *
 * Ghosts carry NO live child / agentSession / pty — calls that
 * would interact with the underlying process degrade to no-ops.
 * Output ring buffers (lines + bytes) are empty: we don't persist
 * those, only the descriptor metadata.
 */
function loadHistorySnapshot(
  persistPath: string,
  sessions: Map<string, SessionRuntime>,
  sessionEvents?: SessionEventBus,
  /** The bucket `persistPath` was read from, in partitioned mode. When
   *  given alongside `sourceBucketOf`, every loaded row's id is recorded
   *  against it — see `sourceBucketOf`'s docblock at its declaration in
   *  `createSessionsRegistry` for why persist has to honor this instead
   *  of recomputing the bucket from `workspaceSlug`. */
  bucketSlug?: string,
  sourceBucketOf?: Map<string, string>,
  /** See `heldIdsByBucket`'s docblock in `createSessionsRegistry` —
   *  every loaded row's id is stamped against `bucketSlug` here too, so
   *  a row this daemon read at boot is never mistaken for a foreign one
   *  by `mergeBucketRows` after it's later forgotten. */
  heldIdsByBucket?: Map<string, Set<string>>,
): void {
  let raw: string
  try {
    raw = readFileSync(persistPath, "utf8")
  } catch {
    return // ENOENT etc. — first boot, no history.
  }
  let parsed: { sessions?: SessionDescriptor[] }
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.warn(
      `[sessions] history file ${persistPath} is malformed — ignoring`,
    )
    return
  }
  if (!Array.isArray(parsed.sessions)) return
  // Newest first so the FIFO cap drops oldest.
  const sorted = parsed.sessions
    .filter((s): s is SessionDescriptor => !!s && typeof s.id === "string")
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, HISTORY_CAP)
  const now = new Date().toISOString()
  for (const desc of sorted) {
    if (sessions.has(desc.id)) continue // collision with a live entry — keep live
    const wasAlive = desc.status === "running" || desc.status === "starting"
    const reclassified: SessionDescriptor = wasAlive
      ? {
          ...desc,
          status: "killed",
          endedAt: desc.endedAt ?? now,
          endedReason: "daemon-restart",
          // Read from the persisted `desc`, not `reclassified` —
          // `clearInFlightFlags` below zeroes `busy` on `reclassified`, and
          // this is the last honest look at what the snapshot actually
          // recorded. Same rule as kill()/shutdownImpl — see killedMidTurn's
          // docblock.
          killedMidTurn: desc.busy === true,
        }
      : desc
    // Unconditional, not `if (wasAlive)`: a ghost carries no child/
    // agentSession, so it is idle whatever the snapshot claimed — and rows
    // that were ALREADY terminal can carry frozen flags too. Two ways in: a
    // kill that raced the turn's `finally`, and — the one actually observed —
    // a snapshot written by a daemon predating this reconciliation, whose
    // "killed + busy" rows are already terminal by the time a fixed daemon
    // reads them, so a wasAlive-only guard never revisits them and the lie
    // survives every future boot. Clearing idle flags on an idle session is a
    // no-op, so there is nothing to lose by not asking how it got there.
    clearInFlightFlags(reclassified)
    // Same reasoning as the in-flight flags above, for `contextUsed`: a
    // snapshot written before `plausibleContextUsed` existed can carry an
    // out-of-window value on disk, and a dead/historical ghost never gets
    // a fresh usage_update to self-correct it — so re-validate on the way
    // back into memory instead of resurrecting the stale figure forever.
    reclassified.contextUsed = plausibleContextUsed(
      reclassified.contextSize,
      reclassified.contextUsed,
    )
    const rt: SessionRuntime = {
      desc: reclassified,
      recentLines: [],
      recentBytes: [],
      recentBytesSize: 0,
      emitter: new EventEmitter(),
      busy: false,
      textBuf: "",
      thoughtBuf: "",
      exitedEmitted: wasAlive,
    }
    rt.emitter.setMaxListeners(50)
    sessions.set(desc.id, rt)
    if (bucketSlug !== undefined) {
      sourceBucketOf?.set(desc.id, bucketSlug)
      if (heldIdsByBucket) markHeldId(heldIdsByBucket, bucketSlug, desc.id)
    }
    if (wasAlive) {
      sessionEvents?.emit({
        type: "session:exited",
        sessionId: reclassified.id,
        exitCode: reclassified.exitCode,
        status: "killed",
        ...(reclassified.label ? { label: reclassified.label } : {}),
        reason: "daemon-restart",
        ts: now,
      })
    }
  }
}

/** Minimal shell-quote — wraps args containing whitespace or quotes
 *  so the rendered `command` field is copy-pasteable. */
function quoteArg(arg: string): string {
  if (arg === "") return '""'
  if (/^[a-zA-Z0-9._/=:@,+-]+$/.test(arg)) return arg
  return `"${arg.replace(/(["\\$`])/g, "\\$1")}"`
}
