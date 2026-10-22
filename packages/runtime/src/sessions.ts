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
import type { McpAppToolCallRecord } from "./mcp-apps-host.js"
import type { SessionConfigOption, SessionMode } from "@agentproto/acp/client"
import { spawn, type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdirSync, writeFileSync, promises as fs, readFileSync, existsSync, renameSync, watch as watchFsPath } from "node:fs"
import type { FSWatcher } from "node:fs"
import { RESUME_STRATEGIES } from "./resume-strategies.js"
import { computeAgentRoleRefresh, renderRoleUpdateNotice } from "./agent-role-refresh.js"
import type { AgentManifestRefError } from "./spawn-agent-manifest.js"
import { encodeCloudSessionMeta, resolveCloudResumeId } from "./cloud-vendors.js"
import {
  CONVERSATION_STORES,
  conversationTerminalSlugFor,
  isConversationTerminal,
} from "./conversation-store.js"
import { readCommandLogEntry, writeCommandLogEntry } from "./command-log.js"
import { readSandboxLedger } from "./sandbox-ledger.js"
import { readToolCallRecords as readToolCallRecordLines, writeToolCallRecord } from "./tool-call-log.js"
import { readUsageSnapshots as readUsageSnapshotLines } from "./usage-snapshot-log.js"
import { extractCommandArgs, type ToolCallRecord } from "./tool-call-record.js"
import { decideRule, loadHooksConfig } from "./hooks-config.js"
import { runShellGate } from "./supervisor.js"
import { deriveSessionTitle, MAX_LENGTH as TITLE_MAX_LENGTH } from "./session-title.js"
import { mintSlug, resolveSessionRef } from "./session-ref.js"
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
import type { ResolvedSessionSkill } from "./skill-imports.js"
import type { AdapterCapabilitiesLister, AgentAdapterResolver } from "./http-server.js"
import type { QuotaReadableProfile, RemainingQuotaReader } from "./remaining-quota.js"
import {
  HANDOFF_OPTION_PREFIX,
  buildHandoffSuggestions,
  handoffSuggestionLines,
  harnessDisplayName,
  listHandoffHarnesses,
  parseHandoffOption,
} from "./handoff-suggestion.js"
import type {
  SessionEventBus,
  SessionAwaitingQuestion,
  SessionConfigChangedEvent,
  ContextRescueOutcome,
} from "./session-event-bus.js"
import { postureEnforcement, resolvePosture, type PostureEnforcement } from "./canonical-posture.js"
import { isSandboxBoxExpiredError } from "./sandbox-agent-session-proxy.js"
import {
  buildBackgroundTaskWakePrompt,
  DEFAULT_BG_TASK_WAKE_GRACE_MS,
  readOutputTail,
  type SessionBackgroundTask,
} from "./background-task-wake.js"
import { resolveEffectiveRoute } from "./catalog-models.js"
import { normalizeModelForWire } from "./model-wire.js"
import {
  composeSessionObservers,
  filterSessionObserver,
  type SessionObserver,
} from "./session-observer.js"
import { artifactMarkerLines, formatToolCall, formatToolResult } from "./tool-presenter.js"
import { createTranscriptWriter, sessionEventsPath } from "./transcript-writer.js"
import { isReviewOrWorkflowSession } from "./session-list-filters.js"
import {
  runSessionRetentionPass,
  type SessionRetentionOptions,
  type SessionRetentionResult,
} from "./session-retention.js"
import {
  addSessionArtifact as addSessionArtifactImpl,
  getSessionArtifact as getSessionArtifactImpl,
  listSessionArtifacts as listSessionArtifactsImpl,
  pinSessionArtifact as pinSessionArtifactImpl,
  type AddSessionArtifactInput,
  type ArtifactRecord,
  type GetSessionArtifactResult,
} from "./session-artifacts.js"
import { maybeTitleSession } from "./session-titler.js"
import { buildResumeContextDigest } from "./resume-context-digest.js"
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
import {
  deriveSessionUsage,
  pickUsageDetail,
  plausibleContextUsed,
  type SessionUsage,
  type UsageReadResult,
} from "./usage.js"
import { foldUsageFrameWindow, resetContextWindowForModel, type ContextSizeSource } from "./context-window.js"
import { resolveWorktreeIdentity } from "./worktree-identity.js"
import {
  attachParentRelayStore,
  forgetRelayToken,
  rememberRelayToken,
  revokeParentRelayGrantsForSession,
} from "./parent-relay.js"
import type { SessionAppServeInfo } from "./sandbox-app-serve.js"
import type {
  WorktreeAutoReclaimer,
  WorktreeProvisionPhase,
  WorktreeProvisionProgress,
  SandboxCheckpointReclaimer,
} from "./worktree-isolation.js"
import type { AgentsMdMode } from "./agents-md.js"
import {
  buildAutoCompactCompactInstructions,
  buildAutoCompactTranscriptNote,
  compactCommandTakesInstructions,
  createAutoCompactController,
  deriveLastTurnOutcome,
  type AutoCompactController,
  type AutoCompactOutcome,
  type WorkInProgressSnapshot,
} from "./auto-compact.js"
import {
  CONTEXT_CONTINUITY_DEFAULTS,
  computeContextContinuityStatus,
  computeContextPct,
  contextContinuityNextAction,
  contextContinuityStateForPct,
  isContextContinuityHardStopped,
  type ContextContinuityPolicy,
  type ResolvedContextContinuityPolicy,
} from "./context-continuity.js"
import {
  buildContextCheckpoint,
  persistCheckpoint,
  renderCheckpointPrompt,
  type ContextCheckpoint,
} from "./context-checkpoint.js"
import { continueAgentSessionFresh } from "./session-continue-fresh.js"
import {
  compactOutcome,
  deriveSessionOutcome,
  OUTCOME_SUMMARY_MAX,
  readLastAssistantTextSync,
  sanitizeOutcomeDetail,
  shouldReplaceOutcome,
  trimOutcomeText,
  type OutcomeDetail,
  type SessionOutcome,
  type StopOutcome,
  type SessionOutcomeCompact,
} from "./session-outcome.js"
import { DELIBERATE_END_REASONS, isProviderLimitError, tagLimitErrorWithWallet, type SessionEndReason } from "./session-end-reason.js"
import { isAutomatedPromptSource, isRetired } from "./session-retirement.js"
import type { TurnRetryPolicy } from "./turn-retry-policy.js"
import type { ClerkHookConfig } from "./clerk-hook-config.js"
export { isRetired, resolveSuccessor, isAutomatedPromptSource } from "./session-retirement.js"
import {
  INDEX_TAIL_BYTES,
  indexEntryFromDescriptor,
  readTranscriptTail,
  writeSessionIndex,
  type TranscriptPrompt,
} from "./session-index.js"
import { basename, dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { randomUUID } from "node:crypto"
import { formatUncommittedRescueNotice } from "./sandbox-delivery.js"
import type { SandboxCheckpointConfig, SandboxDeliveryRecord, SandboxDeliveryTarget } from "./sandbox-delivery.js"
import { checkpointRefFromRecord, type SessionCheckpointRef } from "./checkpoint-resume.js"
import {
  createSessionMessage,
  escapeHumanPrompt,
  matchesMessageFilter,
  MESSAGE_PREAMBLE,
  renderInboxDigest,
  renderSessionMessages,
  type MessageDeliveryVia,
  type MessageFilter,
  type MessageUrgency,
  type SessionMessage,
} from "./session-message.js"
import { assertDecisionAllows, type Decision } from "./permissions.js"
// Reused, not reimplemented — same parser `applyModelCommand`'s dedicated
// control turn uses, branched onto the ORDINARY prompt flow below so a
// `/model <id>` typed as a plain turn (never routed through
// `agent_set_model`) still gets learned. See `activeModel`'s doc on
// `SessionDescriptor` for why this is a display hint, not billing truth.
// A lean, dependency-free pair of string helpers — doesn't pull in any
// driver session/runtime type, so this stays consistent with
// `AgentSessionLike`'s driver-decoupling above (same precedent as
// `session-config.ts`'s `inferLegacyModeKind` import).
import {
  isModelSwitchAcknowledgement,
  parseModelSwitchCommand,
} from "@agentproto/driver-agent-cli"

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
  /** Whether the driver's transport to the adapter is still usable, read
   *  fresh at call time — mirrors `@agentproto/driver-agent-cli`'s
   *  `AgentCliRuntimeSession.isConnected` without importing it (same
   *  driver-decoupled structural-mirror reasoning as `setModel` below).
   *
   *  The liveness axis `pid` can't cover: an ACP wrapper process commonly
   *  survives its own JSON-RPC stream, so `processAlive` says "alive" while
   *  every RPC rejects with "ACP connection closed". Projected onto
   *  `SessionDescriptor.adapterConnected` at read time and read by the
   *  crash-detect sweep.
   *
   *  Optional, and `true`-by-absence on purpose: a sandbox proxy or a
   *  print-arm session has no long-lived connection to lose, so only an
   *  explicit `false` is evidence of death. */
  isConnected?(): boolean
  /** Subscribe to transport death — the push half of the axis `isConnected`
   *  polls. Fires at most once, and SYNCHRONOUSLY if the transport is
   *  already gone when the listener is attached, which is what lets the
   *  registry wire this up at bind time without racing a connection that
   *  died during spawn.
   *
   *  It fires on an ORDERLY teardown too (the host's own `close()` aborts
   *  the same signal). The registry's listener is safe against that by
   *  construction: it routes into `markCrashed`, which refuses any row that
   *  isn't still `running` — and `kill()`/`reapIdle` both flip `status`
   *  before they close the connection.
   *
   *  Absent for session shapes with no long-lived connection (sandbox
   *  proxy, print arm, future transports). */
  onDisconnect?(listener: (err: Error) => void): void
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
  /** Subscribe to events the agent emits while no turn is in flight — its
   *  own wake-up when a background task settles, and the task lifecycle
   *  itself. Mirrors `@agentproto/driver-agent-cli`'s
   *  `AgentCliRuntimeSession.onOutOfTurnEvent`. Returns an unsubscribe
   *  function. Absent for drivers that can't produce such events. */
  onOutOfTurnEvent?(listener: (event: AgentStreamEvent) => void): () => void
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
  /**
   * The harness's advertised session CONFIG options captured at connect time
   * (the ACP `session/new` / `session/load_session` response `configOptions`)
   * -- mirrors `@agentproto/driver-agent-cli`'s
   * `AgentCliRuntimeSession.availableConfigOptions`.
   *
   * This is the read-surface that tells a client WHICH values the running
   * agent accepts for a given config option: the `model` entry carries the
   * model vocabulary the agent itself validates against, and an id outside it
   * is rejected outright ("Invalid value for config option model"). Absent /
   * empty for arms with no config registry (print, proprietary) -- treated as
   * "no advertised vocabulary", never as "empty vocabulary".
   */
  readonly availableConfigOptions?: readonly SessionConfigOption[]
  /** Canonical postures the adapter enforces through its own isolated spawn
   *  config even with no advertised mode — mirrors
   *  `AgentCliRuntimeSession.spawnEnforcedPostures` (claude-code, opencode).
   *  Lets posture surfaces report `spawn-config` instead of advisory. */
  readonly spawnEnforcedPostures?: readonly string[]
  /** Whether the agent accepts steering — mirrors
   *  `@agentproto/driver-agent-cli`'s `AgentCliRuntimeSession.steeringSupported`
   *  (ACP `_session/steering`, advertised at initialize). */
  readonly steeringSupported?: boolean
  /** Inject content into the turn in flight — mirrors
   *  `AgentCliRuntimeSession.steer`: `"steered"` (injected), `"promptRequired"`
   *  (no host turn in flight — deliver as a normal prompt), `"unsupported"`.
   *  Never throws. Absent for sessions that can't steer. */
  steer?(content: unknown): Promise<"steered" | "promptRequired" | "unsupported">
  /** `daemonShutdown` ⇒ the daemon process is exiting: skip any slow
   *  pre-teardown work (a sandbox's work-branch delivery) and release the
   *  underlying resource immediately. */
  close(opts?: {
    daemonShutdown?: boolean
    /** Set by the idle reaper for a sandboxed session: the sandbox proxy runs
     *  a final checkpoint before teardown and stamps the ledger row with the
     *  reap provenance. Other sessions ignore it. */
    idleReap?: { idleMs: number; sessionId?: string }
  }): Promise<void>
  /**
   * Sandbox proxies only: peek at the data needed to re-attach to this
   * session's box after a host-daemon restart, WITHOUT detaching. Stamped
   * onto the descriptor at snapshot time (`SessionDescriptor.sandboxReattach`)
   * so even a crash leaves a usable record. Absent/undefined ⇒ the session is
   * not re-attachable (a plain local session, a device sandbox).
   */
  detachRecord?(): SandboxDetachRecord | undefined
  /**
   * Sandbox proxies only: the daemon is shutting down — close the connection
   * to the box's session WITHOUT killing it or stopping/pausing the box. Sync
   * and idempotent (it also runs from `shutdownImpl`'s sync path). After this
   * the in-flight `send()` parks forever instead of erroring, so the turn loop
   * never mis-reads the severed stream as a dead session. Returns the record
   * to persist, or undefined when the session isn't detachable.
   */
  detach?(): SandboxDetachRecord | undefined
  /** Best-effort async half of `detach()`: re-arm the box's lifetime so it
   *  outlives the restart gap. Never throws. */
  extendDetachedLifetime?(): Promise<void>
  /** Re-attach only: classify the box's session so the boot pass knows
   *  whether a turn is in flight / unseen events are waiting. Never throws. */
  probeReattach?(): Promise<SandboxReattachProbe>
  /** Re-attach only: consume the box's already-running (or just-finished)
   *  turn from the saved transcript cursor — no prompt is sent. */
  resumeTurn?(): AsyncIterable<AgentStreamEvent>
}

/** What a detached sandbox session persists to find its box session again. */
export interface SandboxDetachRecord {
  /** Session id on the BOX's own daemon. */
  remoteSessionId: string
  /** Last box-transcript `seq` this host consumed — replay resumes after it. */
  transcriptSeq: number
}

/** The box session's state as seen by a re-attaching host. */
export interface SandboxReattachProbe {
  /** `gone`: the box daemon has no such session; `ended`: it exists but its
   *  adapter session already finished; `busy`: a turn is in flight;
   *  `backlog`: idle but unseen stream events are waiting; `idle`: nothing to
   *  replay; `unreachable`: the box couldn't be asked (transient). */
  state: "gone" | "ended" | "busy" | "backlog" | "idle" | "unreachable"
  detail?: string
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
  /** How the requested posture is ENFORCED once applied (`postureEnforcement`,
   *  canonical-posture.ts) — on a `requires-restart` result this says whether
   *  the restart lands a real boundary (`spawn-config`, e.g. opencode
   *  `bypass`) or only the advisory preamble (`prompt-advisory`). */
  enforcement?: PostureEnforcement
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
  /** "agent-prompt" `_meta` bag, e.g. an ACP `requestPermission`'s
   *  `toolCall._meta` (mastra-agent's `mastra-agent/suspendPayload` carries a
   *  submit_plan's plan text there) — see @agentproto/acp's `StreamEvent`'s
   *  `agent-prompt` kind. Harness-shaped and untyped. */
  _meta?: unknown
  /** "plan" event title — see @agentproto/acp's `StreamEvent`'s `plan` kind. */
  title?: string
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
  /** "usage_update" model the usage belongs to, when the adapter reports it
   *  (claude-agent-acp's `_meta["_claude/model"]`) — see `context-window.ts`. */
  model?: string
  /** "usage_update" `size` is the adapter's own guess, corrected later by a
   *  cost-bearing frame (claude-agent-acp) — see `context-window.ts`. */
  sizeInferred?: boolean
  /** "usage_update" size as the adapter reported it, recorded only when the
   *  daemon corrected `size` (an inferred window superseded by the catalog or
   *  an earlier authoritative frame) — see `context-window.ts`. */
  reportedSize?: number
  /** "permission-resolved" outcome for the "agent-prompt" it answers (same
   *  `toolCallId`) — mirrors `session:permission-resolved`'s `decision` so
   *  the durable transcript can tell an answered ask from a still-pending
   *  one. Not an ACP `StreamEvent` kind (synthesized by the registry, same
   *  as "notice"/"turn-end" synthetics) — see registerPendingPermission's
   *  docblock for the "agent-prompt" ask this resolves. */
  decision?: "approve" | "deny" | "cancelled"
  /** "permission-resolved" chosen option id, when the driver's offered
   *  options included one (e.g. ACP's `allow_always`). */
  optionId?: string
  /** "available-commands" full command list — see @agentproto/acp's
   *  `StreamEvent`'s `available-commands` kind. REPLACES any previously
   *  reported list wholesale; it is not a delta. */
  commands?: Array<{
    name: string
    description?: string
    input?: { hint?: string } | null
    _meta?: { scope?: string; path?: string; bareName?: string; qualifiedName?: string }
  }>
  /** "background-task" lifecycle edge — see @agentproto/acp's `StreamEvent`'s
   *  `background-task` kind. */
  phase?: "started" | "updated" | "settled"
  /** "background-task" task snapshot — see @agentproto/acp's
   *  `BackgroundTaskInfo`. Only `taskId` is guaranteed. */
  task?: {
    taskId: string
    taskKind?: string
    description?: string
    outputFile?: string
    status?: SessionBackgroundTask["status"]
    summary?: string
    toolCallId?: string
  }
  /** "usage_update" origin of the cycle it closes (claude-agent-acp's
   *  `_meta["_claude/origin"].kind`, e.g. `"task-notification"` for an
   *  autonomous wake) — see @agentproto/acp's `StreamEvent`. */
  origin?: string
}

/**
 * Defensively narrow a tool-call's `arguments` (typed `unknown` — see
 * `AgentStreamEvent.arguments`) to answer ONE question: did this call start
 * a background task? True only when arguments is a plain object carrying
 * `run_in_background: true` — how Claude Code's Bash announces a
 * `run_in_background` invocation. Matched generically on the property, not
 * the tool name, so any adapter/tool that adopts the same convention is
 * counted. Anything else (non-object, missing the key, a non-`true` value)
 * is an ordinary foreground call.
 */
function isBackgroundToolCallArguments(args: unknown): boolean {
  return (
    typeof args === "object" &&
    args !== null &&
    (args as Record<string, unknown>).run_in_background === true
  )
}

/**
 * Turn error attached when a turn has produced NO output and NO usage since
 * its prompt and then goes silent past the stall threshold — the provider is
 * almost certainly retrying internally (opencode's silent 429 loop) and the
 * daemon would otherwise only report `stalledSinceMs` with no reason. Set by
 * `markStalled`; cleared at the next turn-end like every other turn error.
 */
export const NO_OUTPUT_STALL_TURN_ERROR =
  "no output since prompt — provider retrying?"

/**
 * True when a stream event proves the turn's provider produced real output
 * or usage — the signal that distinguishes "slow" from "silently retrying".
 * Gates the stall watchdog's provider-retry turn error (see `markStalled`):
 * a turn with NO such event since its prompt, silent for `turnStallAfterMs`,
 * is treated as a stuck provider rather than a slow one.
 *
 * Control-plane events (`available-commands`) are deliberately excluded;
 * task/permission edges ARE included, since a long background task or a
 * pending permission legitimately goes quiet without being a dead stream.
 */
function isTurnOutputEvent(evt: AgentStreamEvent): boolean {
  switch (evt.kind) {
    case "text-delta":
      return !!evt.text?.trim()
    case "thought":
    case "tool-call":
    case "tool-result":
    case "plan":
    case "usage_update":
    case "background-task":
    case "agent-prompt":
      return true
    default:
      return false
  }
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
function classifyBlockedOn(toolName?: string): "subagent" | "command" | "inbox" | undefined {
  if (!toolName) return undefined
  const n = toolName.toLowerCase()
  if (n === "agent_start") return "subagent"
  // A supervisor parked in `inbox_wait` is legitimately waiting on its
  // children's messages (MCP-prefixed names like `mcp__agentproto__inbox_wait`
  // included), not stalled.
  if (/(^|_)inbox_wait$/.test(n)) return "inbox"
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

/**
 * Canonical persistent location for a session's isolated adapter-config dir
 * (`SessionDescriptor.adapterConfigDir` / `startSession({ configDir })`).
 * Keyed by session id — the FIRST id in a restart lineage, since restarts
 * carry the recorded path forward instead of re-deriving it (a restarted
 * session has a fresh id but must keep pointing at the dir holding the
 * provider's conversation store). Sibling of the per-session transcript
 * dirs (`~/.agentproto/sessions/<id>/`) but under its own root so session
 * GC/archival never rips a live lineage's resume store out from under it.
 * Nothing cleans these up today — same accumulate-forever discipline as
 * `~/.agentproto/sessions/` itself.
 */
export function adapterConfigDirFor(sessionId: string): string {
  return resolve(homedir(), ".agentproto", "adapter-config", sessionId)
}

/**
 * Env vars the registry injects into every process it spawns on a session's
 * behalf (agent-cli adapters, PTY/terminal, and generic `spawn()` — see
 * `spawn()`/`spawnPty()` below; `spawnAgent()` doesn't own the child process,
 * so `session-spawn.ts` injects these itself before calling the adapter
 * resolver's `startSession()`). Two vars, deliberately: `SESSION_ID_ENV` is
 * the opaque identity a hook/script needs to report back or nest a child
 * session under (`parentSessionId`); `WORKSPACE_SLUG_ENV` costs nothing to
 * add (always resolved before spawn) and turns "which session" into "which
 * session in which workspace" without a round-trip. `label`/`name` are
 * deliberately NOT carried — they're optional, mutable (renameable) and
 * absent on most sessions, so a hook could not depend on them; a caller that
 * needs one can look it up via `SESSION_ID_ENV` + `session_list`.
 *
 * THE RULE (identity forgery + inheritance, see spawn()/spawnPty()): these
 * are assigned into the child's env LAST — after both `process.env` and any
 * caller-supplied `input.env` have been merged — so a caller can never
 * override or forge them, and a freshly minted id always wins over whatever
 * (if anything) happened to be ambient. The daemon process itself is never a
 * session, so `process.env` never carries a stale value to begin with; the
 * assign-last rule is what makes that true by construction rather than by
 * accident, and is what guarantees a child spawned from inside a session
 * gets its OWN id rather than inheriting its parent's.
 *
 * `PARENT_SESSION_ID_ENV` is the third var, injected by `session-spawn.ts`
 * only (agent spawns, and only when the spawn resolved a parent): the
 * recorded `parentSessionId` lineage, so a child agent can know WHO spawned
 * it without a registry round-trip — the discovery half of the child→parent
 * report-back channel (`message_parent` is the delivery half). Same
 * assign-last/no-forgery rule as the other two: it mirrors the descriptor's
 * own `parentSessionId` field, never anything caller- or env-inherited.
 */
export const SESSION_ID_ENV = "AGENTPROTO_SESSION_ID"
export const WORKSPACE_SLUG_ENV = "AGENTPROTO_WORKSPACE_SLUG"
export const PARENT_SESSION_ID_ENV = "AGENTPROTO_PARENT_SESSION_ID"
/** The HTTP header the daemon's own `/mcp` gateway reads the CALLER's session
 *  id from, as a fallback for the `?callerSessionId=` query.
 *
 *  Why both: the identity of a daemon-spawned session travels in the URL of
 *  the mount it was given (`?callerSessionId=<own id>`; see
 *  `buildDaemonSelfMountEntry`, session-spawn.ts). A URL query is the
 *  FRAGILE carrier: any client (or intermediary) that rebuilds, normalizes or
 *  re-roots the mount URL drops it, and the session silently becomes
 *  anonymous to the gateway: `message_parent` then answers "cannot identify
 *  the calling session" and every spawn it makes lands as a depth-0 orphan
 *  (no auto-parent to derive; see `spawn-attach.ts`). A header is the
 *  carrier the ACP/MCP http transports carry verbatim, so the identity now
 *  travels BOTH ways: the query stays (back-compat, and the form the
 *  `?callerSessionId=` trust checks read), the header is the fallback.
 *
 *  Trust: identical to the query claim; honoured only for a loopback
 *  socket or a valid daemon bearer (see `externalClaimTrusted`,
 *  http-server.ts), and only when the query carries no id.
 */
export const CALLER_SESSION_ID_HEADER = "x-agentproto-caller-session-id"
/** Set only for a spawn made on behalf of an installed `@agentproto/app-kit`
 *  app (`app_run` → `spawnAgentSession({appId})`) — the id a daemon-tool
 *  proxy (mastra-agent's `daemon-mcp-tools.ts`, P7) auto-injects into an
 *  `app_*` tool call that omits one, since the model driving the session has
 *  no way to know its own appId unless told. Absent on any other spawn. */
export const APP_ID_ENV = "AGENTPROTO_APP_ID"
/** Set for a spawn whose composed prompt carries an AGENTS.md POINTER to a
 *  file outside the session cwd (the daemon resolves AGENTS.md up to the git
 *  toplevel, but a session's own workspace tools are confined to its cwd).
 *  Value: a JSON array of absolute paths the adapter's workspace toolset may
 *  READ (never write) — the exact contract files the prompt points at. This
 *  is how the pointer contract stays actionable instead of erroring with
 *  `path … escapes the workspace`. Daemon-authored only: mirrors the prompt's
 *  own pointer block, never anything caller- or env-inherited. */
export const ADDITIONAL_READ_PATHS_ENV = "AGENTPROTO_ADDITIONAL_READ_PATHS"

/** `external` — an inbox-only row for a session the daemon did NOT spawn (a
 *  Claude Desktop Code-tab / plain `claude` CLI session connected over MCP).
 *  It has no process, PTY or adapter: it is never spawned, restarted, reaped
 *  or prompted, and exists only so the session can own an AIP-46 inbox.
 *  Liveness is a window over `lastSeenAt` — see
 *  {@link DEFAULT_EXTERNAL_SESSION_LIVENESS_MS}. */
export type SessionKind = "terminal" | "agent-cli" | "command" | "browser" | "external"
export type SessionStatus =
  | "starting"
  | "running"
  | "exited"
  | "killed"
  | "error"
export type SessionCurrentPhase =
  | "thinking"
  | `tool-call:${string}`
  | "awaiting-input"
  | "awaiting-permission"
  | "idle"
  | "completed"
  | "killed"

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
 * A prompt / revival aimed at a RETIRED row (see `isRetired`). Extends
 * {@link SessionNotAliveError} so every existing "dead target" catch (sentinel,
 * follow, inbound) keeps routing it to its dead-session handler. `code` is the
 * internal discriminator: `session_superseded` (with `continuedTo` naming the
 * successor) when the row has a replacement, else `session_retired`.
 *
 * On the wire it is still `session_not_alive` (clients already handle that
 * code); {@link retiredErrorWire} adds `reason: "superseded" | "retired"` and
 * `continuedTo` so a client can tell "dead" from "replaced" and where to go.
 */
export class SessionRetiredError extends SessionNotAliveError {
  readonly code: "session_superseded" | "session_retired"
  readonly reason: "superseded" | "retired"
  readonly continuedTo?: string
  constructor(sessionId: string, status: SessionStatus, caller: string, continuedTo?: string) {
    super(sessionId, status, caller)
    this.name = "SessionRetiredError"
    this.code = continuedTo ? "session_superseded" : "session_retired"
    this.reason = continuedTo ? "superseded" : "retired"
    if (continuedTo) this.continuedTo = continuedTo
    this.message = continuedTo
      ? `${caller}: session "${sessionId}" was superseded by "${continuedTo}" (session_superseded) — prompt "${continuedTo}" instead`
      : `${caller}: session "${sessionId}" is retired (session_retired) and is never revived automatically`
  }
}

/** The wire body (HTTP 409 / MCP error JSON) for a refused retired-row
 *  prompt: `error` stays `session_not_alive`; `reason` + `continuedTo` are the
 *  additive detail. */
export function retiredErrorWire(err: SessionRetiredError): {
  error: "session_not_alive"
  reason: "superseded" | "retired"
  message: string
  status: SessionStatus
  continuedTo?: string
} {
  return {
    error: "session_not_alive",
    reason: err.reason,
    message: err.message,
    status: err.status,
    ...(err.continuedTo ? { continuedTo: err.continuedTo } : {}),
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
    | "subaccount"
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
  /** The sub-account (org / workspace / project) the profile is pinned to. */
  subaccount?: { kind: string; id: string; name?: string }
}

/**
 * One live waiter behind a session's {@link SessionDescriptor.watchers} count
 * (#session-visibility). Captured at `monitorSessionWait` attach time and held
 * only for the life of that wait — never persisted, never updated in place
 * (a snapshot of the waiter's label at attach time, not a live mirror of it).
 */
export interface SessionWatcherInfo {
  /** The waiting session's id, when this wait was initiated by an agent
   *  session via the orchestrator scope (`callerScope.ownerSessionId`).
   *  Absent for an anonymous CLI/HTTP waiter — it still counts toward
   *  `watchers`, it just can't be named. */
  watcherSessionId?: string
  /** Best-effort label/title for `watcherSessionId`, resolved once at attach
   *  time. A later rename of the watching session is not reflected. */
  watcherLabel?: string
  /** What this wait is blocking on — mirrors `session_monitor`'s `event`
   *  parameter (`SessionWaitEvent` in orchestration-tools.ts; kept as a plain
   *  string here so the registry doesn't depend on the tool-layer type). */
  event: string
  /** The wait's configured timeout, ms — absent for the MCP tool's default. */
  timeoutMs?: number
  /** ISO 8601 timestamp this waiter attached. */
  since: string
}

/** One prompt waiting in `SessionDescriptor.promptQueue` — see that
 *  field's doc for the FIFO/force ordering contract. */
export interface QueuedPrompt {
  /** Stable id, assigned at queue time (by the HTTP layer for
   *  `POST /sessions/:id/prompt`'s `queue` arm so the caller can echo it
   *  straight back in the response, or minted here for any other
   *  caller). Used by `removeQueuedPrompt` to cancel this one item
   *  before it dispatches. */
  id: string
  /** Same shape `runAgentTurn`'s `message` parameter accepts — a raw
   *  string or an ACP content block/array. */
  message: unknown
  /** ISO 8601 timestamp this item was queued. */
  queuedAt: string
  /** Same as `enqueuePrompt`'s `opts.source` — carried through to the
   *  turn this item eventually becomes (transcript provenance). */
  source?: string
  /** Who/what queued this, for the AFTER-THE-FACT queue UI — DISTINCT
   *  from `source` (transcript provenance). Set from `enqueuePrompt`'s
   *  `opts.origin` at the enqueue site so a human session-operator, an
   *  agent session (`agent_prompt`), and a child's report (`message_parent`)
   *  are cleanly separable when someone inspects the queue later across a
   *  daemon restart. Absent for legacy queued items — `promptOriginLabel`
   *  falls back to `source`, then `"user"`. */
  origin?: string
  /** Set when this item is a typed inter-session message (`message_parent`,
   *  …) rather than a prompt: the daemon-attested envelope. `message` then
   *  only carries `envelope.text` (for `previewPrompt`); the turn is built
   *  from the envelope — rendered as an `<agentproto-message>` tag, recorded
   *  as a `session-message` transcript record, and coalesced with any
   *  envelope items queued right behind it (never with a plain prompt). */
  envelope?: SessionMessage
  /** Opt-in (`enqueuePrompt` `opts.steer`): this item may be injected into
   *  the target's RUNNING turn at the next safe point instead of waiting for
   *  the turn to end — only when the agent advertises steering. Plain
   *  (non-envelope), non-child prompts only. */
  steer?: boolean
  /** ISO 8601 deadline (`deliverWithin`): past it, the pending-prompt sweep
   *  force-delivers this item per {@link deliverVia}. */
  deliverBy?: string
  /** How the sweep forces delivery at {@link deliverBy}: `steer` (inject,
   *  else stay queued), `interrupt` (cancel the turn and run it now), or
   *  `auto` (steer when the agent can, else interrupt). Default `auto`. */
  deliverVia?: "auto" | "steer" | "interrupt"
  /** ISO 8601 — when the staleness notice for this item was sent (once). */
  staleNotifiedAt?: string
  /** Items sharing a key collapse: a newer enqueue with the same key
   *  replaces this item in place (message/envelope/queuedAt updated, id and
   *  position kept). */
  coalesceKey?: string
  /** How many enqueues have collapsed into this item (absent ⇒ 1 — never
   *  coalesced). Lets a queue UI show "x3". */
  coalescedCount?: number
}

/** What `enqueuePrompt` resolved to — lets a caller (e.g. MCP `agent_prompt`)
 *  tell the user whether the prompt was delivered/started now or PARKED behind
 *  an in-flight turn. `queued: true` fires ONLY on the mid-turn queue arm
 *  (`opts.queue` true, session busy, no `interrupt`): the prompt sits in
 *  `promptQueue` and won't run until the current turn ends. Every other path —
 *  idle dispatch, an interrupt that redirected the live turn, a structured-
 *  question answer — resolves `queued: false`. */
export interface EnqueuePromptResult {
  /** Legacy: true ONLY when the prompt is parked in `promptQueue` (not yet
   *  delivered). Prefer `delivery` / `pending`. */
  queued: boolean
  /** `delivered` — started as a turn (idle target, or an interrupt);
   *  `steered` — injected into the running turn; `queued-mid-turn` — parked
   *  until the current turn ends (or a steer / `deliverWithin` fires).
   *  `delivery` / `pending` are always set by the registry; optional here so
   *  structural stand-ins that only know `queued` still type-check. */
  delivery?: PromptDelivery
  /** ISO 8601 delivery time, when already delivered. */
  deliveredAt?: string
  /** True while the prompt has NOT reached the target yet. */
  pending?: boolean
  /** Id of the parked item (`delivery: "queued-mid-turn"`). */
  queueId?: string
}

export type PromptDelivery = "delivered" | "steered" | "queued-mid-turn"

/**
 * Short text preview of a queued `QueuedPrompt.message` (raw string OR an
 * ACP content block / array — the same shape `runAgentTurn`'s `message`
 * accepts). Flattens text out of content-block arrays and truncates to a
 * sane single line so a queue UI can show "what's waiting" without the
 * full payload. Shared by the daemon's `session_queue_list` verb + HTTP
 * route (the single producer), which the CLI and VS Code panel consume —
 * it lives here (not duplicated) so no consumer re-implements it.
 */
export function previewPrompt(message: unknown, maxLength = 80): string {
  let text: string
  if (typeof message === "string") {
    text = message
  } else if (Array.isArray(message)) {
    text = message
      .map(block => textOfContentBlock(block))
      .filter(Boolean)
      .join("\n")
  } else if (message !== null && typeof message === "object") {
    text = textOfContentBlock(message)
  } else {
    text = ""
  }
  const single = text.replace(/\s+/g, " ").trim()
  if (!single) return "[non-text content]"
  return single.length > maxLength ? `${single.slice(0, maxLength - 1)}…` : single
}

/** Extract the human-readable text of a single ACP content block, or empty
 *  string when it has none (tool-use, images, results, …). */
function textOfContentBlock(block: unknown): string {
  if (block === null || typeof block !== "object") return ""
  const b = block as { type?: unknown; text?: unknown; name?: unknown }
  if (b.text !== undefined && typeof b.text === "string") return b.text
  if (b.type === "text" && typeof (block as { text?: unknown }).text === "string") {
    return (block as { text: string }).text
  }
  return ""
}

/**
 * Human-readable label for a queued item's origin — "who put this in the
 * queue". Blanks a code (`"user"`, `"agent:<sessionId>"`,
 * `"child:<sessionId>"`) into display text; falls back to `source`, then
 * `"user"` (the historical default for any item that predates `origin`).
 */
export function promptOriginLabel(item: { source?: string; origin?: string }): string {
  const code = item.origin ?? item.source ?? "user"
  if (code === "user") return "user"
  if (code.startsWith("agent:")) return `agent ${code.slice("agent:".length)}`
  if (code.startsWith("child:")) return `child ${code.slice("child:".length)}`
  return code
}

/** True for a turn a CHILD session authored (`message_parent` report or a
 *  `[child-crashed]` notice — `source:"child:<sessionId>"`). Such a turn is
 *  never matched as the answer to a structured question (only the human
 *  answers those) — a child whose report happens to read `keep-going` must
 *  not decide the parent's context-continuity prompt. */
export function isChildPromptSource(source: string | undefined): boolean {
  return source?.startsWith("child:") === true
}

/**
 * True for the runtime's OWN autocompact prompts (the compaction command
 * and the resume prompt that follows it). They never consume the pending
 * autocompact note: the compaction is the thing the note is about, and the
 * resume prompt already cites the transcript path and the lookup tools.
 */
export function isRuntimeAutoCompactSource(source: string | undefined): boolean {
  return source === "runtime:auto-compact" || source === "runtime:auto-compact-resume"
}

/** Source/origin stamped on notices migrated out of the retired
 *  `pendingChildCrashNotices` field — the sending child's id wasn't
 *  recorded there, only baked into the notice text. */
export const LEGACY_CHILD_NOTICE_SOURCE = "child:legacy"

/** Bound on `SessionDescriptor.inbox` (un-consumed messages). */
export const INBOX_CAP = 200

/** R3 — a burst of `steer` messages must not thrash a recipient: at most
 *  one steer per recipient per this window; the excess is delivered as
 *  `next-turn` (and coalesces with its neighbours at turn-end). */
export const STEER_MIN_INTERVAL_MS = 10_000

/** Poll cadence for a live session's usage reader (`armUsageRefresh`).
 *  Hermes' state.db and opencode's broker db refresh continuously while the
 *  CLI works, so a few seconds keeps `session_list` / `session_usage`
 *  near-real-time without hammering either store. */
export const USAGE_REFRESH_INTERVAL_MS = 5_000

/** What `sendMessage` did with a message — truthful, per AIP-46. */
export interface SendMessageResult {
  messageId: string
  /** Set when the message already reached the recipient's context (a
   *  waiter, a dispatched turn, an interrupt) or was parked as `fyi`
   *  (`via: "inbox"`); `null` while it's queued behind a busy turn. */
  delivered: { via: MessageDeliveryVia } | null
  queued: boolean
  urgencyApplied: MessageUrgency
}

export interface WaitForMessagesResult {
  messages: SessionMessage[]
  timedOut: boolean
}

/**
 * Boot migration for the retired `SessionDescriptor.pendingChildCrashNotices`
 * field: a snapshot written by an older daemon can still carry notices that
 * were waiting to be string-prepended onto the next prompt. Move each onto
 * the END of `promptQueue` as its own child-sourced item (so it's delivered
 * as a separate turn like every live report now is) and drop the field.
 * Mutates `desc` in place; no-op when there's nothing to migrate.
 */
export function migratePendingChildNotices(desc: SessionDescriptor): void {
  const pending = desc.pendingChildCrashNotices
  if (pending === undefined) return
  delete desc.pendingChildCrashNotices
  if (!pending.length) return
  const queuedAt = new Date().toISOString()
  const migrated: QueuedPrompt[] = pending
    .filter((n): n is string => typeof n === "string" && n.length > 0)
    .map(message => ({
      id: `q_${randomUUID().slice(0, 8)}`,
      message,
      queuedAt,
      source: LEGACY_CHILD_NOTICE_SOURCE,
      origin: LEGACY_CHILD_NOTICE_SOURCE,
    }))
  desc.promptQueue = [...(desc.promptQueue ?? []), ...migrated]
}

/** One entry in the after-the-fact queue listing (`listQueuedPrompts` /
 *  `session_queue_list` / `GET /sessions/:id/queue`). `position` is the
 *  array index (0 = next to dispatch). */
export interface QueuedPromptView {
  id: string
  /** Human-readable origin — who queued this ("user", "agent <id>", "child <id>"). */
  origin: string
  /** Short single-line text preview of the message. */
  preview: string
  /** ISO 8601 timestamp the item was queued. */
  queuedAt: string
  position: number
  /** How many enqueues collapsed into this item — absent when it was never
   *  coalesced (a UI can show "x3"). */
  coalescedCount?: number
}

/** One prompt still waiting to reach a session, with its age — the
 *  `pendingPrompts` field on `session_list` / `session_recap` so a sender (or
 *  a supervisor reading a truncated list) sees a stuck delivery. `stale` is
 *  set once it has waited past the staleness threshold. */
export interface PendingPromptView {
  id: string
  /** Same label as `QueuedPromptView.origin`. */
  origin: string
  preview: string
  queuedAt: string
  /** Milliseconds since `queuedAt` at read time. */
  ageMs: number
  stale?: true
  /** ISO 8601 `deliverWithin` deadline, when one was set. */
  deliverBy?: string
}

/** Tally of one `sweepPendingPrompts` pass. */
export interface PendingPromptSweepSummary {
  /** Prompts newly reported stale (sender notified). */
  stale: number
  /** Prompts force-delivered because their `deliverWithin` deadline passed. */
  forced: number
  ids: string[]
}

/** Daemon default for how long a prompt may sit queued before it is
 *  reported stuck (`defaults.messaging.pendingPromptStaleMinutes`). */
export const DEFAULT_PENDING_PROMPT_STALE_MS = 5 * 60_000

/** Default liveness window for an `external` session (one the daemon did not
 *  spawn): alive while its last MCP request / inbox poll is this recent. */
export const DEFAULT_EXTERNAL_SESSION_LIVENESS_MS = 30 * 60_000

/** Project a prompt queue into age-stamped {@link PendingPromptView}s. */
export function pendingPromptViews(
  queue: readonly QueuedPrompt[] | undefined,
  now: number = Date.now(),
  staleMs: number = DEFAULT_PENDING_PROMPT_STALE_MS,
): PendingPromptView[] {
  return (queue ?? []).map(p => {
    const ageMs = Math.max(0, now - Date.parse(p.queuedAt))
    return {
      id: p.id,
      origin: promptOriginLabel(p),
      preview: previewPrompt(p.message),
      queuedAt: p.queuedAt,
      ageMs,
      ...(ageMs >= staleMs ? { stale: true as const } : {}),
      ...(p.deliverBy ? { deliverBy: p.deliverBy } : {}),
    }
  })
}

/** Provenance stamped onto a `session_continue_fresh` target by
 *  {@link SessionDescriptor.handoff} — which harness the checkpoint moved
 *  from/to and when. `fromHarness === toHarness` for a same-harness
 *  continuation; they differ for a genuine cross-harness handoff
 *  (claude-code -> opencode, etc). */
export interface SessionHandoff {
  fromHarness: string
  toHarness: string
  /** ISO 8601 timestamp the handoff spawn completed. */
  at: string
}

/**
 * Where a still-`starting` session's worktree provisioning stands in the
 * daemon-wide provisioning queue (heavy phases, `depsCmd` above all, are
 * throttled so a burst of spawns cannot melt the host). Present only while
 * provisioning is in flight; cleared when it finishes, fails, or is cancelled.
 */
export interface SessionProvisioning {
  /** `queued`: waiting for a heavy-phase slot. `running`: provisioning is
   *  actually executing (the cheap prep, or a granted heavy segment). */
  state: "queued" | "running"
  /** 1-based projected dispatch position; only while `queued`. */
  position?: number
  /** The phase queued for (`queued`) or currently executing (`running`). */
  phase: WorktreeProvisionPhase
  /** ISO-8601 instant provisioning began (the spawn), constant across the
   *  queued and running states so `now - startedAt` is the total wait. */
  startedAt: string
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
  /** Worktree-provisioning progress of a `starting` row — see
   *  {@link SessionProvisioning}. Absent once the session left `starting`. */
  provisioning?: SessionProvisioning
  /** Unambiguous liveness signal, stamped at read time (list()/get()/
   *  findByIdOrName) — true iff `status` is "running" or "starting", the
   *  same test the daemon uses internally (validateAgentTurn). Ephemeral:
   *  never persisted, always recomputed from the row's status. Exists
   *  because `status` alone is NOT liveness: a terminal row ("killed",
   *  "exited", "error") is a record that exists, and HTTP 200 on
   *  GET /sessions/:id only means the record exists — consumers that
   *  treat res.ok as liveness must read `alive` (or GET /sessions/:id/alive)
   *  instead. */
  alive?: boolean
  /** Stamped on a row the COLD-history fallback served from its on-disk
   *  `index.json` sidecar because the registry does not hold it — see
   *  `session-cold-list.ts` and `HISTORY_CAP`. Terminal by construction
   *  (`pid` null, `alive` false): the daemon has no process for it, so it
   *  is a record, not a session you can prompt. Additive; absent on every
   *  registered row, and never persisted (cold rows never enter the
   *  registry's map, so `snapshotRows` never sees one). */
  cold?: boolean
  startedAt: string
  endedAt?: string
  exitCode?: number
  /** WHY the session ended — every stable value + its meaning is declared
   *  once, in {@link SessionEndReason} (`session-end-reason.ts`), so a UI can
   *  render a label for each without chasing the call site that set it.
   *  Three families:
   *   - automatic daemon-lifecycle teardown (unchanged, pre-existing):
   *     `"daemon-restart"` (the daemon process it lived in went away out from
   *     under it — a hard crash discovered at next boot, or a graceful
   *     shutdown/restart that force-kills whatever's still busy),
   *     `"idle-reaped"` (the idle-session reaper retired a long-idle row —
   *     deliberately kept lazy-resumable but NEVER eager-resumed on boot,
   *     since the eager pass gates on `endedReason === "daemon-restart"`),
   *     `"crashed"` (the crash-detect sweep found the adapter's OS process
   *     gone between turns with no exit event ever emitted for it — `status`
   *     is `"error"`, not `"killed"`, since nothing targeted it);
   *   - operator-issued kill: `"operator-completed"` / `"operator-stopped"`,
   *     set ONLY by an explicit `POST /sessions/:id/kill` or the `agent_kill`
   *     MCP tool (never by an internal automatic teardown), so it reads as
   *     deliberate rather than random;
   *   - other internal/automatic reasons: `"cost-cap-exceeded"` (the
   *     turn-granular `maxCostUsd` cap tripped), `"context-hard-stop"` (the
   *     context-continuity hard-stop closed a session past `hardStopAtPct`),
   *     `"policy-cleanup"` (a
   *     supervisor gate tore down its own ephemeral judge session),
   *     `"parent-exited"` (an orchestrator's dying subtree reap),
   *     `"provider-limit"` (a driver-reported subscription/usage-cap error,
   *     e.g. Claude Code's "hit your session limit"), `"forgotten"` (a live
   *     session killed as part of an operator `DELETE`), `"steward-completed"` /
   *     `"steward-abandoned"` (the session steward's `closeWithOutcome` —
   *     verdict `"done"` vs. `"abandoned"`; a `"blocked"`/`"needs-input"`
   *     verdict doesn't close at all, see `SessionDescriptor.wrapupFlag`).
   *  Absent for every terminal path this file doesn't tag (a plain natural
   *  exit, an ordinary turn error) — the session's own fault, or at least
   *  not something worth a special label. A string outside this list is
   *  still valid (a newer/older daemon) — see `isKnownSessionEndReason`. */
  endedReason?: SessionEndReason
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
  /** What this session PRODUCED — the derived outcome (Level 1) the daemon
   *  records once it reaches a terminal status, alongside (never instead of)
   *  the termination fields above: last assistant message, opened PRs, cost,
   *  run/parent links. agent-cli only. Recorded from the one exit funnel
   *  (`emitExited`) and from boot reconcile for rows that died with the
   *  daemon; first write wins unless a later one is for a new death or is
   *  richer (see `shouldReplaceOutcome`). Dropped when an in-place resume
   *  revives the row. Persisted, so it survives restarts and archiving. See
   *  `session-outcome.ts`. */
  outcome?: SessionOutcome
  /** A steward verdict of `"blocked"` or `"needs-input"` from
   *  `registry.closeWithOutcome` (`session-wrapup.ts` / FIX-9A) — recorded
   *  INSTEAD of closing, since neither verdict means the session is done.
   *  The session stays exactly as alive as it was; this is a signal for a
   *  human/orchestrator to look, not a termination. Persisted; overwritten
   *  (not accumulated) by the next flag, and left stale on the descriptor
   *  until something clears it (nothing here does — a later successful
   *  turn/close is a separate, more informative signal than deleting this). */
  wrapupFlag?: { verdict: "blocked" | "needs-input"; note?: string; judgedBy?: string; at: string } & OutcomeDetail
  /** Last time anything was written to stdout/stderr. Lets the UI
   *  spot stuck sessions ("running for 2h, last output 12min ago"). */
  lastOutputAt?: string
  /** Last time ANY adapter-process activity was observed — ACP
   *  JSON-RPC traffic, protocol-level events, not just ring-buffer
   *  output lines. Stays current during long tool-call chains where
   *  `lastOutputAt` goes stale. Updated on incoming session/update
   *  notifications AND on outbound RPC calls. ISO 8601. */
  lastActivityAt?: string
  /** Read-time projection of what the session is doing now. Tool-call phases
   *  carry the adapter-reported tool name (for example
   *  `tool-call:file_read`). Ephemeral: recomputed by list()/get() and never
   *  persisted. */
  currentPhase?: SessionCurrentPhase
  /** Whole seconds since `lastActivityAt`, computed at read time. Absent until
   *  the adapter has reported activity; never persisted. */
  secondsSinceLastActivity?: number
  /** Number of distinct tool calls observed in the current (or most recently
   *  completed) turn. Reset when the next turn starts. Tool-call enrichment
   *  events sharing an id count only once. Ephemeral and never persisted. */
  toolCallsThisTurn?: number
  /** Absolute path of this session's durable structured transcript
   *  (`events.jsonl`), resolved from the SAME base dir the transcript
   *  writer actually writes to (`sessions.eventsDir` config > the
   *  hardcoded `~/.agentproto/sessions`) — never re-derived by the
   *  caller. Ephemeral, stamped at read time (list/get) and at spawn;
   *  never persisted. Lets an external client (`agent_start`'s spawn
   *  response, Claude desktop sandbox, wait loops) discover WHERE the
   *  transcript lives without guessing. */
  eventsPath?: string
  /** Whether the underlying OS process is still alive. Computed via
   *  `process.kill(pid, 0)` at read time (list()/get()) — cheap,
   *  zero-overhead, standard POSIX check. Absent when `pid` is null
   *  (no process to check). Never persisted — recomputed fresh on
   *  every read since it's a live OS query, stale the instant it's
   *  written to disk. */
  processAlive?: boolean
  /** Summed RSS in bytes of this session's process and all its OS-level
   *  descendants (`processTreeRss`, `process-memory.ts`). Ephemeral,
   *  never persisted — stamped only when a caller opts in (`session_list`'s
   *  `withMemory: true`) since it costs a `ps` spawn; absent otherwise, and
   *  absent for a row with no `pid` or that `ps` didn't report. */
  rssBytes?: number
  /** Process-tree resource sample for this session (`process-stats.ts`):
   *  RSS, %CPU, process count, top commands by RSS - plus, at `stats:"full"`,
   *  every process. Ephemeral and opt-in (`session_list`/`agent_sessions_list`
   *  `stats`), never persisted; absent for a row with no live process. */
  stats?: Omit<import("./process-stats.js").SessionResourceStats, "sessionId">
  /** Whether the LIVE agent session's transport to its adapter is still
   *  usable — `AgentCliRuntimeSession.isConnected()`, read at the same
   *  points and with the same ephemeral, never-persisted contract as
   *  {@link processAlive}.
   *
   *  This is the second, independent liveness axis, and the one `pid` alone
   *  cannot answer. An ACP adapter's wrapper process routinely OUTLIVES its
   *  own JSON-RPC stream: the stream ends (the wrapper closed stdout, the
   *  child it fronts died, the transport errored), `process.kill(pid, 0)`
   *  still succeeds, and the row keeps reporting `running`/`alive` forever
   *  while every prompt rejects with "ACP connection closed". Observed live
   *  on 2026-09-25 (`sess_950d1251`), 40+ minutes after the connection
   *  died, with UIs still showing "Idle · live".
   *
   *  `false` ⇒ provably dead transport, and the crash-detect sweep's second
   *  ground for marking a row crashed. Absent ⇒ no live binding to ask (a
   *  terminal row, or one whose adapter models no long-lived connection) —
   *  absent is NOT "disconnected", exactly as absent `processAlive` is not
   *  "dead". */
  adapterConnected?: boolean
  /** Count of live supervisors currently blocked waiting on this session —
   *  HTTP `GET /sessions/:id/wait` long-polls and `session_monitor`
   *  subscriptions, both via `monitorSessionWait` (#session-visibility).
   *  Ephemeral, in-memory, stamped at read time (list()/get()) from the
   *  registry's waiter counter — NEVER persisted (a waiter can't survive a
   *  daemon restart). 0/absent ⇒ nothing is watching. Lets a UI mark a
   *  session "supervised — notify on turn-end". */
  watchers?: number
  /** Per-waiter detail behind the {@link watchers} count — who is blocked on
   *  this session and what they're blocked on. Same lifetime/source as
   *  `watchers` (stamped at read time from the registry's live waiter list,
   *  never persisted); empty/absent ⇒ nothing is watching. An anonymous
   *  CLI/HTTP waiter (no `callerScope`) carries no `watcherSessionId` — it
   *  still counts, it just can't be named. Lets a UI answer "who is watching
   *  this, and what are they waiting for" without guessing from the bare
   *  count. */
  watcherDetails?: readonly SessionWatcherInfo[]
  /** Count of DESCENDANT sessions (children, grandchildren, …) currently
   *  mid-turn, derived at read time from the `parentSessionId` lineage
   *  (#session-visibility, subtree rollup). Lets a UI show an idle parent that
   *  is really "delegating" — waiting on its own busy subtree — distinctly
   *  from a genuinely quiet session. Ephemeral, never persisted; 0/absent ⇒ no
   *  busy descendants. NOTE: in-process subagents a harness runs itself are
   *  invisible to the daemon between turns, so they don't count here. */
  childrenBusy?: number
  /** Count of prompts currently sitting in this session's
   *  {@link promptQueue} — a cheap, always-present badge signal for
   *  list/table/panel rendering ("N queued"), derived at read time from
   *  the live queue. Ephemeral, never persisted (the queue itself is).
   *  0/absent ⇒ nothing waiting. The full per-item detail (origin,
   *  preview, queuedAt, position) lives behind the `session_queue_list`
   *  verb / `GET /sessions/:id/queue` — this is just the scalar badge. */
  queuedPrompts?: number
  /** The queued prompts themselves, with age (`PendingPromptView`) — derived
   *  at read time from {@link promptQueue}, never persisted. Absent when
   *  nothing is waiting. */
  pendingPrompts?: PendingPromptView[]
  /** Short human-readable string describing the most recent automatic
   *  failure — currently only stamped by `markCrashed` (e.g. "adapter
   *  process gone (pid 1234) — session crashed"). Not a stack trace or raw
   *  error, just enough for a UI/log line. Absent unless something set it. */
  lastError?: string
  /** BOOTSTRAP P7b — why the LAST device-mirror sync against this
   *  session's host failed (`device-mirror.ts`), for readers to show
   *  "host unreachable" instead of silently rendering a stale mirrored
   *  transcript. Ephemeral: stamped on the descriptor at read time when a
   *  sync fails, CLEARED by the next successful sync. Absent (never "")
   *  for a session that is not device-mirrored or whose last sync passed.
   */
  mirrorError?: string
  /** ISO 8601 timestamp of the crash-detect sweep that flipped this row to
   *  `endedReason:"crashed"`. Absent for every other terminal path. */
  crashedAt?: string
  /** Epoch ms of the last known-good `lastActivityAt` reading at the moment
   *  the turn-liveness watchdog (`runStallWatchdogPass`) decided this row's
   *  in-flight turn had gone silent for too long: `busy:true`,
   *  `blockedOn` undefined (not legitimately waiting on a subagent/command),
   *  and no adapter traffic since. Distinct from a slow tool call — the
   *  target failure mode is a dead adapter stream that will never emit
   *  another frame (a network drop, a hung child), the case where `status`
   *  stays `"running"`, `lastError` stays null, and nothing else
   *  distinguishes it from healthy long work.
   *
   *  Stamped by `markStalled` (never by `list()`/read time — this is a
   *  discrete trip, not a recomputed projection), and CLEARED by
   *  `clearStalled` the moment ANY new activity is observed — the next
   *  `pulseActivity`, the next turn start, or the turn's own `finally`
   *  (busy flips false, so the mid-turn claim no longer holds). Absent
   *  (never a stale value) whenever the session isn't currently flagged
   *  stalled. Detection + signal only — nothing here kills or restarts the
   *  session. */
  stalledSinceMs?: number
  /** Counted background tool starts in the last turn; the session ended its
   *  turn without a wake-up path — likely parked. Stamped at turn-end when
   *  the turn observed one or more tool-calls whose `arguments` object
   *  carries `run_in_background: true` (how Claude Code's Bash announces a
   *  background task — matched generically on the property, not the tool
   *  name) AND the session is not `awaitingInput`. The harness's own
   *  task-completion notification does NOT trigger a new turn, so the
   *  session sits `busy:false`, `awaitingInput:false`, background tasks
   *  pending — a silent dead end. Detection + signal ONLY (same doctrine
   *  as `stalledSinceMs`): nothing here re-prompts or wakes the session.
   *  Not stamped for an agent that reports its background-task lifecycle
   *  (see `backgroundTasks`) — that one is tracked and woken for real.
   *  Cleared (deleted, never a stale value) on the next turn start and on
   *  session exit. Emits `session:bg-tasks-parked` /
   *  `session:bg-tasks-cleared`. */
  pendingBgTasks?: number
  /** The agent's background tasks that are still running (a backgrounded
   *  Bash command, a monitor, ...), as the agent itself reports them — over
   *  ACP, the AIR `asyncTasks` lifecycle. Unlike `pendingBgTasks` (a
   *  turn-end heuristic) this is the real set: a task is added when it
   *  starts and removed when it settles, so an idle session with a
   *  non-empty list is "waiting on N background tasks", not parked. When
   *  one settles while the session is idle the registry makes sure the
   *  agent is woken (see `SessionsRegistryOptions.backgroundTaskWake`).
   *  Absent when none are running; dropped on exit and on respawn (a new
   *  process owns none of the old one's tasks). */
  backgroundTasks?: SessionBackgroundTask[]
  /** ISO 8601 timestamp of the last turn that ended because the ADAPTER
   *  ITSELF reported a failure — `runAgentTurn` observed a `turn-end` event
   *  with `reason:"error"` (session-event-bus.ts's `SessionTurnEndEvent`,
   *  e.g. a refused/errored ACP `stopReason` — see adapters/mastra-agent's
   *  host) — as opposed to a thrown/rejected adapter stream, which flips
   *  `status` to `"error"` directly (a genuinely terminal row the existing
   *  crash/error handling already catches). This is the twin gap for a
   *  turn that fails IN-BAND while the process stays alive: `status` stays
   *  `"running"`, `lastError` stays unset (still reserved for `markCrashed`
   *  — see `lastTurnErrorMessage` below for the message text this field's
   *  own turn carries), and nothing else distinguishes the session from
   *  one that simply finished a clean turn and is idle. Folded into the
   *  same "stalled" activity/UI treatment a mid-turn stall gets (see
   *  sessionsTree.logic.ts's `activityFor`) rather than a new state, on
   *  the theory that both mean "the last thing this session did needs a
   *  look, not a re-prompt on faith". Stamped at turn-end when
   *  `turnEndReason === "error"` — including the case where the adapter's
   *  stream generator simply returned after emitting an in-band `error`
   *  event with no explicit turn-end and no thrown exception, which
   *  `runAgentTurn`'s P5 synthetic-reason fallback now classifies as
   *  `"error"` rather than defaulting to `"exited"`. Cleared the moment a
   *  LATER turn completes without one (same reset shape as
   *  `resumeAttempts`/`restartAttempts`). Detection + signal only. */
  lastTurnErroredAt?: string
  /** The captured error text for the turn `lastTurnErroredAt` timestamps —
   *  `evt.error.message` off the in-band stream `error` event observed
   *  during that turn (see `runAgentTurn`'s `turnErrorMessage`). Distinct
   *  from `lastError` (reserved for `markCrashed`) and from
   *  `rt.lastErrorMessage` (an internal, cross-turn, never-cleared runtime
   *  field — this one is the public, turn-scoped descriptor projection of
   *  it). Absent when the adapter reported `reason:"error"` on its own
   *  turn-end without a preceding `error`-kind stream event. Stamped and
   *  cleared together with `lastTurnErroredAt`. */
  lastTurnErrorMessage?: string
  /** True when the LAST completed turn produced zero assistant output and
   *  zero tool calls (mirrors `SessionTurnEndEvent.empty` — see that
   *  field's doc). Persisted so `monitorSessionWait`'s synchronous
   *  already-in-target-state fast-path (which has only the descriptor to
   *  read, not the triggering bus event) can surface the same "green
   *  turn-end but nothing actually happened" signal the bus/ring branches
   *  get from the event itself. Stamped every `turnCompleted` turn end
   *  (absent, not `false`, on a productive turn) — never set by the
   *  abnormal (error/abort) turn-end path, matching the bus event. */
  lastTurnEmpty?: boolean
  /** The LAST completed turn's `SessionTurnEndEvent.reason` (e.g.
   *  `"completed"`, `"error"`, `"aborted"`), when the adapter/daemon
   *  reported one. Twin of `lastTurnEmpty` — same reason for existing:
   *  the sync fast-path branch of `monitorSessionWait` has no event
   *  object to read `.reason` off, only this descriptor. Stamped at every
   *  turn end (normal or abnormal); absent when the turn ended with no
   *  reason to report. */
  lastTurnReason?: string
  /** Device-spawn only: true when this session's FIRST turn ended errored or
   *  EMPTY — the field-observed shape where a `device:<fp>` spawn lands on a
   *  host whose adapter rejects the model id and the turn completes with no
   *  assistant output, leaving the controller a healthy-looking `running`
   *  session. Stamped at the first turn-end (`runAgentTurn`) for a remote
   *  session whose `sandboxProvider` is in the `device:` family; the raw
   *  host-side error line is surfaced separately as a `notice` (see
   *  `sandbox-agent-session-proxy.ts`'s `surfaceHostTurnErrors`). Absent for
   *  local/e2b/Box sessions and for a device whose first turn was
   *  productive. */
  firstTurnFailed?: boolean
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
  /** The `SessionsRegistry.bootId` of the daemon boot that followed the
   *  restart which cut this row's turn off. The graceful shutdown that
   *  interrupts a turn parks `INTERRUPTED_PENDING_BOOT` here; the next boot
   *  reload (`loadHistorySnapshot`) swaps that — or, after an unclean exit, a
   *  row still alive on disk — for its own `bootId`. Nothing else is ever
   *  stamped: an interrupted row carrying no marker was persisted by a daemon
   *  predating it, i.e. by an older restart, and stays stale. Cleared on the
   *  next successful turn-end (with the markers it
   *  qualifies). `interruptedAtBoot === registry.bootId` is how the
   *  continue-interrupted verb and boot pass pick "interrupted by the LAST
   *  restart" apart from a stale interruption nobody picked back up. PERSISTED
   *  (unlike the derived `interrupted`) — the boot that stamped it may not be
   *  the one reading it. */
  interruptedAtBoot?: string
  /** How many automatic continue prompts the daemon has sent this row
   *  (`daemon.continueInterruptedOnBoot`) since its last successful turn-end.
   *  Incremented BEFORE the prompt is sent, so a continue turn that itself
   *  gets cut off by another restart still counts; reset on the next
   *  successful turn-end. The boot pass stops at
   *  `MAX_AUTO_CONTINUE_ATTEMPTS` — the no-loop bound for a turn that keeps
   *  taking the daemon down with it. PERSISTED; absent until the first one. */
  autoContinueAttempts?: number
  /** `bootId` of the boot whose pass last auto-continued this row — the
   *  at-most-one-auto-continue-per-restart guard. Reset with
   *  `autoContinueAttempts`. */
  lastAutoContinueBoot?: string
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
  /** Opt-in auto-restart policy (restart-scheduler, PR-2). Absent ⇒ a dead
   *  session only comes back via lazy resume-on-prompt, exactly like today.
   *  See {@link RestartPolicy}'s doc for the full contract. */
  restartPolicy?: RestartPolicy
  /** How many restarts the scheduler has PROACTIVELY fired in a row for this
   *  session since its last sustained healthy turn-end (§ restart-scheduler
   *  PR-2). DISTINCT from `resumeAttempts`: that counter caps consecutive
   *  FAILED in-place revivals; this one feeds the exponential-backoff
   *  exponent for a session that resumes FINE but keeps re-crashing — which
   *  would reset `resumeAttempts` to 0 every time and loop forever without
   *  its own counter. Reset to absent on the next turn that runs to
   *  completion. PERSISTED so the backoff curve survives a daemon restart
   *  mid-sequence. */
  restartAttempts?: number
  /** ISO 8601 timestamp of the most recent restart the scheduler scheduled
   *  (not necessarily executed yet) for this session. Reset alongside
   *  `restartAttempts`. */
  lastRestartAt?: string
  /** ISO 8601 timestamp the restart-scheduler's periodic sweep should next
   *  attempt an in-place resume of this row (the backoff delay's landing
   *  time). Absent ⇒ nothing scheduled. PERSISTED so a daemon restart
   *  mid-backoff still resumes the schedule on the next sweep tick rather
   *  than silently dropping it (eager resume-on-boot only covers
   *  `endedReason:"daemon-restart"`, never `"crashed"`). Cleared once the
   *  sweep executes it (whether the resume succeeds or fails — a failure
   *  path re-schedules via the next `session:exited`) or the scheduler
   *  gives up on the crash-loop cap. */
  nextRestartAt?: string
  /** Set alongside `nextRestartAt` when the scheduled restart is a FRESH-BOX
   *  move (`restartPolicy.on` includes `"sandbox-gone"` and the box is gone)
   *  rather than an in-place resume: the sweep dispatches such a schedule to
   *  `triggerSandboxGoneRestart` (the same `session_restart` fresh-box path)
   *  instead of `triggerResume`. Cleared with `nextRestartAt`. */
  nextRestartFreshBox?: boolean
  /** Rolling window of ISO 8601 timestamps for restarts the scheduler has
   *  fired, trimmed to entries within the policy's `windowMs` of "now" at
   *  each evaluation. Distinct from `restartAttempts` (a single counter
   *  driving the backoff exponent): this is what the crash-loop cap
   *  actually counts against `maxRetries`. Reset alongside `restartAttempts`
   *  on a healthy turn-end. */
  recentRestartAts?: string[]
  /** Opt-in turn-retry policy (`agent_start.turnRetry`). Absent ⇒ a turn that
   *  fails on a transient provider error (429, 5xx, silent no-output stall)
   *  just stops, exactly like before. DISTINCT from `restartPolicy` (which
   *  revives a dead process): this re-prompts a LIVE session with a short
   *  continuation prompt — see `turn-retry.ts`. */
  turnRetry?: TurnRetryPolicy
  /** The AGENT level of the AIP-68 clerk hook (`agent_start.hooks.clerk`,
   *  or the agent manifest's `metadata.hooks.clerk`). Recorded verbatim so
   *  the clerk-turn-end controller can resolve the three-level
   *  configuration (agent > workspace > daemon default) per session - see
   *  `clerk-hook-config.ts`. Absent ⇒ this session contributes no agent
   *  level, and the less specific level applies. */
  clerkHook?: Partial<ClerkHookConfig>
  /** Consecutive continuation prompts the turn-retry controller has SENT
   *  since the last clean turn-end — the retry counter, compared against
   *  `turnRetry.maxRetries`. Reset (deleted) by the next turn that completes
   *  without an error or an interrupt. PERSISTED; absent until the first
   *  retry. */
  turnRetryAttempts?: number
  /** Consecutive box migrations the turn-retry controller has DONE since the
   *  last clean turn-end (`turnRetry.action: "migrate"` on a sandbox session)
   *  — the migration counter, compared against `turnRetry.maxMigrations`.
   *  Independent of {@link turnRetryAttempts}; reset (deleted) by the next
   *  turn that completes without an error or an interrupt. Carried over onto
   *  the migrated session so the cap survives a migration. PERSISTED; absent
   *  until the first migration. */
  turnMigrations?: number
  /** ISO 8601 timestamp of the most recent continuation prompt the
   *  turn-retry controller sent. Reset with `turnRetryAttempts`. */
  lastTurnRetryAt?: string
  /** ISO 8601 landing time of a scheduled-but-not-yet-sent turn retry.
   *  In-memory timer backed: a daemon restart drops the pending retry (the
   *  continue-interrupted path covers that case), and the field is cleared
   *  when the retry fires, is cancelled, or the session exits. */
  nextTurnRetryAt?: string
  /** Free-text label the spawner can attach (e.g. conversation id,
   *  operator name) so the UI can group/filter. */
  label?: string
  /** Correlation key of the work this session does: the task the session was
   *  spawned FOR. A relaunch links itself to the dead session carrying the
   *  same task id (see `checkpoint-resume.ts`) and restores that session's
   *  last checkpoint. Absent on sessions spawned without a task id. */
  taskId?: string
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
  /** ISO-8601 instant `archiveSession` set `archived: true`; cleared by
   *  `unarchiveSession`. Absent on rows archived before this field existed. */
  archivedAt?: string
  /** ISO-8601 instant this row was deliberately retired AFTER it had already
   *  ended (e.g. `kill(id, sig, "operator-stopped")` on a row the idle-reaper
   *  or a crash had already ended, `markOutcomeCompleted`) — `endedReason`
   *  can't always record that, so this stamp is the second half of
   *  {@link isRetired}. Cleared by an explicit (forced) revival. */
  retiredAt?: string
  /** When `true`, the idle-reaper (`isReapable`, `idle-reaper.ts`) never
   *  retires this session regardless of how long it's sat idle. For a
   *  supervisor that legitimately parks — waiting on a child, waiting on a
   *  scheduled wake — idle looks identical to finished, and the reaper would
   *  otherwise pull the rug out from under it. Set at spawn time
   *  (`keepAlive` on `SpawnAgentInput`) or toggled later via
   *  `session_set_keepalive` (`registry.setKeepAlive`). Absent (not `false`)
   *  for every session that hasn't opted in. */
  keepAlive?: boolean
  /** Server-persisted, list-visibility-only favorite flag — set/cleared via
   *  `session_set_pinned` (`registry.setPinned`) or `POST /sessions/:id/pin`.
   *  Purely a sort/display concern: pinned sessions sort to the top of the
   *  session list (CLI table, VS Code webview's dedicated "Pinned" group).
   *  Deliberately orthogonal to — and must NEVER be confused with —
   *  `keepAlive` (idle-reaper exemption, operational), the VS Code
   *  extension's client-side-only "watch" eye (toast notifications, never
   *  persisted here), or `watchers` (live supervisor wait count). No side
   *  effects on reaping, notifications, or anything else. Absent (not
   *  `false`) for every session that hasn't been pinned. */
  pinned?: boolean
  /** Who may drive this session through the daemon MCP drive tools besides
   *  its owner (the session that spawned it, or the operator for a root
   *  spawn): session ids, or the wildcard `"any"` to allow any caller
   *  session. Refusal otherwise — see `checkSessionOwnerGate`
   *  (session-owner.ts). Set at spawn time (`agent_start.allowPromptFrom`)
   *  and via `agent_set_prompt_policy`; only the owner, the session itself,
   *  and the operator may change it there. Absent = owner+operator only. */
  allowPromptFrom?: string[]
  /** The operator-assigned, IMMUTABLE label of a root session: set only by
   *  the daemon, at `agent_start` time, when the spawn carried NO caller
   *  session (i.e. the human operator or an operator-side client spawned it),
   *  and carried across restart / continue-fresh. Unlike `label`, no tool
   *  can change it (`session_rename` only touches `label`), so a
   *  `label:` entry in another session's `allowPromptFrom` can safely key on
   *  it — see `checkSessionOwnerGate`. Absent for every session spawned by
   *  another session. */
  operatorLabel?: string
  /** Ascending position among pinned sessions — the stored order behind
   *  the pinned group of the CLI table / VS Code webview list. Set by
   *  `registry.setPinned` (append-at-end) and `registry.reorderPinned`
   *  (manual reorder); deleted when the session is unpinned. Absent on
   *  legacy pinned rows persisted before this field existed — those sort
   *  after every ordered pinned session (by `startedAt` asc, then id).
   *  Pure sort/display state, same as `pinned` — never touches the live
   *  agent, keepAlive, or the idle-reaper. */
  pinnedOrder?: number
  /** True when the session was spawned under a real PTY (node-pty)
   *  instead of `child_process.spawn`. PTY sessions carry raw ANSI
   *  bytes (alt-screen, key bindings, colors); attach goes through
   *  WS /sessions/:id/pty rather than SSE /sessions/:id/stream. */
  pty?: boolean
  /** DEPRECATED, read-only legacy alias for {@link slug}. Pre-`slug`
   *  sessions used this as the terminal-only addressing handle; it is never
   *  written by the daemon anymore (`spawnAgent`/`spawnPty` write `slug`
   *  instead). Kept readable so a legacy row still resolves — see
   *  {@link getSlug} (`slug ?? name`) and the resolver in `session-ref.ts`,
   *  which matches both. */
  name?: string
  /** Human-readable, UNIQUE handle for this session (the addressing `slug`
   *  of the session-addressing plan). Minted through `mintSlug` and
   *  de-duplicated with `-2`, `-3`, … against every session currently held,
   *  falling back to `sess-<shortid>` when the input slugifies to empty:
   *  `spawnAgent` slugs `title || label || adapterSlug || kind`;
   *  `spawnPty` slugs `name || label || adapterSlug || "terminal"` (a
   *  caller-supplied terminal `name` wins, else the display label, else the
   *  classified provider slug); the boot backfill slugs
   *  `name || title || label || adapterSlug || kind`, preferring a legacy
   *  row's existing `name` handle. Overridable via `session_rename`/
   *  `renameSession`. Never empty once a session exists; addressable through
   *  `sessionId`/`idOrName`/`slug` everywhere. `name` is its deprecated alias
   *  (`getSlug(desc)`), never a second source of truth. */
  slug?: string
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
  /** Absolute path of the PRIMARY checkout `worktreePath` was cut from (the
   *  repo root a `worktree_status` query targets), read at spawn from the
   *  worktree admin dir's `commondir` file (`resolveWorktreeIdentity`).
   *  Absent whenever `worktreePath` is, when `commondir` was unreadable, and
   *  for every session persisted before this field existed. */
  mainRepoPath?: string
  /** `true` only when `worktreePath` was provisioned by the `worktrees.isolation`
   *  policy WITHOUT an explicit `worktree` request from the caller (see
   *  `decideWorktreeIsolation`'s `WorktreeDecision.provision.implicit` in
   *  `worktree-isolation.ts`) — a worktree the caller never asked to keep.
   *  Gates exit-time auto-reclaim (`emitExited` below, via the injected
   *  `WorktreeAutoReclaimer` port): only an implicit worktree is ever a
   *  candidate for automatic removal on session exit. Absent (never `true`)
   *  for a worktree the caller explicitly requested (`worktree: {...}` on
   *  the spawn), which keeps today's manual-cleanup-only behavior unchanged,
   *  and absent for every session persisted before this field existed. */
  worktreeAutoProvisioned?: boolean
  /** Absolute path of the AGENTS.md the daemon resolved for this session's
   *  spawn `cwd` (walking up, bounded by the repo's git toplevel — see
   *  `agents-md.ts`), whose content or pointer was injected into the initial
   *  prompt. Absent when `agentsMdMode` is `"absent"` and for a session
   *  persisted before this field existed. */
  agentsMd?: string
  /** How the resolved AGENTS.md was injected at spawn: `"inline"` (full
   *  content), `"pointer"` (read-it-first instruction), or `"absent"` (the
   *  walk found none — a real, reported state, a consumer distinguishes it
   *  from the field being missing in an old descriptor shape by checking
   *  `=== "absent"`). The daemon's spawn path (`session-spawn.ts`) ALWAYS
   *  stamps this once resolution ran — it is optional on the type only so
   *  legacy persisted descriptors (pre-WP-R2) and non-AGENTS.md-aware
   *  constructor paths don't have to fabricate a value; a freshly-spawned
   *  session always carries it. */
  agentsMdMode?: AgentsMdMode
  /** Absolute path of the per-workspace `RULES.md` the daemon resolved for
   *  this session's spawn workspace (see `workspace-rules.ts`) — read from
   *  the workspace's state bucket (`~/.agentproto/workspaces/<slug>/
   *  RULES.md`) and injected into the initial prompt of EVERY spawn in the
   *  workspace (root and nested, no depth gate). Present only when a rules
   *  file was actually found and injected; `undefined` means absent (there
   *  is no separate inline/pointer/absent tri-state — the field itself being
   *  undefined already means absent). */
  rulesMd?: string
  /** Pull requests opened while this session was acting on a code host.
   *
   * This is deliberately session provenance rather than workspace state: a
   * session may open more than one PR, and the same workspace can have many
   * independent sessions. It is append-only and persists with the descriptor
   * so a restarted daemon can still show the hand-off / review links. */
  openedPrs?: readonly OpenedPullRequest[]
  /** Adapter slug for agent-cli sessions — restart uses this with
   *  `/sessions/agent` to spin up a fresh ACP runtime. ALSO stamped on a
   *  conversation-terminal PTY (`isConversationTerminal` — a native
   *  provider TUI launch like `claude`, classified at `spawnPty`), so the
   *  Sessions list, the link probe, and the harness switch know which
   *  provider the terminal is. Undefined for plain-shell PTYs and command
   *  kinds. */
  adapterSlug?: string
  /** Manifest-declared `capabilities.resumable` for this session's adapter
   *  (AIP-45), stamped from {@link AgentAdapterResolver}'s resolved
   *  descriptor at spawn/restart time — see that field's doc for the full
   *  contract. `false` means a captured `adapterSessionId` cannot actually
   *  rehydrate this adapter's conversation, so the resume path
   *  (`resume-strategies.ts`) must never present it as continuity. Omitted
   *  for pty/command kinds and for any row persisted before this field
   *  existed — treated the same as `true`/unknown everywhere it's read, so
   *  a legacy row's behaviour is unchanged. */
  resumable?: boolean
  /**
   * Manifest-declared `capabilities.nativeTerminalResume` for this session's
   * adapter (AIP-45), stamped from {@link AgentAdapterResolver}'s resolved
   * descriptor at spawn/restart time. Governs whether a restart may use the
   * provider's native CLI resume argv as a PTY session (`pty-native`). Only
   * adapters with a verified native TUI resume (e.g. claude-code, hermes)
   * set this; ACP resumability (`resumable`) alone does NOT imply terminal
   * compatibility. Omitted for pty/command kinds and legacy rows — treated
   * as false.
   */
  nativeTerminalResume?: boolean
  /**
   * Canonical harness slug for agent-cli sessions — the same identity as
   *  `adapterSlug`, recorded under the canonical axis name. Falls back to
   *  `adapterSlug` when not explicitly set. Undefined for pty/command kinds. */
  harness?: string
  /**
   * How this adapter's spawn ROUTE relates to the chosen model (AIP-45
   * launch-menu drill-down). `"derived-from-model"` means the endpoint falls
   * out of the model id's own vendor prefix; `"free"`/omitted means the route
   * is an independent choice. Recorded at spawn time so a live `setModel` can
   * apply the same wire normalization the spawn path used.
   */
  routeSelection?: "free" | "derived-from-model"
  /**
   * The adapter manifest's provider (`authDescriptor.provider`) — e.g.
   * `"anthropic"` for claude-code, `"openai"` for codex. Recorded at spawn
   * time so a live `setModel` knows when it can safely bare a
   * `vendor/product` direct ref; ignored for derived-from-model adapters.
   * Distinct from `auth.provider`, which is the resolved billing wallet and
   * may name a gateway route.
   */
  adapterProvider?: string
  /**
   * The adapter manifest's `authDescriptor.modelDerivedApiKey` — recorded at
   * spawn time so a live `setModel` applies the SAME wire normalization the
   * spawn path used (`normalizeModelForWire`'s `ModelWireOptions.modelDerivedApiKey`
   * doc): for a `derived-from-model` adapter billed through a gateway/router,
   * this decides whether the wire model needs the router re-added as a
   * literal leading segment (opencode/mastracode/jcode/pi/mastra-agent) or
   * left bare (hermes).
   */
  modelDerivedApiKey?: boolean
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
  /**
   * The model believed to be ACTIVE right now, when it may differ from
   * `model` above (the requested/spawn-time value). Populated by a
   * successful live `setModel` (mirrors `model` — the switch went through
   * this daemon, so both facts agree) or, more importantly, by picking a
   * model-switch acknowledgement out of an ORDINARY prompt turn whose text
   * opened with `/model <id>` (`@agentproto/driver-agent-cli`'s
   * `isModelSwitchAcknowledgement`/`parseModelSwitchCommand` —
   * `applyModelCommand`'s dedicated control turn never runs for that case,
   * since the switch never went through `agent_set_model`).
   *
   * That second source is REPORTED BY THE ADAPTER'S OWN REPLY TEXT, NOT
   * INDEPENDENTLY VERIFIED — a deliberately lax match good enough as a
   * display hint for a UI chip, NEVER a source of billing/cost truth. Never
   * overwrites `model`: losing the spawn-time request would lose the very
   * thing that lets a client show the two facts diverging.
   */
  activeModel?: string
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
  /**
   * Read-surface echo of the live harness's advertised ACP session modes
   * (`SessionModeState.availableModes`, #482) — stamped at READ TIME from the
   * live agent session by `list()`/`get()`, never persisted. A client posture
   * picker resolves the native (enforced, live-switchable) rows from this;
   * absent for arms with no native mode registry (print/proprietary) and for a
   * session whose live runtime handle is gone.
   */
  availableModes?: SessionMode[]
  /**
   * Read-surface echo of the live harness's advertised ACP session CONFIG
   * options (the `session/new` / `session/load_session` response
   * `configOptions`) -- stamped at READ TIME from the live agent session by
   * `list()`/`get()`, never persisted.
   *
   * The `model` entry is what makes a live model switch possible WITHOUT an
   * error: it lists the model values the RUNNING agent accepts for its own
   * model config option, and it rejects anything else ("Invalid value for
   * config option model: <id>"). A client picker therefore offers THESE
   * values for a live switch, and treats a catalog id outside this vocabulary
   * as restart-only -- never as a live switch that would fail.
   *
   * Absent for arms with no config registry (print/proprietary) and for a
   * session whose live runtime handle is gone.
   */
  configOptions?: SessionConfigOption[]
  /**
   * Read-surface echo of the canonical postures the live session's adapter
   * enforces through its isolated spawn config (`spawnEnforcedPostures` on
   * the agent session) — stamped at READ TIME alongside `availableModes`,
   * never persisted. With `availableModes` it is what `postureEnforcement`
   * (canonical-posture.ts) classifies a posture as native / spawn-config /
   * prompt-advisory from.
   */
  spawnEnforcedPostures?: string[]
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
   * credential (adapters declaring `authSubscription` and/or an API-key
   * `provider`). The "verifiability" answer to "what
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
  /** Cumulative prompt-cache read / cache-creation / reasoning tokens, from
   *  the adapter's usage reader (claude-code transcript, hermes state.db,
   *  opencode.db). Absent when the adapter doesn't expose them — never
   *  zero-filled. See `UsageDetail` in usage.ts. */
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  /** Tool calls the daemon observed across completed turns (cumulative).
   *  Stamped at the first turn end, so absent = no turn has finished yet. */
  toolCalls?: number
  /** Wall time spent inside turns, cumulative ms. Same cadence as
   *  `toolCalls`. */
  durationMs?: number
  /** Context-window size + tokens-in-context from the latest `usage_update`
   *  event (ACP adapters that report a context window). Refreshed live as
   *  usage_update events arrive, not just at turn-end. */
  contextSize?: number
  contextUsed?: number
  /** Where `contextSize` came from — `"adapter"` (a cost-bearing, authoritative
   *  usage_update; sticky), `"catalog"` (model-catalog window for the model),
   *  or `"reported"` (the adapter's own, possibly inferred, frame size). See
   *  `context-window.ts` for the precedence. */
  contextSizeSource?: ContextSizeSource
  /** Where `costUsd` came from — `"adapter"` (adapter's own reader or a
   *  usage_update cost block), `"computed"` (tokens × in-repo catalog price),
   *  `"no-pricing"` (tokens present but the model isn't in the catalog — cost
   *  deliberately left undefined), or `"none"`. Stamped live on each
   *  cost-bearing usage_update / reader read, and re-derived at turn-end. */
  usageSource?: import("./usage.js").UsageSource
  /** Latest known `available_commands_update` payload (see @agentproto/acp's
   *  `StreamEvent`'s `available-commands` kind) — the slash-commands/skills
   *  the agent currently supports. Each notification REPLACES the previous
   *  list wholesale, so this always mirrors the most recent one, not a
   *  merge across notifications. */
  availableCommands?: Array<{
    name: string
    description?: string
    input?: { hint?: string } | null
    _meta?: { scope?: string; path?: string; bareName?: string; qualifiedName?: string }
  }>
  /** ACP-level session id (the adapter's own handle — claude-code's
   *  conversation id, hermes' chat id, …). Set at spawnAgent time
   *  from `agentSession.sessionId`. Survives across daemon restarts
   *  via sessions.json so `restart` can pass it as `resumeSessionId`
   *  and reattach to the prior conversation history. */
  adapterSessionId?: string
  /** Persistent isolated-config dir handed to the adapter at spawn time
   *  (`startSession({ configDir })` → claude-code's `CLAUDE_CONFIG_DIR`).
   *  Keyed by the FIRST session id in a restart lineage
   *  (`adapterConfigDirFor`) and carried forward verbatim across
   *  restarts/lazy resumes — the provider's own conversation store lives
   *  inside it, so reusing the SAME dir is what lets `resumeSessionId`
   *  restore full context after the adapter process died (before this,
   *  each respawn minted a fresh temp dir and native resume always
   *  degraded to the daemon-transcript digest). Absent on legacy rows and
   *  adapters that don't isolate a config dir. */
  adapterConfigDir?: string
  /** MCP servers mounted into the agent's session at spawn time
   *  (orchestrator WP1). Persisted so the resume/re-spawn path can
   *  re-mount the same host-chosen toolset instead of resuming a
   *  capability-stripped agent. The current `AcpMcpServer` shape is
   *  `{ name, transport, ref? }` — a reference, NOT inline credentials
   *  — so this carries no secrets today. Should the shape ever grow
   *  headers/tokens, NEVER log this field's contents. */
  mcpServers?: AcpMcpServer[]
  /** Resolved skills list at spawn time — explicit ∪ preset ∪ config
   *  defaults (`resolveSpawnDefaults`'s own merge), recorded regardless of
   *  whether the adapter actually CONSUMES a `skills` spawn option (today
   *  only hermes does — see `normalizeSkillsOption`). Persisted so it
   *  survives restart/resume like `mcpServers`, and so a read surface
   *  (`session_capabilities`) can show what was resolved even for an
   *  adapter (claude-code) that auto-discovers skills on its own and never
   *  reads this list back. */
  skills?: string[]
  /** Resolved imported skills DELIVERED into this session's isolated config
   *  dir at spawn time — the `{alias, path}` pairs `session-spawn.ts` derived
   *  from the skill-imports registry (`resolveSessionSkills`). Persisted so
   *  restart/lazy-resume re-deliver the SAME set instead of reviving an
   *  adapter whose imported skills silently vanished. Distinct from `skills`
   *  (the adapter-facing id list): these name concrete copied folders under
   *  `~/.agentproto/skills/<id>/`. */
  sessionSkills?: ResolvedSessionSkill[]
  /** Extra system-prompt text the spawn asked for (the AIP-42 AGENT.md
   *  body) — recorded verbatim so restart / fresh-continuation re-apply it
   *  (through the adapter's declared channel when one exists, else the same
   *  first-prompt prefix + warning the original spawn used — see
   *  `session-spawn.ts`'s channel decision). Absent ⇒ nothing to re-apply. */
  appendSystemPrompt?: string
  /** Capability bundle ids (`bundle_list`) resolved for this spawn (PLAN D
   *  phase 1) — ids only, never the expanded imported-MCP snapshots (those
   *  live only in `mcpServers` above, as reference-only proxy URLs). Absent
   *  ⇒ no bundle was attached. */
  bundles?: string[]
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
  /** Conversation-terminal link probe verdict — `"ambiguous"` when MORE
   *  than one fresh native transcript matched this PTY's cwd + start time,
   *  so the daemon refused to bind any of them (never bind a sibling —
   *  same invariant as the fs-probe's exact-bind rule). Absent while the
   *  probe is still looking, and cleared once an unambiguous link lands
   *  (`adapterSessionId` + `resumeMetadata`). Only ever set on
   *  conversation-terminal rows (`isConversationTerminal`). */
  linkStatus?: "ambiguous"
  /** Extra env this PTY (`kind: "terminal"`) session was spawned with, on
   *  top of `process.env` — e.g. `{ CLAUDE_CONFIG_DIR: "..." }` for a
   *  `pty-native` restart of a claude-code session (see
   *  `ResumeStrategy.configDirEnvVar`, resume-strategies.ts). Once a
   *  restart lands on a bare PTY row, `adapterSlug`/`adapterConfigDir` are
   *  gone (undefined for pty/command kinds, by design — see those fields'
   *  docs), so this is the ONLY way a LATER `pty-plain` restart-of-a-
   *  restart can still know what env the provider's native resume needs —
   *  `session_restart`'s pty-plain branch replays it verbatim, the same way
   *  it already replays `argv`. Absent when the PTY was spawned with no
   *  extra env (a plain `agentproto sessions terminal`, or a `pty-plain`
   *  restart of one). */
  ptyResumeEnv?: Record<string, string>
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
  blockedOn?: "subagent" | "command" | "inbox"
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
  /** A REMOTE parent: this session lives in a BOX daemon's registry while its
   *  parent lives in the HOST daemon's registry (see
   *  `docs/lineage-handover.md`, "Known gap - sessions running INSIDE a box"
   *  and `parent-relay.ts`). The block is forwarded by the host at spawn
   *  time; `message_parent` POSTs the report to the host's relay endpoint
   *  instead of looking the parent up locally. Present ONLY on the box-side
   *  row - the host's own row keeps its ordinary `parentSessionId`.
   *
   *  The relay TOKEN is deliberately NOT here: it is a secret, so it lives
   *  in an in-memory map keyed by the session id (see `parent-relay.ts`'s
   *  `rememberRelayToken`) and never reaches a descriptor - and therefore
   *  never reaches disk. */
  remoteParent?: {
    sessionId: string
    url: string
  }
  /** Opt-in (default false/absent): when this session crashes
   *  (`markCrashed` → `session:exited` with `status:"error"`/
   *  `reason:"crashed"`), the supervisor-notify subscriber
   *  (`supervisor-notify.ts`) delivers a `[child-crashed]` notice to its
   *  `parentSessionId`, if any — dispatched now when the parent is alive
   *  and idle, or parked in its `promptQueue` and drained as its own turn
   *  when the parent's current turn ends. The free external
   *  webhook path (`notifyUrl`) already fires regardless of this flag; this
   *  only gates the additional IN-BAND signal into the parent's own
   *  session, which a caller that isn't a delegating supervisor doesn't
   *  want. Threaded like `permissionHold` — set at spawn time, immutable
   *  thereafter. */
  notifyParentOnCrash?: boolean
  /** Per-spawn opt-out of sentinel auto-link (AIP-60 §6/step 4,
   *  `agent_start.sentinel: false`). `undefined`/`true` = allowed (subject to
   *  `config.sentinel.autoWatchPrs`); `false` = this session's opened PRs are
   *  never auto-watched, no matter the config. Set once at spawn, immutable
   *  thereafter — same threading as `notifyParentOnCrash`. */
  sentinelAutoWatch?: boolean
  /** True when the session was spawned in permission-hold mode. */
  permissionHold?: boolean
  /** Effective OS-level confinement of the adapter's own process
   *  (`agent_start.commandSandbox`, else the workspace's
   *  `.agentproto/command-sandbox.json` `adapterSpawn.mode`), resolved at
   *  spawn with the same precedence the driver applies
   *  (`wrapAgentCliSpawn`). Absent when neither engaged the axis (the spawn
   *  ran unconfined without anyone choosing a mode), for a `sandbox` spawn
   *  (confinement is the box's business), and for sessions persisted before
   *  this field existed. Set at spawn time, immutable thereafter. */
  commandSandbox?: "off" | "workspace" | "strict"
  /** @deprecated Retired — child reports and `[child-crashed]` notices for a
   *  busy session are now queued as their own `promptQueue` items
   *  (`source:"child:<id>"`) instead of being string-prepended onto the next
   *  prompt. Only read once, at boot, by `migratePendingChildNotices`, which
   *  moves any notices a pre-upgrade daemon persisted into `promptQueue` and
   *  deletes this field. Never written. */
  pendingChildCrashNotices?: string[]
  /** True once this session has been taught the `<agentproto-message>`
   *  invariant (`MESSAGE_PREAMBLE`) — sent as a `system-prompt` slice ahead
   *  of the FIRST message turn it receives, never again. */
  messagePreambleSent?: boolean
  /** Durable, bounded inbox of typed messages NOT yet consumed (AIP-46
   *  §Session messages): every accepted message lands here until it's
   *  delivered into a turn (auto-acked), returned by `inbox_wait` with
   *  `ack`, or acked via `inbox_ack`. `fyi` messages only ever live here
   *  (surfaced as a digest). Capped at `INBOX_CAP`, oldest dropped first
   *  (`[inbox] dropped`). Full history lives in the transcript, not here.
   *  New array on every mutation, like `promptQueue`. */
  inbox?: SessionMessage[]
  /** What the live agent session can do, read from its driver at attach
   *  time (spawn / resume) — shown in `session_list` so a sender can predict
   *  a message's delivery tier. `steering`: the agent accepts ACP steering
   *  (`_session/steering`) — a `steer` message can be injected into its
   *  running turn instead of waiting for it to end. `commandsSupported`:
   *  the live agent session is the ACP protocol arm (has a working `steer`
   *  method — only the ACP arm implements it, per `AgentSessionLike`'s own
   *  doc), which is what actually emits `available_commands_update`
   *  notifications; false for the print/proprietary arms regardless of
   *  `steeringSupported`, since a harness can be ACP without advertising
   *  the steering extension. Read by `session_capabilities` to derive its
   *  `arm`/`commandsSupported` fields without re-deriving the signal. */
  capabilities?: { steering: boolean; commandsSupported: boolean }
  /** FIFO of prompts that arrived while this session was mid-turn and
   *  asked to be QUEUED rather than rejected (`enqueuePrompt`'s
   *  `opts.queue` arm — see its doc comment). Index 0 is next to
   *  dispatch. A plain queued item is appended to the back; a
   *  `force`-queued one is inserted at the front, jumping everything
   *  already waiting WITHOUT cancelling the live turn (that's what
   *  `interrupt` is for). Drained one item at a time, in this order, by
   *  `dispatchQueuedPrompt` at the end of every `runAgentTurn` — never
   *  by the caller that queued it, which already returned. Always
   *  replaced with a NEW array reference on every mutation (push, drain,
   *  removal), never mutated in place — the VS Code webview's
   *  `sessionDescriptorsEqual` diff is a shallow `!==` per field, so an
   *  in-place `.shift()` here would silently stop propagating queue
   *  changes to the transcript panel. `[]` (not absent) once anything
   *  has ever been queued. */
  promptQueue?: QueuedPrompt[]
  /** Best-effort context-handoff digest (Fix D), stashed on a descriptor
   *  whose resume degraded to a BLANK spawn — the adapter's own
   *  conversation store was missing, or the adapter declared `resumable:
   *  false` — built by `buildResumeContextDigest` from the daemon's own
   *  `events.jsonl` transcript, which survives both cases. Flushed and
   *  cleared by prepending it onto the first dispatched turn's message
   *  (`runAgentTurn`), exactly once. Gated strictly on the blank-fallback
   *  flags at the two sites that set it (`session-restart-core.ts`,
   *  `maybeResumeAgent` here) — never set for a resume that actually
   *  restored context, so a real continuation is never double-fed its own
   *  history. Absent when nothing is queued. */
  pendingResumeContext?: string
  /**
   * Resolved context-continuity policy for this session. Stored on the
   * descriptor so status queries and turn-boundary evaluation see the same
   * effective policy.
   */
  contextContinuity?: ResolvedContextContinuityPolicy
  /** True when the session has been hard-stopped by the context-continuity
   *  policy — no new prompt may be admitted. */
  contextContinuityHardStopped?: boolean
  /** The context percentage at which the user last answered "keep-going" to
   *  the `ask`-mode continue-fresh question. `evaluateContextContinuity`
   *  won't re-raise the same question until `contextPct` climbs past this
   *  value again — otherwise the very next turn-boundary check (context
   *  hasn't moved) would immediately re-ask, since the `ask` state covers
   *  the whole `[compactAtPct, hardStopAtPct)` band, not just the instant it
   *  was crossed. The hard-stop threshold is never suppressed by this — it
   *  is checked ahead of `ask` in `contextContinuityStateForPct` and fires
   *  regardless of any acknowledgment. */
  contextContinuityAckedAtPct?: number
  /** Id of the most recent checkpoint created for this session. */
  checkpointId?: string
  /** The source session id when this row continues another one: a
   *  continue-fresh handoff OR a revival (restart / cron / sentinel / inbound
   *  wake / direct resume of the same adapter conversation — also recorded as
   *  `resumedFrom`). Absent on a row that started a conversation. */
  continuedFrom?: string
  /** Separate lineage from `continuedFrom` — how many continue-fresh /
   *  revival hops this generation is away from the lineage's start: the
   *  first continuation of a base session is 1, then +1 per further hop
   *  (a base row has none). Persisted like `continuedFrom`, which always
   *  carries the previous hop's id; a UI can render a "↻ N" badge or walk
   *  the chain via `continuedFrom` without recomputing it. */
  continuationGeneration?: number
  /** The row that continued this one (the inverse of `continuedFrom`); the
   *  latest continuation wins when a row is revived more than once. */
  continuedTo?: string
  /** Lineage handover (see {@link SessionDescriptor.succeededBy}) - the
   *  session this one was DECLARED to succeed: the row whose live children
   *  were re-attached to this session when it was created (an
   *  `agent_start.succeeds` declaration, or a continue-fresh continuation).
   *  Absent on a row that never took over another row's position. */
  succeeds?: string
  /** Lineage handover - the session that TOOK OVER this row's position: its
   *  live children were re-parented to it, so it can drive them and they
   *  report to it (`message_parent`). Set by the handover itself, in both
   *  directions (`from.succeededBy = to` / `to.succeeds = from`), and
   *  persisted so the declaration survives a daemon restart - it is what
   *  authorizes `session_adopt`. */
  succeededBy?: string
  /** Set alongside `continuedFrom` on the NEW session — the harness the
   *  checkpoint moved from/to and when. Present on every `continue_fresh`
   *  spawn, not just a cross-harness one, so a same-harness continuation
   *  and a genuine handoff are both traceable the same way. See
   *  {@link SessionHandoff}. */
  handoff?: SessionHandoff
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
  /** `kind: "external"` only: the connecting client's `host` query param
   *  (e.g. `claude-desktop`). */
  externalHost?: string
  /** `kind: "external"` only: ISO instant of the session's last MCP request
   *  (or inbox poll). The row is alive while `now - lastSeenAt` is inside the
   *  registry's liveness window; `startedAt` is the first sighting. */
  lastSeenAt?: string
  /** True when this agent-cli session is running inside a sandbox (`agent_start.sandbox`)
   *  rather than as a local subprocess — there's no local PID to check, so
   *  `processAlive` never applies (it's already absent whenever `pid` is null). */
  remote?: boolean
  /** Provider-assigned sandbox id (`BootedSandbox.sandboxId`), when `remote` is true. */
  sandboxId?: string
  /**
   * True from the moment a graceful daemon shutdown DETACHED this sandbox
   * session (connection closed, box session + box left running) until the
   * next boot's reattach pass resolves it. Also stamped at load on a row that
   * was alive when the daemon crashed and carries a {@link sandboxReattach}
   * record. A row with this flag is NOT dead: boot defers its
   * `session:exited` and `daemon-restart` resume paths to the reattach pass.
   */
  hostDetached?: boolean
  /**
   * Everything needed to re-attach this session's box session after a host
   * restart. Refreshed on every snapshot while the proxy is attached, so a
   * crash (no graceful detach) still leaves a usable — if slightly stale —
   * cursor. The box itself is found via `sandboxId`/`sandboxProvider`.
   */
  sandboxReattach?: SandboxReattachRecord
  /**
   * The session id on the BOX's own daemon (the sandbox proxy's `sessionId`)
   * — stamped when the proxy is bound and kept for the row's whole life,
   * unlike {@link sandboxReattach} which only exists while the row is live.
   * `session_restart` reads it to stop the prior box session before starting
   * a new one in the same box: a row that ended on a host-side error can
   * leave its box session running, and nothing else remembers its id.
   */
  sandboxRemoteSessionId?: string
  /**
   * BOOTSTRAP P7a — for a `device:<fp|name>` sandbox spawn: the id of the
   * session the HOST's own daemon created (`BootedSandbox`'s inner
   * `agent_start` descriptor.id, i.e. the sandbox proxy's `sessionId`). The
   * conversation with the remote device lives THERE, not under this
   * descriptor's id — `device_prompt` and the read paths use this to bridge
   * the twin daemons (issue #1637: a controller "sess_305be17c" vs host
   * "sess_cf318f00"). Absent for a local/cloud spawn, or when the host
   * failed to return a usable id at spawn time. Persisted via the same
   * descriptor spread as every other field.
   */
  hostSessionId?: string
  /**
   * BOOTSTRAP P7a — for a `device:<fp|name>` sandbox spawn: the paired
   * host's identity as pinned by the spawn's own sandbox spec, resolved by
   * the device provider to the REAL fingerprint when it can (a saved
   * fallback keeps the raw `fp-or-name` target — every consumer matches
   * `HostRegistry.forwardHttp`'s `fingerprint OR name`). Only meaningful
   * alongside {@link hostSessionId}; absent for every other spawn.
   */
  hostFingerprint?: string
  /** Sandbox provider slug (`agent_start.sandbox`'s provider, e.g. `"e2b"`,
   *  `"local"`), when `remote` is true. Identifies WHERE the box lives, not
   *  just THAT one exists — the VS Code panel's sandbox chip names it in its
   *  tooltip alongside `sandboxId`. */
  sandboxProvider?: string
  /**
   * Non-secret sandbox spec config persisted for a later re-attach — the
   * effective boot config minus credentials, always carrying the stable
   * `sessionHolder`. Both `session_restart` and the boot-time reattach pass
   * replay it instead of rebuilding an empty `config: {}`. Never contains a
   * token, auth header, or other secret.
   */
  sandboxConfig?: Record<string, unknown>
  /** What session close does to the box (PR3 lifecycle) — `"kill"` (the
   *  default, ephemeral) or `"pause"` (keeps `sandboxId` reconnectable via
   *  `agent_start.sandbox.reuse`). Only set when `remote` is true. */
  sandboxTeardown?: "kill" | "pause"
  /** The spec's `lifecycle.pause_after_idle` window (ms), when it declared
   *  one. The idle reaper retires an idle sandboxed row after this long when
   *  it is shorter than `daemon.sandboxIdleReapAfterMs`, so a box that asked
   *  to park after 2 min of idleness is not left running (and billed) for the
   *  reaper's 15-minute default. Only set when `remote` is true. */
  sandboxPauseAfterIdleMs?: number
  /** What teardown did with the branch the session worked on inside its box
   *  (`wt/<slug>` push + bundle fallback). Only set for a sandbox session that
   *  was spawned from a workspace `remote` with a `worktree`, once it closes. */
  sandboxDelivery?: SandboxDeliveryRecord
  /** The latest periodic checkpoint of that branch while the session runs
   *  (`mode: "checkpoint"` — branch push, uncommitted-work snapshot pushed to
   *  `agentproto-checkpoint/<branch>`, bundle fallback). What survives a box
   *  that dies outside `close()`. */
  sandboxCheckpoint?: SandboxDeliveryRecord
  /** The LAST checkpoint of this session, as a link the session owns: the ref
   *  of the snapshot on the workspace remote, its sha, the work branch it
   *  belongs to. Written by the daemon when it creates the checkpoint
   *  (`registry.recordSandboxCheckpoint`), so a relaunch can restore THAT
   *  snapshot instead of guessing from the branch name. Absent when no
   *  checkpoint ever reached the remote. */
  lastCheckpoint?: SessionCheckpointRef
  /** Where the session's work branch lives inside its box (checkout dir, branch,
   *  base commit). Persisted so a restart that re-attaches the box can still
   *  deliver the branch at teardown. Same condition as {@link sandboxDelivery}. */
  sandboxDeliveryTarget?: SandboxDeliveryTarget
  /** The spawn's own `agent_start.sandboxCheckpoint` override, persisted so a
   *  restart or a boot-time re-attach re-resolves the same checkpoint policy
   *  (`false` stays off across a daemon restart). Absent ⇒ the global
   *  `defaults.sandbox.checkpoint` alone. */
  sandboxCheckpointOverride?: SandboxCheckpointConfig | false
  /** App ports exposed at boot time (`SandboxSpec.extraPorts`) — maps port
   *  number to its public URL. Only present for sandbox sessions where the
   *  provider resolved `extraPorts` into `BootedSandbox.ports`. */
  sandboxPorts?: Record<number, string>
  /** WP3 — an app UI served from INSIDE this sandbox session's box
   *  (`agent_start.appServe`): the box-installed appId, the in-box dir, the
   *  serve port, and the provider-resolved public URL. See
   *  `sandbox-app-serve.ts`. */
  appServe?: SessionAppServeInfo
  /** Last PROVIDER liveness verdict for this session's box (`sandboxId`'s
   *  ledger row, stamped by `recordSandboxLiveness` — the route / the CLI /
   *  a reconnect-not-found). Ephemeral read-time projection of the sandbox
   *  ledger, same convention as `processAlive`: a remote session has no
   *  local PID, so this is the only box-death signal the descriptor can
   *  carry. Absent when the box was never probed (or the provider can't) —
   *  and absent is NOT "alive". */
  sandboxAlive?: boolean
  /** ISO instant `sandboxAlive` was computed (see its doc). */
  sandboxCheckedAt?: string
}

/** The session's canonical human handle: the {@link SessionDescriptor.slug}
 *  when present, else the deprecated legacy {@link SessionDescriptor.name} it
 *  replaced. Never the display `label`/`title` — those are not addressable.
 *  Mirrors the `slug ?? name` fallback the shared resolver (`session-ref.ts`)
 *  applies, so `findByIdOrName`/`resolveSessionRef` accept a legacy row's
 *  `name` even before backfill (or for a row backfill skipped). */
export function getSlug(
  desc: Pick<SessionDescriptor, "slug" | "name">,
): string | undefined {
  return desc.slug ?? desc.name
}

/** Persisted re-attach coordinates — see `SessionDescriptor.sandboxReattach`. */
export interface SandboxReattachRecord extends SandboxDetachRecord {
  /** ISO instant of the graceful detach; absent on a crash-stamped record. */
  detachedAt?: string
}

/**
 * Lightweight panel projection of SessionDescriptor for the VS Code Sessions
 * webview (and similar read-only list consumers). Excludes large resume /
 * transcript / policy context that the panel never renders:
 *
 *   - resume metadata and restart scheduling (resumeMetadata, resumeAttempts,
 *     lastResumeAt, restartPolicy, restartAttempts, lastRestartAt,
 *     nextRestartAt, recentRestartAts, resumedFrom, resumeVia)
 *   - structured transcript / context continuity (contextContinuity,
 *     contextContinuityHardStopped, checkpointId, pendingResumeContext)
 *   - MCP server list and provider resume hints (mcpServers, adapterSessionId)
 *   - per-session config axes not shown in the row (effort, posture, route,
 *     contextProfile, accessProfile, auth)
 *   - orchestrator internals (notifyParentOnCrash, pendingChildCrashNotices,
 *     callerSessionId, meta)
 *   - crash detail / ended reason (endedReason, lastError, crashedAt,
 *     interrupted)
 *   - PR list (openedPrs)
 *
 * GET /sessions remains unchanged: it still returns the full SessionDescriptor.
 */
export interface SessionSummary {
  id: string
  kind: SessionKind
  workspaceSlug: string
  command: string
  pid: number | null
  status: SessionStatus
  /** Worktree-provisioning progress while `starting` — see
   *  `SessionDescriptor.provisioning`. */
  provisioning?: SessionProvisioning
  startedAt: string
  endedAt?: string
  exitCode?: number
  killedMidTurn?: boolean
  /** Compact derived outcome (status + 120-char summary preview) — see
   *  `SessionDescriptor.outcome`; the full record is on GET /sessions/:id. */
  outcome?: SessionOutcomeCompact
  lastOutputAt?: string
  lastActivityAt?: string
  currentPhase?: SessionCurrentPhase
  secondsSinceLastActivity?: number
  toolCallsThisTurn?: number
  processAlive?: boolean
  /** Live supervisor waiter count (#session-visibility) — see
   *  `SessionDescriptor.watchers`. Ephemeral, stamped at read time. */
  watchers?: number
  /** Busy-descendant count (#session-visibility, subtree rollup) — see
   *  `SessionDescriptor.childrenBusy`. Drives the "delegating" row state. */
  childrenBusy?: number
  /** Prompt-queue badge count — see `SessionDescriptor.queuedPrompts`. */
  queuedPrompts?: number
  label?: string
  title?: string
  renamedByUser?: boolean
  activitySummary?: SessionActivitySummary
  archived?: boolean
  /** ISO-8601 instant `archiveSession` set `archived: true`; cleared by
   *  `unarchiveSession`. Absent on rows archived before this field existed. */
  archivedAt?: string
  keepAlive?: boolean
  /** Steward wrap-up flag — a blocked/needs-input verdict that deliberately
   *  left the session running; see `SessionDescriptor.wrapupFlag`. */
  wrapupFlag?: { verdict: "blocked" | "needs-input"; note?: string; judgedBy?: string; at: string } & OutcomeDetail
  pinned?: boolean
  /** Ascending position among pinned sessions — see
   *  `SessionDescriptor.pinnedOrder`. */
  pinnedOrder?: number
  pty?: boolean
  name?: string
  /** Unique human handle — see `SessionDescriptor.slug`. Surfaced on the list
   *  projection so a client can address by slug without a full GET. */
  slug?: string
  argv?: readonly string[]
  cwd?: string
  worktreePath?: string
  worktreeId?: string
  mainRepoPath?: string
  /** Resolved AGENTS.md path — see `SessionDescriptor.agentsMd`. */
  agentsMd?: string
  /** Injection mode — see `SessionDescriptor.agentsMdMode`. */
  agentsMdMode?: AgentsMdMode
  /** Resolved workspace RULES.md path — see `SessionDescriptor.rulesMd`. */
  rulesMd?: string
  adapterSlug?: string
  mode?: string
  model?: string
  costUsd?: number
  tokensIn?: number
  tokensOut?: number
  contextSize?: number
  contextUsed?: number
  contextSizeSource?: ContextSizeSource
  usageSource?: import("./usage.js").UsageSource
  awaitingInput?: boolean
  awaitingQuestion?: SessionAwaitingQuestion
  awaitingPermission?: boolean
  turnsCompleted?: number
  busy?: boolean
  blockedOn?: "subagent" | "command" | "inbox"
  stalledSinceMs?: number
  /** Parked-with-background-tasks marker — see
   *  `SessionDescriptor.pendingBgTasks`. Stamped at turn-end, cleared on the
   *  next turn start / exit. */
  pendingBgTasks?: number
  /** Running background tasks — see `SessionDescriptor.backgroundTasks`. */
  backgroundTasks?: SessionBackgroundTask[]
  /** Adapter-reported turn-error marker — see
   *  `SessionDescriptor.lastTurnErroredAt`. Stamped at turn-end, cleared on
   *  the next turn that completes without one. */
  lastTurnErroredAt?: string
  /** `SessionDescriptor.lastError` (spawn/crash cause), capped at 2000 chars
   *  for the list projection. Lets a list view say WHY an errored row died. */
  lastError?: string
  origin?: string
  parentSessionId?: string
  depth?: number
  /**
   * Server-computed Sessions-panel lane verdict, stamped by `listSummaries`
   * against the daemon's FULL in-memory session map (archived and dead
   * parents included) — so a client paging summaries never has to re-derive
   * lineage from whatever happens to be on its current page, and a row's
   * lane cannot flip between page 1 and page N. Absent on shell-only rows
   * (`isShellOnlyRow` — plain-shell PTYs and command rows belong to the
   * Activity panel, not either lane; a conversation terminal DOES get a
   * lane) and on rows from older daemons.
   */
  lane?: "agents" | "auto"
  priorCommandSessionId?: string
  continuedFrom?: string
  /** Separate continue-fresh / revival lineage generation — see
   *  `SessionDescriptor.continuationGeneration` (absent on a base row). */
  continuationGeneration?: number
  continuedTo?: string
  /** See `SessionDescriptor.retiredAt` — with `continuedTo`/`archived`, lets a
   *  client tell a retired row from a merely dead one (and feature-detect the
   *  retire route). */
  retiredAt?: string
  permissionHold?: boolean
  browserAdapterId?: string
  browserPort?: number
  browserBaseUrl?: string
  browserLocation?: "local" | "cloud"
  remote?: boolean
  sandboxId?: string
  /** Device-sandbox identity mapping — see `SessionDescriptor.hostSessionId`. */
  hostSessionId?: string
  /** Device-sandbox identity mapping — see `SessionDescriptor.hostFingerprint`. */
  hostFingerprint?: string
  sandboxTeardown?: "kill" | "pause"
  sandboxPorts?: Record<number, string>
  appServe?: SessionAppServeInfo
  /** Effective adapter confinement — see `SessionDescriptor.commandSandbox`. */
  commandSandbox?: "off" | "workspace" | "strict"
  /** Read-time projection of the box's ledger liveness verdict — see
   *  `SessionDescriptor.sandboxAlive`. */
  sandboxAlive?: boolean
  sandboxCheckedAt?: string
}

/**
 * Rows that belong ONLY to the Activity panel — raw command executions and
 * plain-shell PTYs. A conversation terminal (`isConversationTerminal`: a
 * native provider TUI like `claude`/`hermes`/`grok` in a PTY) is NOT
 * shell-only: it is a trackable session in the Agents/Auto lanes, while
 * Activity → Terminals keeps listing every PTY regardless.
 */
export function isShellOnlyRow(
  desc: Pick<SessionDescriptor, "kind" | "adapterSlug" | "argv" | "resumeMetadata">,
): boolean {
  return desc.kind === "command" || (desc.kind === "terminal" && !isConversationTerminal(desc))
}

/** Project a full SessionDescriptor down to the panel summary shape. */
function toSessionSummary(desc: SessionDescriptor): SessionSummary {
  return {
    id: desc.id,
    kind: desc.kind,
    workspaceSlug: desc.workspaceSlug,
    command: desc.command,
    pid: desc.pid,
    status: desc.status,
    ...(desc.provisioning ? { provisioning: { ...desc.provisioning } } : {}),
    startedAt: desc.startedAt,
    endedAt: desc.endedAt,
    exitCode: desc.exitCode,
    killedMidTurn: desc.killedMidTurn,
    ...(desc.outcome ? { outcome: compactOutcome(desc.outcome) } : {}),
    lastOutputAt: desc.lastOutputAt,
    lastActivityAt: desc.lastActivityAt,
    currentPhase: desc.currentPhase,
    secondsSinceLastActivity: desc.secondsSinceLastActivity,
    toolCallsThisTurn: desc.toolCallsThisTurn,
    processAlive: desc.processAlive,
    watchers: desc.watchers,
    childrenBusy: desc.childrenBusy,
    queuedPrompts: desc.queuedPrompts,
    label: desc.label,
    title: desc.title,
    renamedByUser: desc.renamedByUser,
    activitySummary: desc.activitySummary,
    archived: desc.archived,
    keepAlive: desc.keepAlive,
    pinned: desc.pinned,
    pinnedOrder: desc.pinnedOrder,
    pty: desc.pty,
    name: desc.name,
    slug: desc.slug,
    argv: desc.argv,
    cwd: desc.cwd,
    worktreePath: desc.worktreePath,
    worktreeId: desc.worktreeId,
    mainRepoPath: desc.mainRepoPath,
    agentsMd: desc.agentsMd,
    agentsMdMode: desc.agentsMdMode,
    rulesMd: desc.rulesMd,
    adapterSlug: desc.adapterSlug,
    mode: desc.mode,
    model: desc.model,
    costUsd: desc.costUsd,
    tokensIn: desc.tokensIn,
    tokensOut: desc.tokensOut,
    contextSize: desc.contextSize,
    contextUsed: desc.contextUsed,
    contextSizeSource: desc.contextSizeSource,
    usageSource: desc.usageSource,
    awaitingInput: desc.awaitingInput,
    awaitingQuestion: desc.awaitingQuestion,
    awaitingPermission: desc.awaitingPermission,
    turnsCompleted: desc.turnsCompleted,
    busy: desc.busy,
    blockedOn: desc.blockedOn,
    stalledSinceMs: desc.stalledSinceMs,
    pendingBgTasks: desc.pendingBgTasks,
    ...(desc.wrapupFlag ? { wrapupFlag: desc.wrapupFlag } : {}),
    backgroundTasks: desc.backgroundTasks,
    lastTurnErroredAt: desc.lastTurnErroredAt,
    ...(desc.lastError ? { lastError: desc.lastError.slice(0, 2000) } : {}),
    origin: desc.origin,
    parentSessionId: desc.parentSessionId,
    depth: desc.depth,
    priorCommandSessionId: desc.priorCommandSessionId,
    continuedFrom: desc.continuedFrom,
    ...(desc.continuationGeneration !== undefined
      ? { continuationGeneration: desc.continuationGeneration }
      : {}),
    continuedTo: desc.continuedTo,
    ...(desc.retiredAt ? { retiredAt: desc.retiredAt } : {}),
    permissionHold: desc.permissionHold,
    browserAdapterId: desc.browserAdapterId,
    browserPort: desc.browserPort,
    browserBaseUrl: desc.browserBaseUrl,
    browserLocation: desc.browserLocation,
    remote: desc.remote,
    sandboxId: desc.sandboxId,
    hostSessionId: desc.hostSessionId,
    hostFingerprint: desc.hostFingerprint,
    sandboxTeardown: desc.sandboxTeardown,
    sandboxPorts: desc.sandboxPorts,
    appServe: desc.appServe,
    commandSandbox: desc.commandSandbox,
    sandboxAlive: desc.sandboxAlive,
    sandboxCheckedAt: desc.sandboxCheckedAt,
  }
}

interface SessionRuntime {
  desc: SessionDescriptor
  /** True while the latest `usage_update` carrying `used` was dropped by
   *  `plausibleContextUsed` (more tokens than the window holds). The held
   *  `desc.contextUsed` is then a stale reading, so context-continuity must
   *  not act on it with an irreversible hard-stop. */
  contextUsedInconsistent?: boolean
  /** In flight while the runtime rescues a session that reached
   *  `hardStopAtPct` (auto-compact, then continue fresh, then — last resort —
   *  stop). Prompts are held (queued / answered "retry") until it settles. */
  contextRescue?: Promise<void>
  /** The autocompact controller for this session (absolute token
   *  threshold). Created lazily on the first turn boundary that reaches it. */
  autoCompact?: AutoCompactController
  /** True while an autocompact check is scheduled but has not run yet. It
   *  keeps a burst of turn boundaries from queueing several checks. */
  autoCompactScheduled?: boolean
  /** Active tool calls in announcement order. Multiple calls can overlap;
   *  removing the latest one falls back to the previous still-active call. */
  activeToolCalls?: Map<string, string>
  /** Distinct tool-call ids seen during this turn, for enrichment de-dup. */
  toolCallIdsThisTurn?: Set<string>
  /** Per-turn tool-call count surfaced by the read-time status projection. */
  toolCallsThisTurn?: number
  /** Per-turn counter of tool-calls started with `run_in_background: true`
   *  (see `SessionDescriptor.pendingBgTasks`). Reset at each turn start by
   *  `runAgentTurn`; read at turn-end to decide whether the session parked
   *  with background work pending. NOT persisted — lives on the runtime
   *  entry, not the descriptor. */
  bgTaskStarts?: number
  /** Per-turn dedup set backing `bgTaskStarts`: toolCallIds already counted
   *  this turn. A tool-call can be announced once and then re-announced by
   *  one or more `isUpdate` enrichments under the SAME toolCallId — and the
   *  `run_in_background: true` flag can arrive on EITHER the first announce
   *  OR a later enrichment (transcript-writer merges late-arriving arguments
   *  for exactly this reason). Keying dedup on the toolCallId — not on
   *  `isUpdate` — counts BOTH flows exactly once: first-announce-with-
   *  arguments (enrichment deduped by id) and announce-then-enrich (counted
   *  when the arguments finally show the flag). Reset with the counter. */
  bgTaskCountedIds?: Set<string>
  /** Unsubscribes the registry from the live agent session's out-of-turn
   *  events — see `bindOutOfTurnEvents`. Replaced on every (re)bind. */
  outOfTurnUnsubscribe?: () => void
  /** Set while the agent works WITHOUT a prompt (an autonomous
   *  task-notification cycle) — the registry tracks that stretch as a turn:
   *  `busy` is true, events are recorded, and it closes with a turn-end. */
  /** When this session last had a message steered into it — the R3 rate
   *  limit (`STEER_MIN_INTERVAL_MS`). In-memory only. */
  lastSteerAt?: number
  /** Queue id of the prompt whose steer RPC is in flight — while set,
   *  `dispatchQueuedPrompt` holds off so a turn ending mid-RPC can't also
   *  dispatch it (double delivery). In-memory only. */
  steerInFlight?: string
  /** Serializes `flushSteerableQueue` runs per session (FIFO steering). */
  steerChain?: Promise<void>
  /** Queue id → ISO time for prompts steered into the running turn, read once
   *  by the `enqueuePrompt` call that queued them. Bounded. In-memory only. */
  steeredPromptAt?: Map<string, string>
  /** Messages this session received that have since left its inbox (acked
   *  by a wait, a turn, `inbox_ack`, or steered in), newest last, bounded
   *  by `INBOX_CAP`. `findReceivedMessage` reads this before the transcript:
   *  the `session-message` record goes through an async append stream, so a
   *  reply issued right after the ack can beat it to disk. In-memory only —
   *  after a restart the transcript is flushed and is the source. */
  recentlyReceived?: SessionMessage[]
  autonomousTurn?: {
    /** Tool calls announced and not yet resulted — synthesized at close,
     *  and the silence-close fallback holds off while any are open. */
    pendingToolCallIds: Set<string>
    silenceTimer?: ReturnType<typeof setTimeout>
  }
  /** Background tasks that settled while the session was idle, awaiting
   *  either the agent's own wake-up or the registry's wake prompt when
   *  `timer` fires — see `SessionsRegistryOptions.backgroundTaskWake`. */
  bgWake?: {
    settled: SessionBackgroundTask[]
    timer?: ReturnType<typeof setTimeout>
  }
  /** True once the agent has reported any background-task lifecycle event:
   *  its tasks are tracked for real (and woken on), so the turn-end
   *  `pendingBgTasks` heuristic — "parked, no wake-up path" — no longer
   *  applies to it. */
  reportsBackgroundTasks?: boolean
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
  /** UTF-16 code units retained in the replay ring (at most 1 MiB of string payload). */
  recentLinesChars?: number
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
  /** The latest assistant message — the run of text-delta chunks since the
   *  last tool call, tail-capped at `LAST_ASSISTANT_TEXT_CAP`. Feeds the
   *  derived outcome's `summary` without re-reading the transcript. Not
   *  persisted. */
  lastAssistantText?: string
  /** Set by a tool call: the next text-delta starts a new message. */
  lastAssistantTextSealed?: boolean
  /** The most recent user prompt for this session (the caller's own ask, with
   *  any daemon-composed system preamble stripped), captured at turn start so
   *  the index sidecar can carry it without a transcript read on the write
   *  path. In-memory only; backfill recovers it from the transcript tail for
   *  rows this daemon never ran. */
  lastUserPrompt?: TranscriptPrompt
  /** The most recent driver-reported `error` stream event's message this
   *  session lifetime, kept so a LATER death that carries no error text of
   *  its own (a bare "adapter process gone", from `markCrashed`'s pid probe)
   *  can still be classified — e.g. `isProviderLimitError` distinguishing a
   *  usage-cap death from a genuine crash. Not persisted; overwritten by
   *  each new `error` event, never cleared mid-session. */
  lastErrorMessage?: string
  /** Set by `interruptInFlightTurn` when the daemon cancels the in-flight
   *  turn; consumed (and cleared) at the top of that turn's `finally`. An
   *  interrupted turn does NOT drain `promptQueue` — queued prompts are
   *  delivered only after a turn that ends on its own — except the one item
   *  `deliverQueuedPrompt` interrupted for (`deliverQueueId`). */
  interruptRequested?: { by: string; deliverQueueId?: string }
  /** Model-facing line explaining that the previous turn was cut to deliver
   *  a prompt NOW (deliver-now / `interrupt: true`), set by
   *  `interruptInFlightTurn` and prepended — once — to the next turn's
   *  string prompt by `runAgentTurn`. Without it the model only sees its
   *  turn cancelled then a new prompt, which reads exactly like a human
   *  Esc/stop, and an agent may park itself waiting for a go-ahead.
   *  Never set for a bare stop (`interruptSession`), which clears it. */
  pendingInterruptNotice?: string
  /** One-line reminder armed by an autocompact: the path of the full
   *  transcript plus the two lookup tools (`transcript_search` /
   *  `transcript_read`). It is prepended, ONCE, to the next prompt the
   *  session receives (`runAgentTurn`), never delivered as a turn of its
   *  own: waking an idle session just to tell it where the transcript is
   *  would cost a turn and a model call for nothing. Cleared when it is
   *  consumed (and by the resume prompt, which cites the path itself). */
  pendingAutoCompactNote?: string
  /** In-flight resume promise. Deduplicates concurrent prompt
   *  attempts on a dead agent session — only one resume call hits
   *  the adapter, the rest await this promise. Cleared once
   *  resolved (success or failure). */
  resumePromise?: Promise<void>
  /** In-flight fresh-box move of an idle-reaped box session
   *  ({@link SessionsRegistryOptions.moveReapedBox}) — concurrent prompts
   *  share one move and the one successor id. Cleared once settled. */
  reapedBoxMove?: Promise<string>
  /** The in-flight box teardown an idle reap started (final checkpoint, branch
   *  delivery, box stop). A prompt that wakes the row waits for it, so the
   *  fresh box cold-boots from the FINAL checkpoint, not one that predates it. */
  reapTeardown?: Promise<void>
  /** Async stop callback for browser sessions (kind="browser").
   *  Called by kill() best-effort — the descriptor is already flipped
   *  to "killed" before this fires. */
  browserStop?: () => Promise<void>
  /** Reasons a `session:handoff-suggested` was already emitted for this
   *  session — each reason fires at most once (a quota-threshold suggestion
   *  is additionally keyed per window, see `quotaSuggestedResetsAt`). */
  handoffSuggested?: Set<string>
  /** `resetsAt` of the quota window a threshold suggestion was last made
   *  for — a window is only suggested once. */
  quotaSuggestedResetsAt?: string
  /** Epoch ms of the last quota read, to throttle the poll. */
  quotaCheckedAt?: number
  /** Guard: true once session:exited has been emitted to sessionEvents.
   *  Prevents duplicate emissions when both kill() and an OS exit event fire. */
  exitedEmitted?: boolean
  /** Cancels this row's in-flight worktree provisioning (queued entry dropped,
   *  running child tree killed). Set by `spawnAgentPending`'s `onCancel`;
   *  fired once from `emitExited`, the funnel every terminal path shares. */
  provisionCancel?: () => void
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
  readUsage?: () => Promise<import("./usage.js").UsageReadResult | null>
  /** Live-usage poll handle while the session runs — see `armUsageRefresh`.
   *  An unref'd interval that self-clears once the descriptor's status stops
   *  being "running". */
  usageRefreshTimer?: ReturnType<typeof setInterval>
  /** In-flight guard so overlapping async reader calls can't interleave. */
  usageRefreshInFlight?: boolean
  /** Serialized content hash of the last `readUsage` snapshot the poller
   *  mirrored — so idle-without-change polls write nothing. */
  lastUsageReadKey?: string
  /** True once `readUsage` returned real token counts. From then on a
   *  cost-less usage_update frame's `used` (tokens-in-context, a much
   *  weaker proxy) no longer drives the running cost estimate, so the two
   *  estimates can't flap against each other. */
  readerReportedTokens?: boolean
  /** `Date.now()` when the current turn started; folded into
   *  `desc.durationMs` and cleared when the turn ends. */
  turnStartedAtMs?: number
  /** True once THIS turn has produced any output or usage — an assistant
   *  text delta, a tool call/result, a thought, a plan, or a `usage_update`.
   *  Reset at every turn start. Read by `markStalled`: a turn that goes
   *  silent with NO output/usage at all is a provider stuck retrying (and
   *  gets a readable turn error), whereas a turn that streamed something
   *  and THEN stalled keeps the pre-existing stalled-only behavior. */
  turnHadOutput?: boolean
  /** True once an authoritative cost has been observed from the adapter —
   *  either its `readUsage` returned a `costUsd`, or a `usage_update` carried
   *  a `cost` block. Drives the `"adapter"` vs `"computed"` source decision at
   *  turn-end. */
  adapterReportedCost?: boolean
  /** True when the session was spawned in permission-hold mode — its
   *  `agent-prompt` events carry respondable permission requests that get
   *  registered in the pending-permissions inbox. Default false. */
  permissionHold?: boolean
  /** Bracketed-paste mode tracker for PTY sessions — see
   *  `scanBracketedPaste`'s doc. Updated on every `pty.onData` chunk;
   *  read by `writeTerminalInput`'s caller (the `terminal_input` tool)
   *  to decide whether multi-line input needs the `\x1b[200~`…`\x1b[201~`
   *  wrapper. Undefined until the first chunk arrives — treated the
   *  same as `{ mode: "unknown", carry: "" }`. */
  bracketedPaste?: BracketedPasteScanState
  /** True for a PTY classified as a conversation terminal at spawn
   *  (`isConversationTerminal`) — gates the per-chunk resume-hint line
   *  sniffing so plain shells never pay for it. Computed once. */
  conversationTerminal?: boolean
  /** Carry for a partial output line across PTY `onData` chunks, so the
   *  conversation-terminal resume-hint sniffer only ever matches COMPLETE
   *  lines. Capped — a TUI redraw with no newlines must not grow it. */
  sniffCarry?: string
  /** Stops this conversation terminal's link-probe timers. Called from
   *  `emitExited` (the shared exit funnel) and by the probe itself once a
   *  link lands. */
  linkProbeStop?: () => void
}

/** Bracketed-paste mode as last observed in a PTY's OUTPUT stream.
 *  `"unknown"` means neither `\x1b[?2004h` nor `\x1b[?2004l` has been seen
 *  yet for this session — callers must treat unknown the same as "off"
 *  (i.e. never wrap) to avoid a regression for sessions/shells that don't
 *  use bracketed paste at all. */
export type BracketedPasteMode = "on" | "off" | "unknown"

/** Scanner state threaded across `pty.onData` chunks. `carry` holds a
 *  trailing partial escape sequence (starting at the last unmatched
 *  `\x1b` in the chunk) that MIGHT be completed by the next chunk — PTY
 *  output is not guaranteed to deliver a full `\x1b[?2004h`/`\x1b[?2004l`
 *  sequence in one `onData` callback. */
export interface BracketedPasteScanState {
  mode: BracketedPasteMode
  carry: string
}

const BRACKETED_PASTE_ON = "\x1b[?2004h"
const BRACKETED_PASTE_OFF = "\x1b[?2004l"

/** True iff `candidate` is a non-empty, strict prefix of `full` — used to
 *  decide whether a chunk's unmatched tail could be the START of one of
 *  the two bracketed-paste sequences split across an `onData` boundary. */
function isStrictPrefixOf(candidate: string, full: string): boolean {
  return candidate.length > 0 && candidate.length < full.length && full.startsWith(candidate)
}

/** Update bracketed-paste scan state with one more chunk of PTY OUTPUT
 *  bytes (decoded latin1 so escape bytes round-trip 1-to-1). Scans left to
 *  right for `\x1b[?2004h` (paste mode ON) / `\x1b[?2004l` (paste mode
 *  OFF) — the LAST one seen wins, matching how a real terminal's mode
 *  flag works. Any trailing bytes that could still be the start of one of
 *  those two sequences (i.e. begin at the last unmatched `\x1b` and are a
 *  strict prefix of either) are carried forward into the next call rather
 *  than discarded, so a sequence split across two chunks is still
 *  detected. Pure function — no session/registry access — so it's
 *  directly unit-testable. */
export function scanBracketedPaste(
  state: BracketedPasteScanState,
  chunk: Buffer
): BracketedPasteScanState {
  const text = state.carry + chunk.toString("latin1")
  let mode = state.mode
  let matchEnd = 0
  let i = 0
  while (i < text.length) {
    if (text.startsWith(BRACKETED_PASTE_ON, i)) {
      mode = "on"
      i += BRACKETED_PASTE_ON.length
      matchEnd = i
      continue
    }
    if (text.startsWith(BRACKETED_PASTE_OFF, i)) {
      mode = "off"
      i += BRACKETED_PASTE_OFF.length
      matchEnd = i
      continue
    }
    i++
  }
  const tail = text.slice(matchEnd)
  const escIdx = tail.lastIndexOf("\x1b")
  let carry = ""
  if (escIdx !== -1) {
    const candidate = tail.slice(escIdx)
    if (
      isStrictPrefixOf(candidate, BRACKETED_PASTE_ON) ||
      isStrictPrefixOf(candidate, BRACKETED_PASTE_OFF)
    ) {
      carry = candidate
    }
  }
  return { mode, carry }
}

/** Decide whether `terminal_input`'s `text` needs the bracketed-paste
 *  wrapper (`\x1b[200~`…`\x1b[201~`) before the isolated Enter CR. Only
 *  wraps when BOTH the text is multi-line (a lone `\n` in single-line text
 *  is not what bracketed paste guards against) AND the session's last
 *  observed mode is `"on"` — `"unknown"` (never seen either sequence) and
 *  `"off"` both take the no-wrap path, so a shell/TUI that never emits
 *  `2004h` at all sees byte-for-byte the same behavior as before this
 *  fix. */
export function shouldWrapBracketedPaste(mode: BracketedPasteMode, text: string): boolean {
  return mode === "on" && text.includes("\n")
}

/** Wrap `text` in the bracketed-paste markers. Callers should gate this
 *  with `shouldWrapBracketedPaste` first. */
export function wrapBracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`
}

/** One-stop call for every terminal-input entry point (MCP `terminal_input`,
 *  `POST /sessions/:id/terminal/input`, and the PTY WebSocket `{kind:
 *  "input"}` frame) — reads the session's tracked bracketed-paste mode off
 *  `registry` and returns `text` wrapped in `\x1b[200~`…`\x1b[201~` when
 *  (and only when) that's warranted (`shouldWrapBracketedPaste`'s rule).
 *  Centralizing this here means the three call sites can never drift out
 *  of sync on the wrap decision. */
export function applyBracketedPasteWrap(
  registry: { getBracketedPasteMode(id: string): BracketedPasteMode },
  sessionId: string,
  text: string
): string {
  const mode = registry.getBracketedPasteMode(sessionId)
  return shouldWrapBracketedPaste(mode, text) ? wrapBracketedPaste(text) : text
}

const RECENT_LINES_CAP = 500
const RECENT_LINES_CHARS_CAP = 512 * 1024
const RECENT_LINE_CHARS_CAP = 32 * 1024
const RECENT_BYTES_CAP = 64 * 1024
/** Tail cap on `SessionRuntime.lastAssistantText` — generous next to the
 *  outcome summary's own 600-char cap, small enough to never matter. */
const LAST_ASSISTANT_TEXT_CAP = 4 * 1024
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

/** How long the daemon's stop waits for boxes to confirm a lifetime extension. */
const DETACH_LIFETIME_TIMEOUT_MS = 5_000

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

/** Human-readable names for `interruptInFlightTurn`'s `caller`, used in the
 *  transcript notice so a `cancelled` turn-end can be traced to the surface
 *  that asked for it. */
const INTERRUPT_CALLER_LABELS: Record<string, string> = {
  interruptSession: "a stop request (agent_interrupt / POST /sessions/:id/interrupt)",
  enqueuePrompt: "a prompt sent with interrupt: true",
  sendPrompt: "a prompt sent with interrupt: true",
  deliverQueuedPrompt: "a queue deliver-now (session_queue_deliver)",
}

/** The line `runAgentTurn` prepends to a prompt delivered by interrupting
 *  the previous turn — tells the MODEL the cancellation was mechanical, not
 *  a stop. `origin` is a `promptOriginLabel` ("user", "agent <id>", ...). */
export function interruptDeliveryNotice(origin: string): string {
  return (
    `[agentproto] Your previous turn was interrupted to deliver this message immediately (from ${origin}). ` +
    "This is NOT a stop request: resume your work after handling it."
  )
}

/** Stamp the derived `desc.alive` liveness signal (§SessionDescriptor.alive):
 *  true iff the row's status counts as alive — the same "running" or
 *  "starting" test `validateAgentTurn` (and every internal isAlive check)
 *  uses. Mutates `desc` in place; called at read time, never persisted. */
function stampAlive(desc: SessionDescriptor): void {
  desc.alive = desc.status === "running" || desc.status === "starting"
}

/** Read-time liveness projection for BOTH planes: the local OS process
 *  (`stampProcessAlive`, which also stamps the status-derived `alive`
 *  above) and, for remote sandbox sessions, the box's provider-liveness
 *  ledger verdict (`stampSandboxLiveness`). */
function stampReadLiveness(desc: SessionDescriptor): void {
  stampProcessAlive(desc)
  stampSandboxLiveness(desc)
}

/** Compute `desc.processAlive` from `desc.pid` via the standard POSIX
 *  "signal 0" check — `process.kill(pid, 0)` throws `ESRCH` (or
 *  `EPERM`, treated as "exists but not ours") when the process is
 *  dead, and is a no-op (no actual signal delivered) when it succeeds.
 *  Mutates `desc` in place; called at read time (list()/get()) rather
 *  than persisted, since it's a live OS query that goes stale the
 *  instant it's written to disk. Also stamps the status-derived
 *  `alive` signal, so every read path that refreshes processAlive
 *  refreshes liveness too. */
function stampProcessAlive(desc: SessionDescriptor): void {
  stampAlive(desc)
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

/** Project the sandbox ledger's provider-liveness verdict
 *  (`sandboxAlive`/`sandboxCheckedAt`, stamped by the `GET /sandboxes/:id/
 *  alive` route, `sandbox list`'s probe, or a reconnect that hit the
 *  provider's not-found) onto a REMOTE session's descriptor at read time —
 *  same convention as `stampProcessAlive`: ephemeral, never persisted, and
 *  the descriptor's only box-death signal since a remote session has no
 *  local PID. No-op (fields deleted) for local sessions or boxes never
 *  probed — absent must never be read as "alive". */
function stampSandboxLiveness(desc: SessionDescriptor): void {
  if (!desc.sandboxId) {
    delete desc.sandboxAlive
    delete desc.sandboxCheckedAt
    return
  }
  const row = readSandboxLedger().find(e => e.sandboxId === desc.sandboxId)
  if (!row || row.sandboxAlive === undefined) {
    delete desc.sandboxAlive
    delete desc.sandboxCheckedAt
    return
  }
  desc.sandboxAlive = row.sandboxAlive
  desc.sandboxCheckedAt = row.sandboxCheckedAt
}

/** SIGTERM/SIGKILL a session's OS child, but ONLY if it actually
 *  spawned. A ChildProcess whose spawn FAILED (bad cwd, missing binary
 *  — `pid` is `undefined` and the async "error" event may not have
 *  fired yet) still holds a live libuv handle whose internal pid is 0,
 *  and `.kill()` on it becomes `kill(0, sig)`: a signal to the CALLER'S
 *  OWN PROCESS GROUP — the daemon and every process it spawned.
 *  (Discovered 2026-08-14: the shutdown kill-loop hitting such a child
 *  SIGTERM'd an entire vitest worker tree.) */
function killChildIfSpawned(
  child: ChildProcess | undefined,
  signal: NodeJS.Signals,
): void {
  if (!child) return
  if (typeof child.pid !== "number" || child.pid <= 0) return
  try {
    child.kill(signal)
  } catch {
    // already gone
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
 * Read-time projection of the LIVE agent session's advertised ACP mode registry
 * onto the descriptor (`availableModes`). Same convention as
 * the other read-time stampers (`processAlive`, `watchers`): ephemeral, never
 * persisted — `availableModes` is a connect-time snapshot held on the runtime
 * handle, not a descriptor field. Deleted (not left stale) when the handle is
 * gone or advertises no registry, so a client never reads a mode list off a
 * dead/print-arm session (SPEC §3.4a, #482 read-surface). This is the daemon
 * half of the VS Code posture picker's native-vs-advisory resolution: without
 * it the client can only offer prompt-injected advisory postures.
 */
/**
 * Read-time projection of the LIVE agent session's TRANSPORT liveness onto
 * the descriptor (`adapterConnected`) — the `isConnected()` sibling of
 * `stampProcessAlive`, and the only way a caller that holds a descriptor can
 * see the failure mode a pid probe misses: wrapper alive, ACP stream dead.
 *
 * Same convention as `stampProcessAlive`/`stampLiveModes`: ephemeral, never
 * persisted, and the field is DELETED rather than set false when there's no
 * live binding to ask — a dead row must not read as "disconnected" (that
 * would make the crash-detect sweep try to re-kill every terminal session),
 * and an adapter that models no long-lived connection must not either.
 */
function stampAdapterConnected(desc: SessionDescriptor, rt: SessionRuntime): void {
  const probe = rt.agentSession?.isConnected
  if (!probe) {
    delete desc.adapterConnected
    return
  }
  try {
    desc.adapterConnected = probe.call(rt.agentSession)
  } catch {
    // A driver whose liveness probe itself throws tells us nothing we can
    // act on — treat it as unprobed rather than as proof of death.
    delete desc.adapterConnected
  }
}

function stampLiveModes(desc: SessionDescriptor, rt: SessionRuntime): void {
  const modes = rt.agentSession?.availableModes
  if (modes && modes.length > 0) {
    desc.availableModes = [...modes]
  } else {
    delete desc.availableModes
  }
  const spawnEnforced = rt.agentSession?.spawnEnforcedPostures
  if (spawnEnforced && spawnEnforced.length > 0) {
    desc.spawnEnforcedPostures = [...spawnEnforced]
  } else {
    delete desc.spawnEnforcedPostures
  }
}

/**
 * Read-time projection of the LIVE agent session's advertised ACP CONFIG
 * options onto the descriptor (`configOptions`) -- the sibling of
 * `stampLiveModes`, same convention: ephemeral, never persisted, DELETED
 * (rather than left stale) when the live handle is gone or advertises no
 * registry.
 *
 * This is what carries the agent's OWN model vocabulary to a client picker:
 * the `model` entry lists the values the running agent accepts for its model
 * config option, so a picker can offer a live switch that the agent will
 * actually apply instead of sending a catalog id the agent rejects outright.
 */
function stampLiveConfigOptions(desc: SessionDescriptor, rt: SessionRuntime): void {
  const options = rt.agentSession?.availableConfigOptions
  if (options && options.length > 0) {
    desc.configOptions = options.map(o => ({ ...o }))
  } else {
    delete desc.configOptions
  }
}

/**
 * True when `modelId` is one of the values the LIVE harness advertises for its
 * `model` config option (the ACP `configOptions` read-surface).
 *
 * Such a value is the agent's OWN vocabulary -- the exact string it accepts
 * for its model config option, and rejects everything else ("Invalid value
 * for config option model"). It must therefore reach the agent VERBATIM: the
 * catalog wire normalization (vendor-prefix stripping, `@route` suffix
 * handling) rewrites CATALOG ids into the adapter's wire form, and applying
 * it to an already-advertised value could produce a string the agent does not
 * accept -- the live switch would fail with exactly the error the advertised
 * vocabulary exists to prevent.
 */
function isAdvertisedLiveModel(rt: SessionRuntime, modelId: string): boolean {
  const options = rt.agentSession?.availableConfigOptions
  if (!options || options.length === 0) return false
  const option =
    options.find(o => o.id?.toLowerCase() === "model") ??
    options.find(o => o.category?.toLowerCase() === "model")
  if (!option || option.type !== "select") return false
  for (const entry of option.options) {
    if ("value" in entry) {
      if (entry.value === modelId) return true
      continue
    }
    // A GROUPED option list -- the value sits one level down.
    for (const nested of entry.options) {
      if (nested.value === modelId) return true
    }
  }
  return false
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
/** A session running in a provider box this daemon owns (`agent_start.sandbox`):
 *  remote with a `sandboxId`. A `device:` spawn runs on a paired host's own
 *  daemon — no metered box of ours to tear down — so it is excluded. */
export function isProviderBoxSession(desc: SessionDescriptor): boolean {
  return (
    desc.remote === true &&
    typeof desc.sandboxId === "string" &&
    desc.sandboxId.length > 0 &&
    desc.sandboxProvider?.startsWith("device:") !== true
  )
}

export function isResumable(desc: SessionDescriptor): boolean {
  return (
    desc.kind === "agent-cli" &&
    !!desc.adapterSlug &&
    !!desc.adapterSessionId &&
    !!desc.cwd &&
    !desc.archived &&
    // Held for the boot reattach pass — reviving it in place now would race
    // the live box session it is about to re-attach to.
    desc.hostDetached !== true
  )
}

/**
 * Which death `markCrashed` is recording. Both leave the row equally dead
 * and equally lazy-resumable — this only picks the `lastError`/banner
 * wording, so whoever reads the row afterwards knows which liveness axis
 * actually failed.
 *
 *   - `"process-gone"`     — the pid probe came back dead (`processAlive:
 *     false`). The original, and still the common, crash shape.
 *   - `"transport-closed"` — the adapter's JSON-RPC stream is closed while
 *     its process is (or may be) alive: `AgentSessionLike.isConnected()`
 *     returned false. Invisible to the pid probe, which is exactly why this
 *     ground exists.
 */
export type SessionCrashReason = "process-gone" | "transport-closed"

/** The `lastError` / `[crashed]` banner text for each {@link
 *  SessionCrashReason}. One function so the descriptor field, the ring
 *  buffer line and the durable transcript notice can never word the same
 *  crash three different ways. */
function crashReasonText(reason: SessionCrashReason, pid: number | null | undefined): string {
  return reason === "transport-closed"
    ? `adapter connection closed (pid ${pid ?? "?"} may still be running) — session crashed`
    : `adapter process gone (pid ${pid}) — session crashed`
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
 * `interruptedAtBoot` value a graceful shutdown parks on a row it cuts off
 * mid-turn — "interrupted by the restart in progress; the next boot claims
 * it". The boot id that will follow isn't known yet, and leaving the field
 * empty would be indistinguishable from a row persisted before the marker
 * existed (an older restart). Never survives a boot reload.
 */
export const INTERRUPTED_PENDING_BOOT = "pending-next-boot"

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

/**
 * Opt-in auto-restart policy (restart-scheduler, PR-2 of the crash-detect
 * chantier). Absent (the default) ⇒ a dead session just sits there,
 * lazy-resumable on the next prompt, exactly like today. When set, the
 * restart-scheduler proactively drives `maybeResumeAgent` on an eligible
 * death instead of waiting for a prompt — see `restart-scheduler.ts`.
 */
export interface RestartPolicy {
  /** Which automatic death reasons trigger a restart: `"crashed"` (the
   *  crash-detect sweep found the adapter process gone), `"error"` (an
   *  unexpected turn error with no other intentional `endedReason`), and/or
   *  `"sandbox-gone"` (a box session whose BOX is gone — lifetime cap,
   *  provider reclaim, unrecoverable unreachability; revived by moving to a
   *  fresh box via the `session_restart` path instead of in-place revival,
   *  see `restart-scheduler.ts` + `sandbox-gone.ts`). Never restarts a clean
   *  exit, an operator `kill()`, `"idle-reaped"`, or a `"daemon-restart"`
   *  regardless of this list — see `isEligibleForRestart` in
   *  `restart-scheduler.ts`. */
  on: ("crashed" | "error" | "sandbox-gone")[]
  /** Rolling-window crash-loop cap: once this many restarts have fired
   *  within `windowMs`, the scheduler gives up (stamps a terminal
   *  `[crash-loop]` line and leaves the row dead) instead of scheduling
   *  another. Reset by a sustained healthy turn-end. */
  maxRetries: number
  /** The rolling window (ms) `maxRetries` counts restarts over. */
  windowMs: number
  /** First restart's backoff delay (ms), before `factor` compounds it. */
  baseDelayMs: number
  /** Exponential backoff multiplier applied per consecutive restart
   *  (`baseDelayMs * factor ** attempt`, attempt 0-indexed). */
  factor: number
  /** Backoff ceiling (ms) — the computed delay never grows past this. */
  maxDelayMs: number
  /** Reserved for a future explicit resume-vs-fresh-spawn toggle. This PR
   *  always revives in place via `maybeResumeAgent`; the field is accepted
   *  and persisted but not yet read. */
  resume?: boolean
}

/**
 * The policy `daemon.sandboxGoneRestartDefault` stamps on a BOX session that
 * was spawned with no explicit `restartPolicy` (`createSessionsRegistry`'s
 * `boxRestartPolicyDefault`). Deliberately narrow: ONLY `"sandbox-gone"` —
 * a box moving to a fresh box when its box is gone — so opting in never also
 * opts a session into classic `crashed`/`error` in-place revival. The caps
 * mirror a conservative crash-loop budget: three moves inside ten minutes,
 * then the scheduler gives up with its usual `[crash-loop]` notice.
 */
export const SANDBOX_GONE_DEFAULT_RESTART_POLICY: RestartPolicy = {
  on: ["sandbox-gone"],
  maxRetries: 3,
  windowMs: 600_000,
  baseDelayMs: 5_000,
  factor: 2,
  maxDelayMs: 60_000,
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
  /** Retired (`isRetired`): archived, deliberately ended, superseded or
   *  `retiredAt`-stamped — never revived by an automatic pass. */
  | "retired"

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

/** Why a row was retired — lets cleanup tell "gone for good" (archived /
 *  forgotten: drop its follows/sentinels) from "closed but keep the wiring so
 *  the supervisor can migrate it" (killed). */
export type SessionRetiredCause = "killed" | "archived" | "forgotten" | "continued"

export interface SessionRetiredEvent {
  sessionId: string
  cause: SessionRetiredCause
  /** Direct successor, when there is one. */
  continuedTo?: string
}

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
 * guard (SPEC risk R2 / §4.4). Delegates to the canonical resolver so the
 * runtime and the vscode picker never disagree on precedence.
 */
function currentRouteOf(desc: SessionDescriptor): string | undefined {
  return resolveEffectiveRoute(desc.model, desc.route?.gateway)
}

/** Spread-ready worktree identity for a spawn path's `cwd` — see
 *  `SessionDescriptor.worktreePath`. Returns `{}` (not `{worktreePath:
 *  undefined}`) for the common case of a cwd outside any worktree, so the
 *  descriptor keeps the keys absent rather than persisting nulls into
 *  sessions.json. */
function worktreeFields(
  cwd: string,
): Pick<SessionDescriptor, "worktreePath" | "worktreeId" | "mainRepoPath"> {
  const identity = resolveWorktreeIdentity(cwd)
  if (!identity) return {}
  return {
    worktreePath: identity.worktreePath,
    ...(identity.worktreeId === undefined ? {} : { worktreeId: identity.worktreeId }),
    ...(identity.mainRepoPath === undefined ? {} : { mainRepoPath: identity.mainRepoPath }),
  }
}

/** Strip CSI / SGR ANSI sequences so resume-pattern matching works
 *  on dim/coloured output. Liberal regex covering most cases — we
 *  don't need byte-perfect parsing here. */
function stripAnsiCodes(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
}

/** Best-effort plain-text tail of a PTY's raw output — used to give an
 *  abnormal PTY exit (see `spawnPty`'s `pty.onExit`) a readable `lastError`
 *  instead of a silent "exited". Broader than `stripAnsiCodes` (CSI only):
 *  raw PTY output also carries OSC window-title sequences and single-char
 *  cursor-save/charset-select escapes a real terminal would consume
 *  invisibly, which `deriveHeuristicQuestion`'s narrower pass doesn't need
 *  to handle since it only ever sees `appendLine`d agent-cli text. */
function terminalOutputTail(rt: SessionRuntime, maxChars = 500): string {
  if (rt.recentBytes.length === 0) return ""
  const text = Buffer.concat(rt.recentBytes, rt.recentBytesSize).toString("utf8")
  const plain = stripAnsiCodes(text)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC ... BEL/ST
    .replace(/\x1b[()][A-Za-z0-9]/g, "") // charset designators
    .replace(/\x1b[0-9A-Za-z=>]/g, "") // single-char ESC sequences (7,8,>,=,c...)
    .replace(/[\x00-\x09\x0b-\x1f]/g, "") // remaining control chars except \n
    .trim()
  if (!plain) return ""
  return plain.length > maxChars ? plain.slice(-maxChars) : plain
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
  /**
   * The tool call's `_meta` (e.g. mastra-agent's `mastra-agent/suspendPayload`
   * carrying a submit_plan's plan text), carried through from the ACP
   * `agent-prompt` event's `_meta` field when the driver supplied one.
   * Harness-shaped and untyped — don't assume a stable schema across adapters.
   */
  _meta?: unknown
}

/** How a caller resolves a pending permission — an explicit `optionId` wins
 *  over the `decision`→option mapping (approve → an allow-flavored option,
 *  deny → a reject-flavored option). `scope: "always"` prefers an
 *  allow-always option when the request offers one. `feedback` is optional
 *  free text (e.g. "reject, but do X instead") sent alongside the outcome —
 *  the acp client forwards it on the ACP outcome's `_meta`
 *  (`agentproto/feedback`) for adapters that consume it (mastra-agent folds
 *  it into a suspension's resumeData). */
export interface PermissionRespondInput {
  decision: "approve" | "deny"
  optionId?: string
  scope?: "once" | "always"
  feedback?: string
}

export type PermissionRespondResult =
  | { ok: true; permission: PendingPermission; decision: "approve" | "deny"; optionId?: string }
  | {
      ok: false
      error: "not_found" | "session_gone" | "no_matching_option" | "unsupported"
      message: string
    }

/** Result of `SessionsRegistry.refreshAgentRole` — see that method's doc. */
export type AgentRoleRefreshOutcome =
  | {
      ok: true
      roleChanged: boolean
      toolsChanged: boolean
      roleHash: string
      toolsHash: string
      /** How the role-update notice was delivered — present only when
       *  `roleChanged` and not `dryRun`. */
      delivered?: { via: MessageDeliveryVia }
      warnings: string[]
    }
  | {
      ok: false
      code: "no_session" | "not_manifest_spawned" | "session_not_alive" | AgentManifestRefError["code"]
      message: string
    }

/** Input to `SessionsRegistry.closeWithOutcome`. `verdict: "done" |
 *  "abandoned"` records the Level 2 fields onto the session's
 *  `SessionOutcome` and actually closes it; `"blocked" | "needs-input"`
 *  records the SAME `note`/`judgedBy` onto `SessionDescriptor.wrapupFlag`
 *  instead and never touches the session's liveness. See {@link
 *  SessionOutcome} / {@link SessionDescriptor.wrapupFlag} for the field
 *  meanings. */
export interface CloseWithOutcomeInput extends OutcomeDetail {
  verdict: "done" | "abandoned" | "partial" | "failed" | "blocked" | "needs-input"
  /** Overrides the outcome's derived summary when given (e.g. a judge's own
   *  written summary) — trimmed the same way `deriveSessionOutcome` trims
   *  `lastAssistantText`. Omitted keeps whatever `deriveSessionOutcome`
   *  computed from the session's own last assistant message. Ignored for a
   *  `"blocked"`/`"needs-input"` verdict (there's no outcome to summarize —
   *  nothing closed). */
  summary?: string
  note?: string
  /** A judge session id, or `"steward-rules"` for a deterministic close with
   *  no judge in the loop. */
  judgedBy?: string
  source: "judged" | "declared"
}

/** The declared outcome a manual stop (or `steward act` on an ended row)
 *  stamps onto a session: the verdict plus the structured detail. */
export type StopOutcomeInput = StopOutcome

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
  /** Register a STARTING placeholder for an agent-cli spawn whose worktree
   *  provisioning (or other pre-flight work) hasn't finished yet — the
   *  async-worktree-provisioning half of WP-F. Every field `spawnAgent`
   *  would otherwise consume up front is known already (model/label/
   *  parentage/etc. never depend on the tree existing); only the
   *  agentSession-derived fields (pid, adapterSessionId, commandPreview,
   *  resumable) are missing, because the driver hasn't started yet. `cwd`
   *  is the caller's BEST KNOWN cwd at this point — the pre-worktree repo
   *  path when the final worktree path isn't minted yet — and gets
   *  overwritten by `settlePendingAgent`'s real `cwd` once known. Returns a
   *  stable id + `status: "starting"` immediately; no initial prompt is
   *  dispatched here (see `settlePendingAgent`'s `initialPrompt` — a
   *  prompt must never be sent into a tree that isn't built yet). */
  spawnAgentPending(input: SpawnAgentPendingInput): SessionDescriptor
  /** Resolve a placeholder created by `spawnAgentPending`, once the deferred
   *  work (worktree provisioning + the driver's `startSession`) finishes.
   *
   *  `ok: true` binds the now-live `agentSession`, refreshes `cwd`/
   *  `worktreePath`/`worktreeId` from the FINAL cwd, flips `status` to
   *  `"running"`, and — only now, with the tree and the driver session both
   *  real — fires the deferred `initialPrompt` (fire-and-forget, same as
   *  `spawnAgent`'s own initial-prompt dispatch).
   *
   *  `ok: false` flips `status` to `"error"` and stamps `lastError` with the
   *  (readable) failure reason, so a spawn that can never run ends VISIBLY
   *  instead of sitting in `"starting"` forever — mirrors `markCrashed`'s
   *  terminal-failure shape. Emits `session:exited` either way nothing sits
   *  silently; a webhook/policy gate watching this id learns the outcome
   *  without polling.
   *
   *  Race guard: a no-op (and, on `ok: true`, a best-effort teardown of the
   *  just-started `agentSession` — never leak a live, unsupervised process)
   *  when the placeholder is no longer `"starting"` — e.g. an operator
   *  killed it mid-provision. A terminal descriptor is never resurrected.
   *  Also a no-op for an unknown id (the row was removed entirely). */
  settlePendingAgent(id: string, outcome: PendingAgentOutcome): void
  /** Record a provisioning progress report for `id`: updates the row's
   *  {@link SessionProvisioning} (`queued` / `started` / `phase`; `done`
   *  clears it) and emits `session:provisioning` on the bus. Also emits for an
   *  id with no registry row (a synchronous provision, whose session doesn't
   *  exist until it finishes) — only the descriptor update is skipped. Never
   *  touches a row that already left `starting`. */
  reportProvisioning(id: string, progress: WorktreeProvisionProgress): void
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
  /** Record a sighting of a session the daemon did not spawn (a Claude
   *  Desktop / `claude` CLI session calling `/mcp` with `?callerSessionId=`).
   *  - unknown `id` + a `host` → registers an `external` row (no process; it
   *    only owns an inbox) and returns it;
   *  - an existing `external` row → refreshes `lastSeenAt` (reviving it when
   *    it expired, unless it was deliberately ended) and returns it;
   *  - any other existing row, or an unknown `id` without `host` → no-op,
   *    `undefined` (today's behaviour is unchanged). */
  touchExternal(input: { id: string; host?: string }): SessionDescriptor | undefined
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
    opts?: { interrupt?: boolean; source?: string; system?: string; forceResume?: boolean }
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
  /** `opts.source` on either prompt verb is the turn's provenance
   *  (`agent:<sessionId>` when another session injected it — see
   *  `SessionObserver.recordPrompt`); recording-only, never behavioral.
   *
   *  `opts.queue` is the FIFO arm (additive, opt-in — omitted/false
   *  reproduces the byte-for-byte busy rejection above, unchanged):
   *  when the session is mid-turn AND `queue` is true, the prompt is
   *  appended to `SessionDescriptor.promptQueue` instead of being
   *  rejected, and this resolves immediately WITHOUT dispatching
   *  anything — `dispatchQueuedPrompt` fires it once the current (and
   *  any earlier-queued) turns finish. `opts.force` only matters
   *  alongside `queue`: it inserts at the FRONT of the queue instead of
   *  the back, jumping everything already waiting, but — unlike
   *  `interrupt` — never touches the live turn. `opts.queueId` lets the
   *  caller pin the queued item's id up front (the HTTP layer does this
   *  so it can echo the id straight back in its response); omitted, one
   *  is minted here. On an IDLE session `queue`/`force`/`queueId` are
   *  no-ops — admission falls straight through to the normal dispatch
   *  path below, identical to `queue` omitted. `interrupt` is checked
   *  first: an `{interrupt: true, queue: true}` pair interrupts (never
   *  queues) exactly like `interrupt` alone. */
  enqueuePrompt(
    id: string,
    message: unknown,
    opts?: {
      interrupt?: boolean
      source?: string
      /** Display origin for the after-the-fact queue UI ("user" for a
       *  human operator, agent/child when another session injected this).
       *  Sets `QueuedPrompt.origin` — see that field; does NOT influence
       *  transcript provenance (`source` does that). */
      origin?: string
      queue?: boolean
      force?: boolean
      queueId?: string
      /** A typed inter-session message (see `QueuedPrompt.envelope`). When
       *  set, the turn is built from the envelope and `message` is ignored:
       *  rendered as an `<agentproto-message>` tag, recorded as
       *  `session-message` (never `user-prompt`), never matched as a
       *  structured-question answer, and noted in the SENDER's transcript
       *  as `session-message-sent`. */
      envelope?: SessionMessage
      /** Explicitly revive a RETIRED row (`isRetired`) that this prompt
       *  would otherwise be refused on (`session_superseded` /
       *  `session_retired`). Operator override; never set by automation. */
      forceResume?: boolean
      /** On the queue arm, inject this prompt into the target's RUNNING turn
       *  at the next safe point (ACP steering) instead of waiting for the
       *  turn to end — when the agent advertises steering. FIFO among steered
       *  prompts. Ignored for envelopes and child-sourced prompts; absent ⇒
       *  today's park-until-turn-end. A refused steer leaves it queued. */
      steer?: boolean
      /** Deadline in ms: a prompt still queued past it is force-delivered by
       *  the pending-prompt sweep per `deliverVia`. */
      deliverWithinMs?: number
      /** `steer` — inject only (stay queued if it can't); `interrupt` —
       *  cancel the turn and run it; `auto` (default) — steer, else interrupt. */
      deliverVia?: "auto" | "steer" | "interrupt"
      /** Coalescing key (`sentinel-coalesce.ts`'s `coalesceKeyFor`, prefixed
       *  `sentinel:`): on the queue arm, an item already waiting with this
       *  key is REPLACED in place (newest message wins, id + position kept,
       *  `coalescedCount` incremented) instead of a second item being pushed. */
      coalesceKey?: string
    }
  ): Promise<EnqueuePromptResult>
  /** One pass over every prompt queue: force-deliver items past their
   *  `deliverWithin` deadline, and notify the sender (typed `notice` into the
   *  caller's — else the target's parent's — inbox) once per item that has
   *  waited past `staleMs`. Driven on a timer by the daemon; callable directly. */
  sweepPendingPrompts(opts?: { now?: number; staleMs?: number }): Promise<PendingPromptSweepSummary>
  /** Cancel one not-yet-dispatched item in `SessionDescriptor.promptQueue`
   *  by id — the composer's per-item "remove" action. Idempotent: an
   *  unknown session or an id that's already gone (dispatched, already
   *  removed, or never existed) resolves `{removed: false}` rather than
   *  throwing, same shape as `interruptSession`'s no-op-is-not-an-error
   *  contract. */
  removeQueuedPrompt(id: string, queueId: string): { removed: boolean }
  /** Deliver a daemon-attested typed message (`msg.to` is the recipient;
   *  `from` must already be computed from the verified caller), routed by
   *  `msg.urgency` (AIP-46 §Delivery tiers):
   *   - a matching pending `waitForMessages` wins over every tier (waiter
   *     first — returned as that call's result, never also injected);
   *   - `fyi` — durable inbox only, no wake;
   *   - idle recipient — any other tier starts its own turn now;
   *   - busy + `next-turn` — queued behind the current turn;
   *   - busy + `steer` — injected into the running turn when the daemon's
   *     OWN prompt is in flight (never an autonomous cycle), the agent can
   *     steer, and the per-recipient rate limit allows; else `next-turn`;
   *   - busy + `interrupt` — cancels the turn and delivers — only when
   *     `allowInterrupt` (the caller's grant); otherwise downgraded to
   *     `steer`.
   *  `urgencyApplied` reports the tier actually used. Throws when the
   *  recipient is missing or not alive. */
  sendMessage(
    msg: SessionMessage,
    opts?: {
      source?: string
      origin?: string
      allowInterrupt?: boolean
      /** The `session.message` decision the entry point got from
       *  `decide()` (permissions.ts). When present, the sink refuses the
       *  message (`PermissionDeniedError`) unless it allows `msg.to`. The
       *  session-to-session entry points (message tools, `message_parent`,
       *  the HTTP route, the box relay) always pass one; daemon-internal
       *  notices (sentinels, follows, supervisors) do not yet. */
      decision?: Decision
      /** Coalescing key — carried through to `enqueuePrompt`'s queue arm
       *  (sentinel notices use this so a burst about one PR/commit becomes
       *  one queued item). */
      coalesceKey?: string
    },
  ): Promise<SendMessageResult>
  /** Block until a message matching `filter` is in `id`'s inbox (returns at
   *  once when one already is), or `timeoutMs` elapses. Matched messages are
   *  consumed: stamped `delivered.via:"wait"`, removed from the prompt queue
   *  (so they're never also injected as a turn), and — when `ack` (default)
   *  — removed from the inbox. Sets `blockedOn:"inbox"` while parked. */
  waitForMessages(
    id: string,
    filter: MessageFilter,
    opts: { timeoutMs: number; ack?: boolean; signal?: AbortSignal },
  ): Promise<WaitForMessagesResult>
  /** Read `id`'s inbox (un-consumed messages), newest last. */
  listInbox(id: string, filter?: MessageFilter & { limit?: number }): SessionMessage[] | null
  /** Find a message `id` RECEIVED (still in its inbox, or already consumed
   *  and only in its transcript) — how `message_reply` routes to the
   *  original sender. `undefined` when `id` never received `messageId`. */
  findReceivedMessage(id: string, messageId: string): SessionMessage | undefined
  /** Ack (remove) messages from `id`'s inbox — and from its prompt queue, so
   *  an acked-but-still-queued message is never delivered afterwards. */
  ackInbox(id: string, ids: readonly string[] | "all"): { acked: string[] }
  /** Snapshot a session's prompt queue for inspection — the after-the-fact
   *  view of what's sitting in `SessionDescriptor.promptQueue` right now.
   *  Runs the shared preview + origin-label derivation so every consumer
   *  (the `session_queue_list` MCP tool, `GET /sessions/:id/queue`, the CLI,
   *  the VS Code panel) sees identical text. `position` is the array index
   *  (0 = next to dispatch), not stored — derived per call. Returns `null`
   *  when the session is unknown (the caller surfaces 404). */
  listQueuedPrompts(id: string): QueuedPromptView[] | null
  /** Reorder-only force: move an already-queued item to the FRONT of the
   *  queue (position 0) WITHOUT touching any turn currently in flight — it
   *  becomes next-to-dispatch once the current turn (if any) ends. The
   *  queue-reordering counterpart to `deliverQueuedPrompt`'s interrupt-and-
   *  dispatch; the two are deliberately distinct operations. Returns
   *  position after promotion (0 when promoted, -1 when the item/session
   *  isn't found). Never mutates the array in place (the webview diff rules
   *  on `!==` per field). */
  promoteQueuedPrompt(id: string, queueId: string): { promoted: boolean; position: number }
  /** Deliver-now: interrupt whatever's mid-flight (same effect + shared
   *  helper as `enqueuePrompt`'s `interrupt` arm) and immediately dispatch
   *  THIS specific queued item as the new turn, removing it from the queue.
   *  The "I need this NOW" op — distinct from `promoteQueuedPrompt` (which
   *  only reorders; deliver-now cannot wait for the current turn to end).
   *
   *  Implemented as promote-to-front + interrupt: the cancelled turn's
   *  own `dispatchQueuedPrompt` (in its finally) then drains the promoted
   *  item — and only that item; the rest wait for a natural turn-end —
   *  into a fresh turn. On an idle session (nothing to interrupt) the
   *  promoted item is dispatched directly. Returns:
   *    `{ delivered: false, reason }` — `"no-session"` / `"not-in-queue"`;
   *    `{ delivered: true, interrupted: boolean }` otherwise. */
  deliverQueuedPrompt(
    id: string,
    queueId: string
  ): Promise<{ delivered: boolean; reason?: string; interrupted?: boolean }>
  /** A currently-RUNNING background task's info plus a tail of its output
   *  file, for the UI's "click a live background-task row to peek at its
   *  output" affordance. Scoped to `SessionDescriptor.backgroundTasks` on
   *  purpose — a settled task is dropped from that list moments after it
   *  reports terminal status (see `noteBackgroundTask`), so this never
   *  becomes an arbitrary-file-read: the caller supplies a `taskId`, never a
   *  path, and only a path the agent itself already reported for a task
   *  still tracked as running is ever read. Returns `null` when the session
   *  or the task is unknown (the caller surfaces 404); `tail` is `null` when
   *  the task has no `outputFile` or the file can't be read (not yet
   *  created, already rotated away, ...). */
  readBackgroundTaskTail(
    id: string,
    taskId: string
  ): { task: SessionBackgroundTask; tail: string | null } | null
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
  /** Opaque id unique to this registry instance — one per daemon boot.
   *  Stamped as `interruptedAtBoot` on rows the boot reload finds interrupted,
   *  so `interruptedAtBoot === bootId` means "interrupted by the restart that
   *  preceded THIS boot" (continue-interrupted). */
  readonly bootId: string
  /** Absolute base dir this registry's per-session transcripts AND index
   *  sidecars live under — the SAME dir the writers use (`sessions.eventsDir`
   *  config > default). Exposed so `session_search`/`session_recap` (and a
   *  daemon-startup backfill) read the sidecars this registry writes without
   *  re-deriving the path. */
  readonly transcriptBaseDir: string
  /** Flush any throttled index-sidecar writes immediately. Called at
   *  shutdown; exposed so a test can assert a trailing write landed without
   *  waiting out the throttle window. Best-effort and synchronous. */
  flushSessionIndexes(): void
  /** Book one automatic continue prompt against `id` (increment
   *  `autoContinueAttempts`, stamp `lastAutoContinueBoot = bootId`) and
   *  persist. Called by the continue-on-boot pass BEFORE it sends, so the
   *  no-loop bound holds even when the continue turn is itself cut off by the
   *  next restart. No-op for an unknown id. */
  recordAutoContinue(id: string): void
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
   * Announce a `session:harness-warning` for a session — an explicit,
   * non-fatal "the host could not honor part of what was asked" notice (the
   * app-boundary fs zones not enforceable on this harness, …). Best-effort
   * observability; no-op when the registry has no event bus.
   */
  emitHarnessWarning(sessionId: string, warnings: readonly string[], label?: string): void
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
  /**
   * Lightweight panel projection of `list()` — returns paginated
   * {@link SessionSummary} rows that exclude large resume/transcript/policy
   * context. Same sort order (newest-first), same archived default, with
   * `limit`/`offset` pagination on top. Used by the VS Code Sessions webview
   * so its first paint is bounded even when the daemon holds hundreds of
   * full descriptors.
   */
  listSummaries(opts?: {
    includeArchived?: boolean
    lane?: "agents" | "auto"
    limit?: number
    offset?: number
  }): { summaries: SessionSummary[]; total: number }
  get(id: string): SessionDescriptor | undefined
  /** Register a live waiter on a session (#session-visibility) — bumps the
   *  ephemeral `watchers` counter surfaced on the descriptor at read time.
   *  Called by `monitorSessionWait` when a `/sessions/:id/wait` long-poll or
   *  `session_monitor` subscription actually blocks. A no-op for an unknown id
   *  is fine (the wait may outlive the row). `detail`, when passed, is held
   *  (by reference) alongside the count and surfaced as
   *  `SessionDescriptor.watcherDetails` — pass the SAME object reference to
   *  the matching {@link decWatchers} call so removal is exact. */
  incWatchers(id: string, detail?: SessionWatcherInfo): void
  /** Balance an {@link incWatchers} when the waiter resolves or times out.
   *  Clamps at 0 and drops the map entry at zero so the counter can't leak.
   *  Pass the same `detail` reference given to `incWatchers` to remove it from
   *  `watcherDetails`; omitted/mismatched detail leaves the count balanced but
   *  the detail list untouched (defensive — should not happen in practice). */
  decWatchers(id: string, detail?: SessionWatcherInfo): void
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
  /** Drop ONE terminal session's descriptor — the single-row form of
   *  `gcSessions({ forget: true })` (retire as "forgotten", delete, persist).
   *  `"alive"` ⇒ refused (running/starting); `"missing"` ⇒ unknown id. Used
   *  by the on-disk retention pass before it removes the session dir. */
  forgetSession(id: string): "forgotten" | "missing" | "alive"
  /** On-disk retention sweep (`session-retention.ts`): DELETE terminal
   *  session dirs under `transcriptBaseDir` past their age threshold —
   *  review lanes after `reviewMaxAgeDays` (default 7), everything else only
   *  when `maxAgeDays` is set. Unset options fall back to the registry's
   *  configured `sessionRetention` defaults. Async + batched; never touches
   *  a live, pinned or keepAlive session or an ancestor of a live one. */
  pruneSessionDirs(opts?: SessionRetentionOptions): Promise<SessionRetentionResult>
  /** Set or clear a session's user-facing name and/or its `slug`. This is
   *  the write-path behind `PATCH /sessions/:id` and the `session_rename` MCP
   *  verb; the registry honours a `slug` key on `patch`, and those two
   *  surfaces forward it once their schemas carry it (owned by WP-A2 / WP-C1
   *  — this method is the contract they call). Each of
   *  `title`/`label`: a non-empty string sets that field (trimmed, capped to
   *  the derivation's `MAX_LENGTH` by code point); an empty/whitespace-only
   *  string or `null` CLEARS it (the UI reverts to the derived title /
   *  friendly fallback); `undefined` leaves it untouched. `slug` (the
   *  addressable human handle, WP-B1): a non-empty string sets it — slugified
   *  and de-duplicated against every other held session with `-2`, `-3`, …;
   *  an empty string or `null` clears it; `undefined` leaves it untouched.
   *  Persists via the same `schedulePersist` every descriptor mutation uses,
   *  and emits `session:renamed` so live UIs repaint. `title`/`label` writes
   *  are pure display state; a `slug` write only changes the addressable
   *  handle. Never touches the live agent. Throws when the id is unknown. */
  renameSession(
    id: string,
    patch: { title?: string | null; label?: string | null; slug?: string | null },
  ): SessionDescriptor
  /** Set or clear a session's idle-reaper exemption (the `session_set_keepalive`
   *  MCP verb). `true` flips `SessionDescriptor.keepAlive` on — `isReapable`
   *  (idle-reaper.ts) then never retires this session no matter how idle it
   *  sits; `false` clears it, restoring ordinary reap eligibility. Persists via
   *  the same `schedulePersist` every descriptor mutation uses. Pure display/
   *  policy state — never touches the live agent. Throws when the id is
   *  unknown. */
  setKeepAlive(id: string, keepAlive: boolean): SessionDescriptor
  /** Merge string-valued descriptor meta hints onto an existing session
   *  (`meta` is `Record<string, string>` — values are encoded, e.g. the
   *  JSON-encoded `meta.cloud` mapping from cloud-vendors.ts). Keys already
   *  present are overwritten; other keys are untouched. Persists via the
   *  same `schedulePersist` every descriptor mutation uses. Never touches
   *  the live agent. Throws when the id is unknown. */
  mergeMeta(id: string, patch: Record<string, string>): SessionDescriptor
  /** AIP-42 hot role refresh (the `session_role_refresh` MCP verb) — reload
   *  a manifest-spawned session's AGENT.md, re-render it through the SAME
   *  projection the spawn used, and diff against the fingerprint recorded
   *  at spawn (`meta.agentRoleHash`/`agentToolsHash`, agent-role-refresh.ts).
   *  The session must carry `meta.agentManifestPath` (set only by a spawn
   *  that named `agentId`/`agentPath`) — anything else resolves
   *  `{ok:false, code:"not_manifest_spawned"}`.
   *
   *  A changed role is PUSHED into the live session as a `steer`-tier
   *  system notice (busy ⇒ steered into the running turn; idle ⇒ a fresh
   *  turn) and `meta.agentRoleHash` is advanced to the new value — the
   *  session's live behavior and its recorded fingerprint move together.
   *  A changed tool list is only REPORTED (`toolsChanged: true`): stdio MCP
   *  servers are fixed at spawn, so it can't be applied without a restart
   *  (`session_restart`) — `meta.agentToolsHash` is deliberately left at
   *  its old value so a later refresh keeps reporting the drift until an
   *  actual restart re-baselines it. `dryRun: true` computes the diff
   *  without pushing anything or touching `meta`. Never mutates the live
   *  agent's MCP servers or model — those are restart-only axes. */
  refreshAgentRole(
    id: string,
    opts?: { dryRun?: boolean },
  ): Promise<AgentRoleRefreshOutcome>
  /** Opt-in, event-driven auto-refresh: watch a manifest-spawned session's
   *  AGENT.md file (`fs.watch`, debounced — never polls) and call
   *  `refreshAgentRole` on every change. `enabled: false` stops an existing
   *  watch; starting one twice for the same session replaces the first.
   *  Off by default — a session is only watched after an explicit
   *  `session_role_watch` call. Watches are in-memory only (not persisted;
   *  a daemon restart drops them, same as every other live-process-only
   *  watcher in this codebase). Returns false when the session is unknown
   *  or has no `meta.agentManifestPath` to watch. */
  setAgentRoleWatch(id: string, enabled: boolean): boolean
  /** Set or clear a session's list-visibility pin (the `session_set_pinned`
   *  MCP verb / `POST /sessions/:id/pin`). `true` flips
   *  `SessionDescriptor.pinned` on — pure sort/display state for the CLI
   *  table and the VS Code webview's list, which sort a pinned session to
   *  the top. Pinning a session that isn't pinned yet APPENDS it to the
   *  end of the pinned group (`pinnedOrder` = max pinned order over the
   *  currently pinned + 1, missing treated as -1); re-pinning an already
   *  pinned session keeps its order. `false` clears the pin and deletes
   *  `pinnedOrder`. Persists via the same `schedulePersist` every
   *  descriptor mutation uses and emits `session:pinned-changed` so a
   *  live UI resorts without waiting for its next snapshot poll. NEVER
   *  touches `keepAlive`, reaper eligibility, or any notification path —
   *  pin is quiet, structural state only. Throws when the id is unknown. */
  setPinned(id: string, pinned: boolean): SessionDescriptor
  /** Manually reorder the pinned group (the `session_reorder_pinned` MCP
   *  verb / `POST /sessions/pinned/order`). Every id must exist and be
   *  pinned — throws `reorderPinned: ...` otherwise (duplicates rejected
   *  too). Listed ids get `pinnedOrder` 0..n-1 in the given order; every
   *  other pinned session keeps its relative order and is placed after
   *  (legacy pinned rows with no `pinnedOrder` sort by `startedAt` asc,
   *  then id). Persists via `schedulePersist`, emits
   *  `session:pinned-reordered` on the session event bus, and returns the
   *  pinned descriptors in their new order. */
  reorderPinned(ids: string[]): SessionDescriptor[]
  /** Set (or clear, with `undefined`/[]) the drive-tool caller allowlist
   *  (`SessionDescriptor.allowPromptFrom`) — the "who else can prompt/drive
   *  this session" policy. Caller is responsible for the owner/operator
   *  gate (`agent_set_prompt_policy` checks it). Persists via
   *  `schedulePersist` — the descriptor row is written whole. */
  setPromptPolicy(id: string, allowPromptFrom: string[] | undefined): SessionDescriptor
  /** Lineage handover - record that `toId` TOOK OVER `fromId`'s position in
   *  the spawn tree: `from.succeededBy = toId` and `to.succeeds = fromId`
   *  (both persisted, both already written by the handover itself when it
   *  ran - this method exists so a DECLARATION can be recorded without a
   *  re-parenting, e.g. `agent_start.succeeds` on a spawn whose predecessor
   *  had no live children). Throws when either id is unknown. */
  setLineageSuccessor(fromId: string, toId: string): SessionDescriptor
  /** Lineage handover - re-parent a session: `id`'s `parentSessionId`
   *  becomes `newParentId` (the child keeps its own id, transcript and
   *  state; only the lineage pointer moves). This is what makes the
   *  successor the child's OWNER (the drive-tool gate keys on
   *  `parentSessionId`) and what routes the child's `message_parent` to
   *  the successor instead of the retired predecessor. `newParentId`
   *  `undefined` makes the session a ROOT (no parent) - the shape a
   *  successor of a root session takes. The child's `depth` is re-derived
   *  from the new parent. Persists via `schedulePersist`; throws when
   *  the session id is unknown. */
  reassignParent(id: string, newParentId: string | undefined): SessionDescriptor
  /** Emit a `session:lineage-handover` journal entry on the session event
   *  bus - the lineage handover's own audit trail. Daemon-internal. */
  emitLineageHandover(event: import("./session-event-bus.js").SessionLineageHandoverEvent): void
  /** Stamp (or clear) the immutable `operatorLabel` (see
   *  `SessionDescriptor.operatorLabel`). Daemon-internal: called only by the
   *  `agent_start` handler for operator spawns and by the restart /
   *  continue-fresh carry-forward — never exposed as an MCP tool. */
  setOperatorLabel(id: string, operatorLabel: string | undefined): SessionDescriptor
  /** Record on the session event bus that a drive-tool prompt was accepted
   *  for `id`, and WHO sent it (`caller` = the trusted calling session id,
   *  or the literal `"operator"`). No-op when the registry was constructed
   *  without a `sessionEvents` bus. */
  noteSessionPrompt(id: string, caller: string, queued: boolean): void
  /** Materialize a new artifact (or version of one) into the session's
   *  durable artifact store (`session_artifact_add` MCP verb / `POST
   *  /sessions/:id/artifacts`) — see `session-artifacts.ts`. Emits
   *  `session:artifact-added` on a real (non-deduped) write. Throws when
   *  the id is unknown. */
  addSessionArtifact(id: string, input: AddSessionArtifactInput): ArtifactRecord
  /** Current-state fold of the session's artifact store — every key's
   *  version history, most-recently-updated first. Empty array for a
   *  known session with no artifacts yet. Throws when the id is unknown. */
  listSessionArtifacts(id: string): ArtifactRecord[]
  /** One artifact version's metadata plus its bounded file content (single-
   *  file kinds only — a "site" version's content is browsed via the raw-
   *  serve HTTP route instead). Undefined when the key/version doesn't
   *  exist. Throws when the session id is unknown. */
  getSessionArtifact(
    id: string,
    key: string,
    opts?: { version?: number; maxBytes?: number },
  ): GetSessionArtifactResult | undefined
  /** Set or clear an artifact's pin (`session_artifact_pin` MCP verb /
   *  `POST /sessions/:id/artifacts/:key/pin`). Emits
   *  `session:artifact-pinned-changed`. Undefined when the key doesn't
   *  exist. Throws when the session id is unknown. */
  setArtifactPinned(id: string, key: string, pinned: boolean): ArtifactRecord | undefined
  /**
   * Manually override `awaitingInput`/`awaitingQuestion` (the
   * `session_flag_status` MCP verb) — the ONE write path for this pair
   * besides the internal heuristic (`deriveHeuristicQuestion`) and a
   * driver-reported `agent-prompt`, both of which only ever run inside a
   * live turn. Lets a human, another agent, or the session watchdog correct
   * a missed real question (`awaitingInput:true`, optionally attaching
   * `question`) or clear a false positive (`awaitingInput:false`).
   * `awaitingInput:false` ALWAYS clears `awaitingQuestion` too, regardless
   * of what `question` was passed — a question cannot outlive its
   * awaiting-input flag. When `question` is given alongside `true`, it's
   * stored as `{ text: question, source: "structured" }` (an explicit
   * override is at least as authoritative as a driver-reported prompt).
   * Guard mirrors the INVERSE of `archiveSession`'s: only a LIVE session
   * (running/starting) may be flagged — a terminal session has no turn left
   * to be "awaiting" anything, so correcting it there would be fiction with
   * nothing downstream (`session_monitor`, the webhook notifier) to observe
   * it. Persists via `schedulePersist` and emits
   * `session:awaiting-input-flagged` (carrying the required `reason`) so
   * the correction is visible via `session_events_poll` same as every other
   * lifecycle event. Cleared automatically like any other awaiting-input
   * signal on the session's next prompt/turn start. Throws when the id is
   * unknown or the session is terminal.
   */
  flagAwaitingInput(
    id: string,
    patch: { awaitingInput: boolean; question?: string; reason: string },
  ): SessionDescriptor
  /** Subscribe to a session's output. Returns an unsubscribe fn.
   *  Initial backfill: synchronously invokes `onLine` once for each
   *  line currently in the ring buffer so attaches show context. */
  attach(
    id: string,
    onLine: (line: string, stream: "stdout" | "stderr") => void
  ): (() => void) | null
  /** Append a `kind: "mcp_app_tool_call"` record (an MCP App iframe's
   *  `tools/call`, proxied by `mcp_app_tool_call`) to the session's
   *  events.jsonl through the same seq-numbered writer the session's own
   *  events use. No-op-safe for an unknown id (the writer creates the dir). */
  recordMcpAppToolCall(sessionId: string, record: McpAppToolCallRecord): void
  /** Tool name the transcript recorded for `toolCallId` (the latest
   *  non-empty `toolName` across its `tool-call` records), or undefined
   *  when the id isn't in the session's events.jsonl. */
  findToolCallName(sessionId: string, toolCallId: string): Promise<string | undefined>
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
  /** Last observed bracketed-paste mode for a PTY session, tracked from
   *  the PTY's OUTPUT stream (see `scanBracketedPaste`). `"unknown"` for
   *  a missing/non-PTY session or one that hasn't emitted either
   *  `\x1b[?2004h`/`\x1b[?2004l` sequence yet. */
  getBracketedPasteMode(id: string): BracketedPasteMode
  /** Snapshot the recent PTY byte buffer as one Buffer. Newest
   *  bytes at the end; `lastBytes` caps the returned size from the
   *  tail. Returns null when the session is missing or not a PTY. */
  readTerminalOutput(id: string, lastBytes?: number): Buffer | null
  /** SIGTERM the underlying child + close the agent protocol session.
   *  `reason`, when given, is stamped onto `SessionDescriptor.endedReason`
   *  (see {@link SessionEndReason}) — pass it from every call site that
   *  knows WHY it's killing this session (an operator's explicit stop, a
   *  supervisor tearing down its own judge session, …) rather than leaving
   *  the row's cause of death unlabeled. Omitted preserves today's
   *  behaviour: no `endedReason` is stamped by this call (the row may
   *  already carry one from elsewhere, e.g. a prior `reapIdle`/`markCrashed`
   *  — moot in practice since both already refuse a non-"running" row before
   *  `kill()` would ever run on it).
   *
   *  A row that's ALREADY terminal (exited/killed/error) normally makes this
   *  a no-op refusal (`false`) — EXCEPT `reason: "operator-completed"`,
   *  which is instead treated as "mark as completed": the persisted
   *  outcome's `termination.reason` is idempotently relabeled to
   *  `"operator-completed"` (the true original mechanism preserved in
   *  `termination.previousReason`) and this returns `true`. Every other
   *  reason (including `"operator-stopped"` or none) on a terminal row
   *  stays the plain no-op.
   *
   *  `outcome` (optional) stamps a Level-2 declared outcome on the row —
   *  the verdict plus the structured {@link OutcomeDetail} (reason /
   *  question / errorKind / nextStep / by) — after the termination fields
   *  are set, exactly like `closeWithOutcome`. On a row that is ALREADY
   *  terminal and given NO `reason`, it labels the existing outcome only
   *  (liveness, `endedReason` and retirement are untouched) and returns
   *  `true`; that is how a finished-but-unlabeled row gets a manual
   *  failed/done/abandoned label. */
  kill(id: string, signal?: NodeJS.Signals, reason?: SessionEndReason, outcome?: StopOutcomeInput): boolean
  /** Close a LIVE agent-cli session with a Level 2 (judged/declared) outcome
   *  — the primitive the session steward (FIX-9A/9B) drives once a wrap-up
   *  plan (`planSessionWrapup`, `session-wrapup.ts`) puts a session in the
   *  `close`/`stuck` class, or a judge agent reaches a verdict on a `judge`
   *  one. Verdict `"done"` or `"abandoned"` actually closes: terminates the
   *  same graceful way `kill()` does, tags `endedReason: "steward-completed"`
   *  (`"done"`) or `"steward-abandoned"` (`"abandoned"`), and — like
   *  `reapIdle`, unlike a plain `kill()` — CLEARS the in-memory
   *  `agentSession` binding so the row stays lazy-resumable in place. The
   *  recorded outcome's `source`/`verdict`/`judgedBy`/`note` are stamped onto
   *  the row's `SessionOutcome` (see `session-outcome.ts`) on top of what
   *  `deriveSessionOutcome` would otherwise compute (last assistant message,
   *  PRs, cost) — a declared close still shows what the session actually
   *  produced. Verdict `"blocked"` or `"needs-input"` is NOT a completion —
   *  nothing is terminated; the verdict is recorded as
   *  `SessionDescriptor.wrapupFlag` instead, and the session is left exactly
   *  as alive as it was.
   *
   *  Refuses (returns false, no-op) a session that is not a live
   *  (`running`/`starting`) agent-cli row, or that AT THE MOMENT OF THE CALL
   *  is `busy`/`awaitingInput`/`awaitingPermission` or has a background task
   *  outstanding (`pendingBgTasks`/`backgroundTasks`) — a plan computed
   *  moments earlier can be stale; this is the re-check that keeps an
   *  autonomous close from ever landing on a session that just picked up a
   *  turn, asked a question, or still has something in flight. Applies to
   *  BOTH branches (close and flag-only) — a stale plan is refused either
   *  way, never silently acted on. */
  closeWithOutcome(id: string, input: CloseWithOutcomeInput): boolean
  /** Record an operator/judge resolution on a row that has ALREADY ended —
   *  the terminal twin of {@link closeWithOutcome}, and the engine behind
   *  `session_mark_completed` on a dead session (a sandbox box that hit its
   *  time cap after its work was already pushed, a crashed child whose PR
   *  had already merged). It NEVER revives anything and NEVER rewrites the
   *  termination axis: `status`, `endedReason`, `endedAt` and `exitCode`
   *  stay exactly as the death left them, and no process is signalled. All
   *  it does is stamp the SAME Level-2 fields a live close writes
   *  (`source`/`verdict`/`judgedBy`/`summary`/`note` + the structured
   *  `OutcomeDetail`) onto the row's `SessionOutcome`, so list / recap / UI
   *  badges derived from `outcome` (`isOutcomeCompleted`) show the row as
   *  completed instead of failed. `verdict: "done"` additionally relabels
   *  `outcome.termination.reason` to `"operator-completed"` (the true death
   *  mechanism preserved in `previousReason`) and retires the row, matching
   *  the UI's "Mark as completed" affordance (`kill(id, …,
   *  "operator-completed")` on a terminal row) exactly.
   *
   *  Refuses (returns false, no-op): an unknown id, a non-agent-cli row, a
   *  row that is still live (`running`/`starting` — that is `closeWithOutcome`'s
   *  half of the contract), and the `"blocked"`/`"needs-input"` verdicts,
   *  which are not completions and need a live row to wait on. Returns true
   *  iff a resolution was recorded. */
  resolveOutcome(id: string, input: CloseWithOutcomeInput): boolean
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
  /** Flip a LIVE agent-cli row whose adapter OS process is gone to
   *  `status:"error"`/`endedReason:"crashed"` — the primitive the crash-detect
   *  sweep (`runCrashDetectPass`) drives on a periodic sweep. Unlike
   *  `reapIdle`, this is discovering a death that already happened (no exit
   *  event was ever emitted for it), not initiating one — so it never signals
   *  the process, it just reconciles the descriptor to match reality: sets
   *  `endedAt`/`crashedAt`/`lastError` (a short string naming the pid),
   *  appends a `[crashed] …` stderr line, and — same as `reapIdle` — CLEARS
   *  the in-memory `agentSession` binding so the row stays lazy-resumable
   *  (adapterSessionId/cwd left intact). Emits the usual `session:exited`
   *  (carrying `reason: "crashed"`). The row and its transcript are NOT
   *  deleted.
   *
   *  Purely mechanical: the caller (the sweep) owns the liveness-probe
   *  policy. This method only guards the invariant a crash-mark must never
   *  violate — it refuses (returns false, no-op) a session that is not a
   *  live (`running`) agent-cli row, so it is idempotent and safe to call on
   *  an already-terminal or non-agent-cli row. Returns true iff a row was
   *  actually marked crashed.
   *
   *  `reason` names WHICH death was discovered, and is the only thing that
   *  differs between the sweep's two grounds. Omitted ⇒ `"process-gone"`,
   *  the original pid-probe wording ("adapter process gone (pid N) — session
   *  crashed"). `"transport-closed"` is the case a pid probe cannot see: the
   *  wrapper process is still alive but its ACP stream ended, so the row
   *  would otherwise sit `running`/`alive` forever while every prompt
   *  rejects with "ACP connection closed". Only the `lastError`/banner text
   *  changes — every other effect (status, endedReason, cleared binding,
   *  `session:exited`) is identical, because in both cases the session is
   *  equally dead and equally resumable. */
  markCrashed(id: string, reason?: SessionCrashReason): boolean
  /** Flip a LIVE agent-cli sandbox row whose BOX reached its lifetime
   *  deadline while idle to `status:"exited"`/`endedReason:"sandbox-expired"`
   *  — the clean end for an expected box expiry (work already
   *  checkpointed/delivered). Same cleanup shape as `markCrashed` (usage
   *  recap, binding cleared, lazy-resumable, `session:exited`), but never
   *  crash-classified: no `crashedAt`, and `restart-scheduler.ts` policies
   *  (`crashed`/`error`/`sandbox-gone`) never match an exited row. `detail`
   *  is stamped as the row's `lastError` / `[sandbox-expired]` banner.
   *  Returns false (no-op) for anything but a live agent-cli row. */
  markSandboxExpired(id: string, detail: string): boolean
  /** Flip a LIVE, mid-turn agent-cli row to `stalledSinceMs:<ts>` — the
   *  primitive the turn-liveness watchdog (`runStallWatchdogPass`) drives on
   *  a periodic sweep when a turn's adapter stream has gone silent past the
   *  threshold. Unlike `markCrashed`/`reapIdle`, this NEVER changes `status`,
   *  kills anything, or clears the live binding — it's a pure signal
   *  (detection + surfacing only), so the session stays exactly as running
   *  as it was. Emits `session:stalled`.
   *
   *  Purely mechanical: the caller (the sweep) owns the silence/threshold
   *  policy. This method only guards the invariants a stall-mark must never
   *  violate — it refuses (returns false, no-op) a row that isn't a live
   *  (`running`) agent-cli session, isn't currently `busy` (mid-turn), is
   *  legitimately `blockedOn` a subagent/command, has a tool call in
   *  flight (`activeToolCalls` non-empty — a long `pnpm install` is
   *  expected silence, a `tool-call:` phase, never a stall), or is already flagged
   *  stalled (idempotent — the sweep's own candidate filter already excludes
   *  these, this is the second line of defense for any other caller).
   *  Returns true iff the row was actually flagged. */
  markStalled(id: string, stalledSinceMs: number): boolean
  /** Clear a row's `stalledSinceMs` flag — called the instant ANY activity
   *  disproves the stall claim: `pulseActivity` (new adapter traffic), the
   *  next turn's start, and the turn's own `finally` (busy flips false, so
   *  "mid-turn and silent" no longer holds either way). Emits
   *  `session:stall-cleared` — but ONLY when the row was actually flagged;
   *  a session that was never stalled clearing on every turn boundary would
   *  spam the bus with a no-op event on every single turn. Returns true iff
   *  a flag was actually cleared; false (no-op, no event) for an unknown id
   *  or a row that wasn't flagged. */
  clearStalled(id: string): boolean
  /** Whether an in-place resume is currently IN FLIGHT for this session
   *  (`rt.resumePromise` set) — the restart-scheduler's periodic sweep
   *  (`runRestartSweepPass`, PR-2) consults this to skip a row a concurrent
   *  prompt or an overlapping tick is already reviving, rather than piling
   *  on a redundant call. Returns false for an unknown id. */
  isResuming(id: string): boolean
  /** Proactively drive the SAME in-place resume path lazy resume-on-prompt
   *  uses (`maybeResumeAgent`) for a row the restart-scheduler (PR-2) decided
   *  is due — the sweep-side half of "reuse in-place resume, don't
   *  reinvent". Emits `session:resumed` with `resumedFrom: "restarted"` on
   *  success (distinct from the lazy path's `"daemon-restart"`). A resume
   *  that fails (adapter refuses, `ResumeDisabledError` once
   *  `MAX_RESUME_ATTEMPTS` is burned) is swallowed here — not re-thrown —
   *  since the sweep drives many rows per tick and one bad row must never
   *  abort the rest; the row simply stays dead until its next
   *  `session:exited`-triggered re-schedule. Returns true iff the session is
   *  live (`agentSession` bound) afterward; false for an unknown id or a
   *  resume that didn't take. */
  triggerResume(id: string, opts?: { force?: boolean }): Promise<boolean>
  /** Execute the restart-scheduler's "box is gone" schedule for a dead box
   *  session — the FRESH-BOX move `session_restart` takes (`restartAgentSession`
   *  → `spawnOnFreshBox`), never an in-place revival. Driven by the sweep for
   *  a row whose `nextRestartFreshBox` was stamped with its `nextRestartAt`.
   *  Delegates to the gateway-wired `restartSandboxGone` hook; when the hook
   *  reports a blocker (no workspace remote, no wiring, the move threw) this
   *  consumes the schedule and stamps exactly one `[sandbox-gone]` notice on
   *  the row instead of retrying. On success the superseded row's schedule is
   *  consumed and its rolling restart window (`restartAttempts`/
   *  `recentRestartAts`/`lastRestartAt`) is carried onto the fresh descriptor
   *  so the `maxRetries`/`windowMs` crash-loop cap keeps counting across
   *  moves. Returns true iff a fresh descriptor was minted. */
  triggerSandboxGoneRestart(id: string): Promise<boolean>
  /** Stamp a row as deliberately retired (`retiredAt`, optionally `continuedTo`)
   *  and notify `onSessionRetired` listeners. Idempotent. Unknown id → undefined. */
  markRetired(
    id: string,
    opts?: { continuedTo?: string; cause?: SessionRetiredCause }
  ): SessionDescriptor | undefined
  /** Subscribe to retirement (kill-with-deliberate-reason, steward close,
   *  archive, gc, continuation/superseding restart). Returns an unsubscribe. */
  onSessionRetired(listener: (ev: SessionRetiredEvent) => void): () => void
  /** Stamp a restart-scheduler (PR-2) schedule onto a row: the next sweep
   *  landing time plus the rolling-window bookkeeping (`restartAttempts`/
   *  `recentRestartAts`/`lastRestartAt`) the crash-loop cap reads on the
   *  NEXT `session:exited` for this row. Purely mechanical — the caller
   *  (the scheduler's event handler) owns the backoff/window-cap policy via
   *  `evaluateRestartDecision`. Returns false (no-op) for an unknown id. */
  applyRestartSchedule(
    id: string,
    update: {
      nextRestartAt: string
      restartAttempts: number
      recentRestartAts: string[]
      lastRestartAt: string
      /** True when the scheduled restart is a fresh-box move rather than an
       *  in-place resume — persisted as `nextRestartFreshBox`. */
      freshBox?: boolean
    },
  ): boolean
  /** Terminally abandon the restart-scheduler's (PR-2) crash-loop for a row:
   *  clears any pending `nextRestartAt` (so the sweep never picks it back
   *  up) and stamps a `[crash-loop] …` line into both the ring buffer and
   *  the durable transcript — the human-visible "gave up" signal `markCrashed`'s
   *  `[crashed]` banner mirrors. `restartAttempts`/`recentRestartAts` are
   *  left in place (only a healthy turn-end clears those) so the rolling
   *  window keeps aging out naturally rather than being wiped by the
   *  give-up itself. Returns false (no-op) for an unknown id. */
  giveUpRestart(id: string, message: string): boolean
  /** Write the turn-retry controller's (`turn-retry.ts`) bookkeeping onto a
   *  row: each key present in `patch` is set, or deleted when `null`; absent
   *  keys are left alone. Purely mechanical — the controller owns the policy.
   *  Returns false (no-op) for an unknown id. */
  patchTurnRetry(
    id: string,
    patch: {
      turnRetryAttempts?: number | null
      turnMigrations?: number | null
      lastTurnRetryAt?: string | null
      nextTurnRetryAt?: string | null
    },
  ): boolean
  /** Record a daemon-authored DISPLAY-ONLY notice into an agent-cli
   *  session's transcript — the same `kind: "notice"` event `markCrashed`/
   *  `giveUpRestart`/`interruptInFlightTurn` already stamp on their own
   *  teardown/interrupt paths (see transcript-writer.ts's "notice" case),
   *  exposed generically for a caller with just a session id, no `rt`
   *  in hand. Appends to `events.jsonl` (so `session_story`/`live_session`
   *  render it as a system message) and the ring buffer — nothing else:
   *  it does NOT touch `promptQueue`, the inbox, or `busy`, so it can never
   *  enqueue a prompt, wake an idle session into a turn, or interrupt a busy
   *  one. Returns false (no-op) for an unknown id or a non-`agent-cli`
   *  session. */
  recordNotice(id: string, text: string): boolean
  /** Stamp a sandbox session's teardown delivery outcome onto its descriptor
   *  and transcript (`notice`). Returns false for an unknown id or a
   *  non-`agent-cli` session. */
  recordSandboxDelivery(id: string, record: SandboxDeliveryRecord, notice: string): boolean
  /**
   * Stamp a periodic checkpoint of a sandbox session's work branch
   * (`sandbox-delivery.ts`'s checkpoint mode) onto the descriptor. Unlike
   * {@link recordSandboxDelivery} the session is still live: the transcript
   * writer stays open, and a checkpoint that changed nothing writes no notice.
   */
  recordSandboxCheckpoint(id: string, record: SandboxDeliveryRecord, notice: string): boolean
  /**
   * Replace a box session's delivery target — the turn-end safety net found
   * the agent on a different `wt/` branch than the one recorded. No notice,
   * no transcript write: it only updates the field a restart reads. Returns
   * false for an unknown id or a non-`agent-cli` session.
   */
  setSandboxDeliveryTarget(id: string, target: SandboxDeliveryTarget): boolean
  /**
   * BOOTSTRAP P7b — append pre-shaped MIRROR records (from
   * `device-mirror.ts`) into an agent-cli session's durable transcript.
   * Each record already carries its own `kind` + `origin: "device"` +
   * `hostSeq` fields; this assigns the controller-local `seq`/`ts` the
   * session's own writer would (`recordMirrorEvents`), in file order.
   * Deliberately BYPASSES `recordEvent`'s kind/coalescing logic — a mirror
   * replay must be byte-faithful to what was computed, never re-shaped or
   * debounced. Returns the number of records written; 0 for an unknown id,
   * a non-`agent-cli` session, or a session that is not device-mirrored at
   * all (the caller checked, but double-checks here to keep a local session's
   * transcript mirror-free even on a stale caller).
   */
  appendDeviceMirrorRecords(
    id: string,
    records: readonly Record<string, unknown>[],
  ): number
  /**
   * Scan the same transcript `appendDeviceMirrorRecords` writes, computed
   * against the registry's OWN transcript base dir (the mirror reader
   * `device-mirror.ts` must never re-derive the path). Returns the mirror
   * cursor (max `hostSeq` among `origin: "device"` records — 0 when this
   * session has never been mirrored) and the ordered controller-local
   * user-prompt texts (kind `user-prompt`, NOT device-tagged) the seed walk
   * matches against the host transcript. File absent/empty ⇒ all empty.
   */
  scanDeviceMirrorState(id: string): {
    cursor: number
    localPromptTexts: readonly string[]
  }
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
  /** Stop tracking a session. A still-live session is torn down through
   *  `kill` first (same teardown as `agent_kill`), so forgetting never
   *  orphans a running process tree. */
  forget(id: string): boolean
  /** Await every best-effort fire-and-forget per-session write currently in
   *  flight — the `CommandLogEntry` → `ToolCallRecord` chain `recordCommand`
   *  kicks off, and the transcript-stream closes `forget()`/`shutdown()`
   *  start. Resolves once they've all settled (success
   *  or swallowed failure), and immediately when nothing is pending. A live
   *  daemon never needs this (it doesn't remove the transcript base dir out
   *  from under an in-flight write); a test that tears that dir down right
   *  after a `command_execute` MUST drain first or race the removal
   *  (ENOTEMPTY on the parent rmdir, or ENOENT in the writer). `shutdown()`
   *  is sync (it runs from `process.on("exit")`) so it can't await these —
   *  this is the async escape hatch for callers that can. */
  settlePendingWrites(): Promise<void>
  /**
   * Graceful-shutdown step for sandbox sessions: detach every attached
   * provider-box session (close the connection only — the box and its agent
   * session keep running), persist the re-attach record, and ask each box to
   * extend its lifetime past the restart gap. Await it BEFORE `shutdown()`;
   * `shutdown()` alone detaches too, but synchronously and without the
   * lifetime extension. Idempotent.
   */
  detachSandboxSessions(): Promise<{ detached: number }>
  /**
   * `session_restart` of a sandbox session: cut this row's proxy loose from
   * its box WITHOUT touching the box or its agent session — the connection
   * and the proxy's timers are dropped, and the proxy's later `close()` (from
   * `kill()`) becomes a no-op, so closing the row can no longer tear down the
   * box its replacement now runs in. Unlike a shutdown detach, the row is NOT
   * marked for the boot reattach pass. Returns the box-side session id the
   * proxy was driving, when it had one to give; undefined for a row with no
   * live detachable proxy (already closed, unbound, device-paired, local).
   */
  releaseSandboxSession(id: string): string | undefined
  /** Rows a previous daemon process detached (or crashed holding) that the
   *  boot reattach pass has not resolved yet. */
  sandboxReattachCandidates(): SessionDescriptor[]
  /** Resolve one re-attach candidate — see {@link SandboxReattachResult}. */
  finishSandboxReattach(id: string, result: SandboxReattachResult): SandboxReattachOutcome
  /** Record how many detached-at-boot rows belong to a workspace bucket this
   *  daemon does not serve. Those rows are left untouched for the daemon that
   *  does serve them, and excluded from `pending` — see
   *  {@link SandboxSessionStats.reattach}. */
  noteSandboxReattachUnserved(count: number): void
  /** Live + restart bookkeeping for `/health` and `daemon_health`. */
  sandboxSessionStats(): SandboxSessionStats
  /** Stop persisting + close all sessions. Killed children are not
   *  awaited — the daemon shutdown loop handles process tree teardown. */
  shutdown(): void
}

/** How the boot reattach pass resolved one detached sandbox row. */
export type SandboxReattachResult =
  | {
      kind: "attach"
      agentSession: AgentSessionLike
      probe: SandboxReattachProbe
      readUsage?: () => Promise<UsageReadResult | null>
    }
  /** The box (or its session) no longer exists. */
  | { kind: "gone"; detail?: string }
  /** The box answered but its agent session had already finished. */
  | { kind: "ended"; detail?: string }
  /** Transient: the box couldn't be reached — row falls back to the plain
   *  `daemon-restart` ghost (eager resume / continue-interrupted apply). */
  | { kind: "failed"; detail?: string }

export interface SandboxReattachOutcome {
  status: "reattached" | "gone" | "ended" | "failed" | "skipped"
  /** True when a turn was already running (or had unseen events) and is now
   *  being replayed into the host transcript. */
  resumedTurn?: boolean
}

/** Restart bookkeeping for sandbox sessions, as surfaced on `/health`. */
export interface SandboxSessionStats {
  /** Provider-box sessions currently attached and live in this daemon — the
   *  number a restart right now would DETACH rather than kill. */
  attached: number
  reattach: {
    /** Rows this boot found detached by the previous process. */
    detachedAtBoot: number
    reattached: number
    gone: number
    failed: number
    /** Rows detached at boot that belong to a workspace bucket this daemon
     *  does not serve — left untouched for the daemon that does. Never
     *  reported as `pending`. */
    unserved: number
    /** `detachedAtBoot` minus everything resolved so far (and minus
     *  `unserved`). */
    pending: number
  }
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
  /** Provenance stamped on the descriptor (lifecycle filters, `session_list`
   *  grouping) — `app-service:<appId>` for an adopted app-service process. */
  origin?: string
  /** Full argv of the adopted child — recorded verbatim on the descriptor. */
  argv?: string[]
  /** Working directory the child was spawned in — recorded on the descriptor. */
  cwd?: string
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
  /** Manifest-declared resume capability, recorded verbatim onto
   *  {@link SessionDescriptor.resumable} — see that field's doc. */
  resumable?: boolean
  /** Manifest-declared native-terminal resume capability, recorded verbatim
   *  onto {@link SessionDescriptor.nativeTerminalResume} — see that field's doc. */
  nativeTerminalResume?: boolean
  /** Canonical harness slug — recorded on the descriptor; defaults to adapterSlug. */
  harness?: string
  /** Manifest-declared `routeSelection` (AIP-45) — recorded verbatim onto
   *  {@link SessionDescriptor.routeSelection} so live `setModel` can apply
   *  the same wire normalization as spawn. */
  routeSelection?: "free" | "derived-from-model"
  /** Manifest-declared provider (`authDescriptor.provider`) — recorded onto
   *  {@link SessionDescriptor.adapterProvider} so live `setModel` knows when
   *  to bare a direct `vendor/product` ref; ignored for derived adapters. */
  adapterProvider?: string
  /** Manifest-declared `authDescriptor.modelDerivedApiKey` — recorded onto
   *  {@link SessionDescriptor.modelDerivedApiKey} so live `setModel` applies
   *  the same router re-prefixing the spawn path used. */
  modelDerivedApiKey?: boolean
  /** Optional initial prompt to dispatch immediately. The promise
   *  the registry returns resolves AFTER the spawn — the prompt
   *  runs in the background, projecting events into the ring
   *  buffer. Skip to spawn idle. A plain string, or a content-block
   *  prompt (attachment-bearing first message) — see
   *  `SpawnAgentSessionInput.prompt`'s doc. */
  initialPrompt?: string | Record<string, unknown> | unknown[]
  /** The daemon-composed SYSTEM slice of {@link initialPrompt} — the part
   *  it synthesized ahead of the CALLER's ask (role disposition, lineage
   *  line, AGENTS.md, posture preamble). The adapter still receives the
   *  single concatenated `initialPrompt` unchanged; this metadata lets the
   *  daemon's OWN event stream record that slice as a `system-prompt` turn
   *  (ahead of the `user-prompt`) so UIs can fold it instead of rendering
   *  it as a user bubble. Absent ⇒ the whole `initialPrompt` is treated as
   *  user text (no synthesized preamble, e.g. a human reprompt). */
  initialPromptSystem?: string
  label?: string
  /** Correlation key of the work this session does: the task the session was
   *  spawned FOR. Recorded on {@link SessionDescriptor.taskId} so a relaunch
   *  naming the same task id resumes THIS session's last checkpoint (crash
   *  resume, see `checkpoint-resume.ts`). */
  taskId?: string
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
  /** Resolved skills list at spawn time (`resolveSpawnDefaults`'s merged
   *  explicit ∪ preset ∪ config-defaults result) — recorded verbatim onto
   *  {@link SessionDescriptor.skills}. See that field's doc. */
  skills?: string[]
  /** Resolved imported skills to deliver into the session's isolated config
   *  dir — recorded verbatim onto {@link SessionDescriptor.sessionSkills}. See
   *  that field's doc. */
  sessionSkills?: ResolvedSessionSkill[]
  /** Extra system-prompt text for this spawn — recorded verbatim onto
   *  {@link SessionDescriptor.appendSystemPrompt}. See that field's doc. */
  appendSystemPrompt?: string
  /** Capability bundle ids resolved for this spawn — recorded verbatim onto
   *  {@link SessionDescriptor.bundles}; see that field's doc. */
  bundles?: string[]
  /** Persistent isolated-config dir this spawn passed to
   *  `startSession({ configDir })` — recorded verbatim onto
   *  {@link SessionDescriptor.adapterConfigDir} so restart/lazy-resume can
   *  point the respawned adapter back at the SAME dir (where the provider's
   *  conversation store lives). See that field's doc. */
  adapterConfigDir?: string
  /** Spawning orchestrator's session id — set when the spawn arrived
   *  through the scoped sub-gateway (orchestrator WP4). Recorded on the
   *  descriptor for subtree scoping + quota accounting. */
  parentSessionId?: string
  /** A REMOTE parent (host relay): the descriptor records ONLY the
   *  non-secret part ({@link SessionDescriptor.remoteParent}); the relay
   *  TOKEN is kept in an in-memory map keyed by the session id (see
   *  `parent-relay.ts`'s `rememberRelayToken`), never on a descriptor and
   *  never on disk. Set by the box-side spawn that received a forwarded
   *  `remoteParent` block from the host. */
  remoteParent?: { sessionId: string; url: string; token: string }
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
  /** Opt-in auto-restart policy (restart-scheduler, PR-2), recorded verbatim
   *  onto {@link SessionDescriptor.restartPolicy}. Absent ⇒ today's
   *  lazy-resume-only behaviour. */
  restartPolicy?: RestartPolicy
  /** Opt-in turn-retry policy (`turn-retry.ts`), recorded verbatim onto
   *  {@link SessionDescriptor.turnRetry}. Absent ⇒ no automatic retry. */
  turnRetry?: TurnRetryPolicy
  /** The AGENT level of the AIP-68 clerk hook - recorded verbatim onto
   *  {@link SessionDescriptor.clerkHook}. Absent ⇒ this session contributes
   *  no agent level and the less specific level applies. */
  clerkHook?: Partial<ClerkHookConfig>
  /** Resolved context-continuity policy — recorded verbatim onto
   *  {@link SessionDescriptor.contextContinuity}. */
  contextContinuity?: ResolvedContextContinuityPolicy
  /** Best-effort usage reader, called on each turn-end to refresh the
   *  cost/token fields on the descriptor. Adapter-specific (e.g. hermes
   *  reads its state.db keyed by the adapter session id). Omit for adapters
   *  with no usage source. */
  readUsage?: () => Promise<import("./usage.js").UsageReadResult | null>
  /** Opt this session into Langfuse tracing (prompt/completion + tool spans +
   *  tokens/cost). Effective opt-in is `trace ?? opts.langfuseTracingDefault ?? false`. */
  trace?: boolean
  /** True when `agentSession` is a `SandboxAgentSessionProxy` (`agent_start.sandbox`)
   *  rather than a local subprocess-backed session — stamped onto the descriptor
   *  as `remote` since there's no local PID to report. */
  remote?: boolean
  /** Provider-assigned sandbox id, when `remote` is true. */
  sandboxId?: string
  /** Device-sandbox identity mapping (BOOTSTRAP P7a) — the HOST session id
   *  the device provider's inner `agent_start` created; stamped onto
   *  {@link SessionDescriptor.hostSessionId}. Omit for every non-device
   *  spawn (or when the host returned no usable id). */
  hostSessionId?: string
  /** Device-sandbox identity mapping (BOOTSTRAP P7a) — the paired host's
   *  fingerprint (or the raw `device:<…>` target when the provider couldn't
   *  resolve one); stamped onto {@link SessionDescriptor.hostFingerprint}. */
  hostFingerprint?: string
  /** Sandbox provider slug, when `remote` is true — see
   *  `SessionDescriptor.sandboxProvider`. */
  sandboxProvider?: string
  /** Non-secret sandbox config replayed on re-attach — see
   *  `SessionDescriptor.sandboxConfig`. */
  sandboxConfig?: Record<string, unknown>
  /** What session close does to the box, when `remote` is true — see
   *  `SessionDescriptor.sandboxTeardown`. */
  sandboxTeardown?: "kill" | "pause"
  /** The spec's idle-pause window — see `SessionDescriptor.sandboxPauseAfterIdleMs`. */
  sandboxPauseAfterIdleMs?: number
  /** The work branch inside the box — see `SessionDescriptor.sandboxDeliveryTarget`. */
  sandboxDeliveryTarget?: SandboxDeliveryTarget
  /** Per-spawn checkpoint override — see `SessionDescriptor.sandboxCheckpointOverride`. */
  sandboxCheckpointOverride?: SandboxCheckpointConfig | false
  /** Effective adapter confinement, resolved by the caller — see
   *  `SessionDescriptor.commandSandbox`. */
  commandSandbox?: "off" | "workspace" | "strict"
  /** Port-to-URL map from the booted sandbox — see
   *  `SessionDescriptor.sandboxPorts`. */
  sandboxPorts?: Record<number, string>
  /** WP3 — in-box app-serve echo (`agent_start.appServe`), recorded verbatim
   *  onto {@link SessionDescriptor.appServe}. See `sandbox-app-serve.ts`. */
  appServe?: SessionAppServeInfo
  /** True when the driver session was started in permission-hold mode
   *  (`AgentCliStartOptions.permissionHold`) — its `agent-prompt` events carry
   *  respondable permission requests. Gates whether the registry registers
   *  them in the pending-permissions inbox. Default false. */
  permissionHold?: boolean
  /** Recorded verbatim onto {@link SessionDescriptor.notifyParentOnCrash} —
   *  see that field's doc. Default false. */
  notifyParentOnCrash?: boolean
  /** Recorded verbatim onto {@link SessionDescriptor.sentinelAutoWatch} — see
   *  that field's doc. `undefined` = allowed. */
  sentinelAutoWatch?: boolean
  /** Exempt this session from the idle-reaper (`isReapable` in
   *  idle-reaper.ts) regardless of how long it sits idle — stamped straight
   *  onto `SessionDescriptor.keepAlive`. Default false. */
  keepAlive?: boolean
  /** Recorded verbatim onto {@link SessionDescriptor.worktreeAutoProvisioned}
   *  — see that field's doc. Set by `session-spawn.ts` from
   *  `WorktreeDecision.provision.implicit`. Default false. */
  worktreeAutoProvisioned?: boolean
}

/** `SpawnAgentInput` minus the fields that only exist once the driver's
 *  `startSession` has actually run — see `spawnAgentPending`'s doc for why
 *  everything else is safe to record up front. */
export type SpawnAgentPendingInput = Omit<
  SpawnAgentInput,
  "agentSession" | "commandPreview" | "resumable" | "nativeTerminalResume" | "initialPrompt"
> & {
  /** Invoked once when the placeholder reaches a terminal status (killed, or
   *  settled failed) while provisioning may still be in flight — the hook
   *  that aborts the provisioner so a killed spawn leaves no queued entry
   *  and no orphaned install. Never invoked after a successful settle. */
  onCancel?: () => void
}

/** The deferred outcome `settlePendingAgent` resolves a placeholder with —
 *  see that method's doc. */
export type PendingAgentOutcome =
  | {
      ok: true
      agentSession: AgentSessionLike
      /** The real cwd (the provisioned worktree, or unchanged when nothing
       *  needed isolating) — replaces the placeholder's best-known cwd. */
      cwd: string
      commandPreview?: string
      resumable?: boolean
      nativeTerminalResume?: boolean
      readUsage?: () => Promise<import("./usage.js").UsageReadResult | null>
      /** Dispatched now that the tree + driver session both exist — never
       *  passed to `spawnAgentPending`, which would race the tree. A plain
       *  string, or a content-block prompt (attachment-bearing first
       *  message) — see `SpawnAgentSessionInput.prompt`'s doc. */
      initialPrompt?: string | Record<string, unknown> | unknown[]
      /** The daemon-composed SYSTEM slice of `initialPrompt` (see
       *  `SpawnAgentInput.initialPromptSystem`) — threaded through the
       *  placeholder so the deferred dispatch records it as a system turn. */
      initialPromptSystem?: string
    }
  | {
      ok: false
      /** Short, readable — stamped verbatim onto `SessionDescriptor.lastError`. */
      message: string
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
  /** Detach the child into its own process group (node `spawn`'s
   *  `detached: true`). The child's pid is then the group's pgid, so a
   *  caller cleaning up a whole service tree can signal `-pid` — the
   *  app-service runner's kill primitive. Default false (same group as the
   *  daemon, as for every other registry spawn). */
  detached?: boolean
  /** Provenance stamped on the descriptor — lifecycle policy filters read
   *  this (`app-service:<appId>` for managed app-service processes). */
  origin?: string
  /** Exempt this session from the idle-reaper. Only load-bearing for
   *  `kind: "agent-cli"` rows (the reaper never reaps other kinds) but
   *  stamped verbatim for symmetric bookkeeping. */
  keepAlive?: boolean
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
  /** Env vars to strip from the inherited `process.env` before spawning —
   *  same scrub semantics as `ResolvedAuthSpec.unsetEnv` (define-agent-cli.ts's
   *  driver applies this by deleting from its own composed env; `spawnPty` has
   *  no such composition step of its own, so `session_restart`'s pty-native
   *  branch passes it here). Without this, a PTY resume that re-resolves the
   *  session's own billing auth still leaks whatever conflicting credential
   *  (e.g. an ambient `ANTHROPIC_API_KEY`) happens to be in the daemon's own
   *  `process.env` — `env` alone can only ADD/override keys, never remove
   *  one inherited from process.env. Applied AFTER `env` overrides so an
   *  explicit override always wins over a scrub of the same key. */
  unsetEnv?: string[]
  /** Desired human handle. Fed to `mintSlug` as the preferred base for the
   *  new session's {@link SessionDescriptor.slug} (ahead of `label`); the
   *  result is de-duplicated against every held session with `-2`, `-3`, …,
   *  so a collision never throws. Used by `findByIdOrName(query)`.
   *
   *  `slug` is the stronger form of the same preference: when set it is the
   *  handle to carry over (a restart forwards `getSlug(prev)` so the new row
   *  keeps the same addressable handle instead of re-minting from the
   *  no-longer-written `name`/`label`). Still normalized + de-duplicated by
   *  `mintSlug`, so it can never collide or throw. */
  slug?: string
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
  /** Pre-minted id (`mintSessionId()`), when the caller minted one BEFORE
   *  running the command so it could inject {@link SESSION_ID_ENV} into the
   *  child's own env — see `command-tools.ts`'s `command_execute` and
   *  `cron-scheduler.ts`'s command-action executor. Omitted ⇒ minted here,
   *  same as before this field existed (a command run some other way, with
   *  no env to inject into, e.g. tests). */
  id?: string
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
  /** True when the command was killed for exceeding its `timeoutMs` cap —
   *  mirrors `command-tools.ts`'s `ExecuteResult.timedOut`. */
  timedOut?: boolean
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
  /** Parent attribution + depth — same semantics as `SpawnPtyInput` /
   *  `SpawnAgentInput` (orchestrator WP4): set when the command ran
   *  through a scoped sub-gateway so `session_tree` shows the command
   *  session under its invoker. */
  parentSessionId?: string
  /** Recursion depth in the session tree — always recorded (`?? 0` when
   *  absent) so subtree/depth logic never has to special-case a missing
   *  value. Same semantics as `SpawnAgentInput.depth`. */
  depth?: number
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

/** `RecordOpenedPrInput.adapter` for PRs the reconciler merely saw MENTIONED
 *  in a session's output — provenance only, not proof the session created
 *  it, so sentinel auto-link skips it. */
export const OUTPUT_SCAN_ADAPTER = "output-scan"

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

/** Pure pinned-order assignment behind `registry.reorderPinned` — split out
 *  so the ordering is unit-testable without a registry. `pinned` is every
 *  currently-pinned descriptor (any order); `ids` is the requested new
 *  order. Listed ids get positions 0..n-1 in the given order; unlisted
 *  pinned sessions keep their relative order and are placed after, with
 *  legacy rows (no `pinnedOrder`) sorting by `startedAt` asc then id after
 *  every ordered row. The caller validates existence/pinnedness/duplicates
 *  and applies the returned map to the descriptors. */
export function computePinnedOrder(
  pinned: readonly SessionDescriptor[],
  ids: readonly string[],
): Map<string, number> {
  const order = new Map<string, number>()
  ids.forEach((id, i) => order.set(id, i))
  const unlisted = pinned
    .filter(s => !order.has(s.id))
    .sort((a, b) => {
      const ao = a.pinnedOrder ?? Number.POSITIVE_INFINITY
      const bo = b.pinnedOrder ?? Number.POSITIVE_INFINITY
      if (ao !== bo) return ao - bo
      if (Number.isFinite(ao)) return 0 // both ordered — stable sort keeps their relative order
      const byStart = a.startedAt.localeCompare(b.startedAt)
      return byStart !== 0 ? byStart : a.id.localeCompare(b.id)
    })
  unlisted.forEach((s, i) => order.set(s.id, ids.length + i))
  return order
}

/** The descriptor fields for a REMOTE parent (host relay), plus the side
 *  effect that keeps the relay TOKEN out of the descriptor entirely: the
 *  token is a secret, so it goes into an in-memory map keyed by the session
 *  id (see `parent-relay.ts`) and never onto a descriptor - and therefore
 *  never onto disk. */
function remoteParentFields(
  remoteParent: { sessionId: string; url: string; token: string } | undefined,
  sessionId: string,
): { remoteParent?: { sessionId: string; url: string } } {
  if (!remoteParent) return {}
  rememberRelayToken(sessionId, remoteParent.token)
  return { remoteParent: { sessionId: remoteParent.sessionId, url: remoteParent.url } }
}

export function createSessionsRegistry(opts?: {
  /** Liveness window for `external` sessions, ms. Default
   *  {@link DEFAULT_EXTERNAL_SESSION_LIVENESS_MS}. */
  externalSessionLivenessMs?: number
  /** Clock override (ms since epoch) for external-session liveness — tests. */
  externalNow?: () => number
  /** How long a queued prompt may wait before it is reported stuck
   *  (`pendingPrompts[].stale`, sender notice). Default
   *  {@link DEFAULT_PENDING_PROMPT_STALE_MS}; `sweepPendingPrompts({staleMs})`
   *  overrides it live (the daemon passes the hot `config.json` value). */
  pendingPromptStaleMs?: number
  /** Fires exactly once per NEWLY-recorded opened PR (AIP-60 §6/step 4
   *  sentinel auto-link) — every lane that calls `recordOpenedPr`
   *  (`command_execute`'s stamper, both `pr-provenance-reconciler.ts` lanes)
   *  funnels through this one hook. Best-effort from the registry's side —
   *  a throw here is caught and logged, never propagated. `desc` is the
   *  session's descriptor AFTER the PR was recorded. */
  onOpenedPr?: (sessionId: string, input: RecordOpenedPrInput, desc: SessionDescriptor) => void
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
  /** Hook the restart-scheduler's `"sandbox-gone"` policy drives: move a dead
   *  box session (its box is gone) to a FRESH box — the same
   *  `restartAgentSession` path `session_restart` takes. Wired by the gateway
   *  (index.ts) with the daemon's adapter/sandbox resolvers; omitted ⇒
   *  `triggerSandboxGoneRestart` consumes the schedule and stamps one
   *  `[sandbox-gone]` notice (the restart is blocked; no retry loop). Return
   *  `{ ok: true, newSessionId }` after the fresh descriptor was minted (the
   *  hook is also responsible for prompting it to continue the work), or
   *  `{ ok: false, blocker }` naming why the move cannot proceed. Throws are
   *  treated as a blocker with the error message. */
  restartSandboxGone?: (input: {
    sessionId: string
    prev: SessionDescriptor
  }) => Promise<{ ok: true; newSessionId: string } | { ok: false; blocker: string }>
  /** Hook a prompt to an IDLE-REAPED box session drives: the reap tore the box
   *  down (`daemon.sandboxIdleReapAfterMs`), so the row cannot revive in place —
   *  move it to a FRESH box (cold boot from the checkpoint branch, the same
   *  `restartAgentSession` path `session_restart` takes) WITHOUT a continuation
   *  prompt (the caller's own prompt is the continuation). Same contract as
   *  {@link restartSandboxGone}. Omitted ⇒ a reaped box row is not revived
   *  and the prompt fails with `session_not_alive`. */
  moveReapedBox?: (input: {
    sessionId: string
    prev: SessionDescriptor
  }) => Promise<{ ok: true; newSessionId: string } | { ok: false; blocker: string }>
  /** Default `restartPolicy` for a BOX spawn (`sandboxId` set) that carries
   *  NO explicit `restartPolicy` — the `daemon.sandboxGoneRestartDefault`
   *  opt-in, wired by the gateway as
   *  {@link SANDBOX_GONE_DEFAULT_RESTART_POLICY}. OFF unless set: omitted ⇒
   *  nothing changes and a policy-less spawn stays policy-less, exactly as
   *  before. An explicit `SpawnAgentInput.restartPolicy` always wins. */
  boxRestartPolicyDefault?: RestartPolicy
  /** When provided, the registry translates internal lifecycle transitions
   *  (turn-end, awaiting-input, exit) into SessionEvents on this bus. */
  sessionEvents?: SessionEventBus
  /** Override the structured-transcript base directory. Defaults to a
   *  `sessions` sibling of `persistPath` (`~/.agentproto/sessions` in
   *  production) — tests that already pin `persistPath` to a tmpdir get
   *  transcript isolation for free without also having to pass this. */
  transcriptDir?: string
  /** Configured on-disk retention defaults (`daemon.reviewSessionRetentionDays`
   *  / `daemon.sessionRetentionDays`) — what `pruneSessionDirs` uses for an
   *  option its caller leaves unset. Omitted ⇒ review lanes 7 days, others off. */
  sessionRetention?: { reviewMaxAgeDays?: number | null; maxAgeDays?: number | null }
  /** Shared, opt-in Langfuse session observer. Built once in the bootstrap
   *  from eval-reporter creds. Events only reach it for sessions in the
   *  registry's traced-session set — see `langfuseTracingDefault`. */
  langfuseTracer?: SessionObserver
  /** Default per-session tracing opt-in when `SpawnAgentInput.trace` is
   *  omitted. Defaults to false (tracing off). */
  langfuseTracingDefault?: boolean
  /**
   * Background-task wake (config `defaults.backgroundTaskWake`). When an
   * agent's background task settles while the session is idle, Claude Code
   * wakes the model itself (an autonomous task-notification cycle, which the
   * registry now tracks as a turn). If no such self-wake shows up within
   * `graceMs` (default {@link DEFAULT_BG_TASK_WAKE_GRACE_MS}), the registry
   * sends the wake prompt itself — so an agent that ended its turn "waiting
   * for the notification" is never left parked. `enabled` defaults to true.
   * A task that settles mid-turn is left to the agent (it gets the
   * notification in-turn); settles are coalesced into one wake.
   */
  backgroundTaskWake?: { enabled?: boolean; graceMs?: number }
  /** Adapter resolver used for context-continuity "continue fresh" spawns.
   *  When omitted, auto-continuation degrades to a hard-stop instead of
   *  spawning a replacement session. */
  resolveAgentAdapter?: AgentAdapterResolver
  /** Harness capability lister — the "which installed harness has usable
   *  credentials" signal behind handoff suggestions (the `handoff:<harness>`
   *  options of the `ask`-mode context question and the
   *  `session:handoff-suggested` event). Omitted → nothing is suggested. */
  listHarnessCapabilities?: AdapterCapabilitiesLister
  /** Proactive quota watch for `contextContinuity.handoffAtQuotaRemaining`:
   *  the reader + the profile resolver for the session's `accessProfile`.
   *  Omitted → the threshold is inert. */
  quotaWatch?: {
    reader: RemainingQuotaReader
    resolveProfile: (profileRef: string) => Promise<QuotaReadableProfile | undefined>
    /** Rolling window to read. Default "5h". */
    window?: string
    /** Minimum ms between two reads for one session. Default 5 min. */
    minIntervalMs?: number
  }
  /** Optional — best-effort exit-time worktree auto-reclaim, called from
   *  `emitExited` for a session whose `worktreeAutoProvisioned` flag is set
   *  (see that field's doc). Injected by the CLI over `@agentproto/worktree`;
   *  omitted → auto-reclaim is simply skipped, matching today's behaviour
   *  (manual/scheduled `gc` is still the only way an implicit worktree gets
   *  reclaimed). */
  runWorktreeAutoReclaim?: WorktreeAutoReclaimer
  /** Exit-time best-effort checkpoint reclaimer for SANDBOXED sessions:
   *  when such a session reaches a terminal status and the work it rescued
   *  onto `agentproto-checkpoint/<branch>` is provably elsewhere (PR merged
   *  or closed, content in base or the work branch), the ref is deleted
   *  from the workspace remote. Injected by the CLI over
   *  `@agentproto/worktree`; omitted → nothing is deleted here, and
   *  `agentproto sandbox checkpoint-gc` remains the manual tool. Never
   *  fails the session: a rejection is logged and swallowed. */
  runSandboxCheckpointGc?: SandboxCheckpointReclaimer
  /** Conversation-terminal link-probe cadence — how soon after spawn the
   *  first native-store discover runs, and how often it re-runs while the
   *  PTY is alive and unlinked. Tests pin tiny values; production default
   *  is `{ initialMs: 3_000, intervalMs: 15_000 }`. */
  conversationLinkProbeMs?: { initialMs: number; intervalMs: number }
  /** Override for the live-usage poll cadence (`USAGE_REFRESH_INTERVAL_MS`,
   *  root default 5s). Tests pin a small value so `armUsageRefresh`'s polling
   *  can be observed in guest time. */
  usageRefreshIntervalMs?: number
  /** How long the context rescue waits, after its auto-compaction turn, for
   *  the usage reading to drop under `hardStopAtPct` before falling back to
   *  continue-fresh / stop. Default 30s. */
  contextRescueSettleMs?: number
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
  const restartSandboxGoneHook = opts?.restartSandboxGone
  const moveReapedBoxHook = opts?.moveReapedBox
  const boxRestartPolicyDefault = opts?.boxRestartPolicyDefault
  /** The `restartPolicy` a spawn lands on its descriptor with: the caller's
   *  own policy when given (always wins), else — a BOX spawn with
   *  `daemon.sandboxGoneRestartDefault` on — the sandbox-gone default.
   *  Absent ⇒ undefined, i.e. today's policy-less spawn, unchanged. */
  const effectiveRestartPolicy = (
    input: { restartPolicy?: RestartPolicy; sandboxId?: string },
  ): RestartPolicy | undefined =>
    input.restartPolicy ??
    (boxRestartPolicyDefault !== undefined && input.sandboxId !== undefined
      ? boxRestartPolicyDefault
      : undefined)
  const sessionEvents = opts?.sessionEvents
  const resolveAgentAdapter = opts?.resolveAgentAdapter
  const runWorktreeAutoReclaim = opts?.runWorktreeAutoReclaim
  const runSandboxCheckpointGc = opts?.runSandboxCheckpointGc
  const sessions = new Map<string, SessionRuntime>()
  const externalLivenessMs =
    typeof opts?.externalSessionLivenessMs === "number" && opts.externalSessionLivenessMs > 0
      ? opts.externalSessionLivenessMs
      : DEFAULT_EXTERNAL_SESSION_LIVENESS_MS
  const externalNowMs = opts?.externalNow ?? Date.now
  /** Lazily expire an `external` row whose last sighting fell out of the
   *  liveness window: there is no process whose exit could flip it, so every
   *  read/deliver path calls this first. Terminal status carries no
   *  `endedReason` (nothing killed it) — a later sighting revives it. */
  const expireExternalIfStale = (rt: SessionRuntime): void => {
    const desc = rt.desc
    if (desc.kind !== "external" || (desc.status !== "running" && desc.status !== "starting")) return
    const seen = Date.parse(desc.lastSeenAt ?? desc.startedAt)
    if (Number.isFinite(seen) && externalNowMs() - seen <= externalLivenessMs) return
    desc.status = "exited"
    desc.endedAt = Number.isFinite(seen) ? new Date(seen).toISOString() : new Date(externalNowMs()).toISOString()
  }
  /** Unique per registry instance (= per daemon boot) — see
   *  `SessionsRegistry.bootId`. Minted before the boot reload so it can stamp
   *  `interruptedAtBoot`. */
  const bootId = `boot_${new Date().toISOString()}_${randomUUID().slice(0, 8)}`
  /** Stamp the fields callers use for a quick status read. These are kept off
   *  disk because phase and elapsed time are meaningful only against the live
   *  runtime and current clock. */
  const stampCurrentStatus = (rt: SessionRuntime): void => {
    const desc = rt.desc
    desc.toolCallsThisTurn = rt.toolCallsThisTurn ?? 0
    desc.eventsPath = sessionEventsPath(desc.id, transcriptBaseDir)

    if (desc.lastActivityAt) {
      const lastActivityMs = Date.parse(desc.lastActivityAt)
      if (Number.isFinite(lastActivityMs)) {
        desc.secondsSinceLastActivity = Math.floor(
          (Date.now() - lastActivityMs) / 1_000,
        )
      } else {
        delete desc.secondsSinceLastActivity
      }
    } else {
      delete desc.secondsSinceLastActivity
    }

    if (desc.status === "killed") {
      desc.currentPhase = "killed"
      return
    }
    if (desc.status === "exited" || desc.status === "error") {
      desc.currentPhase = "completed"
      return
    }
    if (desc.awaitingPermission) {
      desc.currentPhase = "awaiting-permission"
      return
    }
    if (desc.awaitingInput) {
      desc.currentPhase = "awaiting-input"
      return
    }
    const activeToolNames = rt.activeToolCalls
      ? Array.from(rt.activeToolCalls.values())
      : []
    const activeToolName = activeToolNames.at(-1)
    if (activeToolName) {
      desc.currentPhase = `tool-call:${activeToolName}`
      return
    }
    desc.currentPhase = desc.busy ? "thinking" : "idle"
  }
  // Ephemeral per-session waiter counter (#session-visibility) — how many live
  // supervisors are blocked on this id via `monitorSessionWait`. Kept off the
  // persisted SessionRuntime rows (a waiter can't survive a restart) and
  // stamped onto the descriptor at read time, like `processAlive`.
  const watchersById = new Map<string, number>()
  /** Per-waiter detail behind `watchersById`'s count (#session-visibility) —
   *  see {@link SessionWatcherInfo}. Kept as a parallel map rather than
   *  folding the count into `.length` so a caller that never passes `detail`
   *  (an anonymous waiter) still counts without needing a placeholder entry. */
  const watcherDetailsById = new Map<string, SessionWatcherInfo[]>()
  /** Stamp the live waiter count + detail onto a descriptor at read time
   *  (mirrors `stampProcessAlive`). 0/empty when nothing is waiting — both
   *  fields are always set so a reader can tell "no watchers" from "field
   *  unsupported". A shallow copy so a caller can't mutate the live list. */
  let pendingPromptStaleMs = opts?.pendingPromptStaleMs ?? DEFAULT_PENDING_PROMPT_STALE_MS
  /** Read-time `pendingPrompts` projection (age + stale flag) of the queue. */
  const stampPendingPrompts = (desc: SessionDescriptor): void => {
    if (desc.promptQueue?.length) {
      desc.pendingPrompts = pendingPromptViews(desc.promptQueue, Date.now(), pendingPromptStaleMs)
    } else {
      delete desc.pendingPrompts
    }
  }
  const stampWatchers = (desc: SessionDescriptor): void => {
    desc.watchers = watchersById.get(desc.id) ?? 0
    desc.watcherDetails = [...(watcherDetailsById.get(desc.id) ?? [])]
  }
  /** Read-time subtree rollup (#session-visibility): for every session, how
   *  many of its descendants (via `parentSessionId`) are currently mid-turn.
   *  Computed by walking each busy session's ancestor chain and crediting each
   *  ancestor — O(n · depth), with a per-walk cycle guard. A descendant counts
   *  only while genuinely mid-turn (busy AND alive), so a stale busy flag on a
   *  killed child doesn't make a parent look like it's still delegating. */
  const childrenBusyCounts = (): Map<string, number> => {
    const all = Array.from(sessions.values())
    const parentOf = new Map<string, string | undefined>(all.map(s => [s.desc.id, s.desc.parentSessionId]))
    const counts = new Map<string, number>()
    for (const s of all) {
      const d = s.desc
      const midTurn = d.busy === true && (d.status === "running" || d.status === "starting")
      if (!midTurn) continue
      const seen = new Set<string>([d.id])
      let pid = d.parentSessionId
      while (pid && !seen.has(pid)) {
        seen.add(pid)
        counts.set(pid, (counts.get(pid) ?? 0) + 1)
        pid = parentOf.get(pid)
      }
    }
    return counts
  }
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
  // In-flight best-effort per-session writes fired fire-and-forget
  // (`recordCommand`'s CommandLogEntry → ToolCallRecord chain, and the
  // transcript-stream closes `forget()`/`shutdown()` start). Tracked only
  // so `settlePendingWrites()` can await them settling. A live daemon never
  // needs this — nothing removes `transcriptBaseDir` under it — but a caller
  // that tears that dir down right after the write was kicked off (tests do)
  // races the write: its `mkdir(recursive)` re-creates a dir the removal
  // just emptied (→ ENOTEMPTY on the parent rmdir) or its `appendFile` hits a
  // dir already removed (→ ENOENT). Draining first makes that deterministic.
  const pendingWrites = new Set<Promise<void>>()
  function trackWrite(p: Promise<unknown>): void {
    // Swallow inside the tracked promise (the underlying writers already
    // `.catch` and log) so `settlePendingWrites` never rejects, and self-
    // remove on settle so the set only ever holds genuinely in-flight work.
    const tracked = p.then(
      () => {},
      () => {},
    ).finally(() => {
      pendingWrites.delete(tracked)
    })
    pendingWrites.add(tracked)
  }

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
  // Boot-time bookkeeping for sandbox sessions the previous daemon process
  // detached (or died holding) — see `loadHistorySnapshot` and the
  // `finishSandboxReattach` registry method.
  const reattachBoot = { detachedAtBoot: 0, reattached: 0, gone: 0, failed: 0, unserved: 0 }
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
          transcriptBaseDir,
          slug,
          sourceBucketOf,
          heldIdsByBucket,
          bootId,
          reattachBoot,
        )
      }
    } else {
      loadHistorySnapshot(
        legacyPath,
        sessions,
        sessionEvents,
        transcriptBaseDir,
        undefined,
        undefined,
        undefined,
        bootId,
        reattachBoot,
      )
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

  // PARENT RELAY (host side): the grants this daemon minted for its box
  // sessions persist next to the registry's own state (token HASHES only,
  // see `parent-relay.ts`), so a host daemon restart does not turn every
  // live box's relay into `relay_token_unknown`. The liveness probe lets the
  // periodic sweep renew a grant while both its sessions are live and revoke
  // it once either is dead. Detached again by `shutdown()`.
  const detachParentRelayStore = persist
    ? attachParentRelayStore({
        dir: dirname(legacyPath),
        liveness: id => {
          const rt = sessions.get(id)
          if (!rt) return "unknown"
          return rt.desc.status === "running" || rt.desc.status === "starting" ? "live" : "dead"
        },
      })
    : undefined

  // Record (or refresh) the derived outcome of an ended agent-cli session —
  // see `SessionDescriptor.outcome`. Idempotent via `shouldReplaceOutcome`,
  // so every terminal path can call it without coordinating. The summary
  // falls back to the one already recorded: a ghost row (no live buffer)
  // refreshed by a late PR must not lose it.
  const recordOutcome = (rt: SessionRuntime): void => {
    if (rt.desc.kind !== "agent-cli") return
    if (rt.desc.status === "running" || rt.desc.status === "starting") return
    // Pinned session artifacts ride the outcome as `type: "file"` refs —
    // best-effort: a store read failure (e.g. a corrupt ledger line) must
    // never block recording the rest of the outcome.
    let pinnedArtifacts: import("./session-outcome.js").SessionOutcomeArtifact[] = []
    try {
      pinnedArtifacts = listSessionArtifactsImpl(rt.desc.id, transcriptBaseDir)
        .filter(a => a.pinned)
        .map(a => ({ type: "file" as const, ref: a.key, title: a.label ?? a.key }))
    } catch {
      // Ignore — see comment above.
    }
    const next = deriveSessionOutcome(rt.desc, {
      lastAssistantText: rt.lastAssistantText ?? rt.desc.outcome?.summary,
      ...(pinnedArtifacts.length > 0 ? { artifacts: pinnedArtifacts } : {}),
    })
    if (!shouldReplaceOutcome(rt.desc.outcome, next)) return
    rt.desc.outcome = next
    schedulePersist()
  }

  // "Mark as completed" (UI affordance): an operator saying
  // reason:"operator-completed" about a row that's ALREADY terminal isn't an
  // error — `kill()` relabels the persisted outcome's `termination.reason`
  // in place rather than refusing the call. Idempotent: the true original
  // mechanism is captured in `termination.previousReason` on the FIRST call
  // only, so relabeling twice never overwrites it with "operator-completed"
  // itself. Never touches `desc.endedReason` — that stays the ground truth
  // for HOW the row actually died; only the outcome's operator-facing label
  // changes.
  const markOutcomeCompleted = (rt: SessionRuntime): void => {
    const existing =
      rt.desc.outcome ??
      deriveSessionOutcome(rt.desc, { lastAssistantText: rt.lastAssistantText })
    const previousReason =
      existing.termination.reason === "operator-completed"
        ? existing.termination.previousReason
        : existing.termination.reason
    rt.desc.outcome = {
      ...existing,
      termination: {
        ...existing.termination,
        reason: "operator-completed",
        ...(previousReason ? { previousReason } : {}),
      },
      recordedAt: new Date().toISOString(),
    }
    schedulePersist()
  }

  // Layer a declared Level-2 outcome (verdict + structured detail) on the
  // row's existing outcome — the shared tail of a manual stop and of a
  // steward label on an already-ended row. Keeps the derived summary /
  // artifacts / cost / termination under the declared fields.
  const layerDeclaredOutcome = (rt: SessionRuntime, outcome: StopOutcomeInput): void => {
    const base = rt.desc.outcome ?? deriveSessionOutcome(rt.desc, { lastAssistantText: rt.lastAssistantText })
    const detail = sanitizeOutcomeDetail({ ...outcome, by: outcome.by ?? "user" })
    const note = trimOutcomeText(outcome.note, OUTCOME_SUMMARY_MAX, "head")
    rt.desc.outcome = {
      ...base,
      source: "declared",
      ...(outcome.verdict ? { verdict: outcome.verdict } : {}),
      ...(outcome.judgedBy !== undefined ? { judgedBy: outcome.judgedBy } : {}),
      ...(note ? { note } : {}),
      ...detail,
      recordedAt: new Date().toISOString(),
    }
    schedulePersist()
  }

  // Layer a Level-2 (judged/declared) resolution onto the row's outcome —
  // the shared tail of `closeWithOutcome` (live) and `resolveOutcome`
  // (already-terminal), so both write the SAME fields with the same
  // "merge on top of what deriveSessionOutcome computed" shape as
  // `markOutcomeCompleted`: the derived summary/artifacts/cost survive
  // under the judged/declared verdict. Assumes the caller has already
  // decided this row is eligible.
  const layerStewardOutcome = (rt: SessionRuntime, input: CloseWithOutcomeInput): void => {
    const base = rt.desc.outcome ?? deriveSessionOutcome(rt.desc, { lastAssistantText: rt.lastAssistantText })
    rt.desc.outcome = {
      ...base,
      source: input.source,
      verdict: input.verdict,
      ...(input.summary !== undefined
        ? { summary: trimOutcomeText(input.summary, OUTCOME_SUMMARY_MAX, "tail") }
        : {}),
      ...(input.judgedBy !== undefined ? { judgedBy: input.judgedBy } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...sanitizeOutcomeDetail(input),
      recordedAt: new Date().toISOString(),
    }
    schedulePersist()
  }

  // Emit session:exited once per session, deduplicated via exitedEmitted flag.
  const emitExited = (rt: SessionRuntime): void => {
    if (rt.exitedEmitted) return
    // PARENT RELAY: this session is over, so it must not be able to report
    // up to its host parent any more. Revoke the grants the host minted for
    // it (the grant names this row as its box session) and forget this row's
    // own outgoing relay token. Runs from the ONE exit funnel every
    // terminal path funnels through (clean exit, kill, crash, idle-reap).
    // The same funnel also covers a PARENT that ends: its children's grants
    // have nobody left to deliver to, so they are revoked as well.
    revokeParentRelayGrantsForSession(rt.desc.id)
    forgetRelayToken(rt.desc.id)
    // Terminal means provisioning is over, one way or another: drop the
    // progress field, and abort whatever provisioning may still be queued or
    // running for this row (its queue entry is dropped, its child tree
    // killed). Once-only via the hook clearing itself.
    delete rt.desc.provisioning
    const cancelProvision = rt.provisionCancel
    if (cancelProvision) {
      rt.provisionCancel = undefined
      try {
        cancelProvision()
      } catch {
        // A cancel hook must never break the exit funnel.
      }
    }
    // The one exit funnel every terminal path goes through — derive what
    // the session produced before anything announces its death, so a
    // `session:exited` consumer reading the descriptor already sees it.
    recordOutcome(rt)
    // Refresh the sidecar now: an exit is a terminal state, so its index
    // must land regardless of the throttled turn-end writes.
    writeIndexNow(rt)
    // A dead PTY has no transcript left to discover — stop its link probe.
    rt.linkProbeStop?.()
    // A dying session must never leave a held permission RPC dangling — cancel
    // its parked requests (resolves them as `cancelled`) before anything else.
    // Runs even when no bus is wired, so the driver RPC always settles.
    cancelPendingPermissionsForSession(rt)
    // Exit-time worktree auto-reclaim (best-effort, fire-and-forget, never
    // blocks or throws past this point) — see `SessionDescriptor.
    // worktreeAutoProvisioned`'s doc. Runs from this ONE shared exit point,
    // which every terminal path funnels through (clean exit, kill, crash,
    // idle-reap, a failed async provision), since the actual data-safety
    // gating lives entirely in the reclaimer's own classify (clean tree,
    // merged/fresh, idle) — an exit that left real uncommitted work simply
    // doesn't reclaim, regardless of why it exited. The flag is cleared
    // immediately so a session whose `emitExited` runs more than once (e.g.
    // no `sessionEvents` bus wired, so the dedup guard above never latches)
    // never attempts a second reclaim.
    if (runWorktreeAutoReclaim && rt.desc.worktreeAutoProvisioned && rt.desc.worktreePath) {
      const worktreePath = rt.desc.worktreePath
      rt.desc.worktreeAutoProvisioned = false
      try {
        void runWorktreeAutoReclaim(worktreePath).catch(err => {
          console.error(
            `[worktree-auto-reclaim] best-effort reclaim of ${worktreePath} failed ` +
              `(session ${rt.desc.id}): ${err instanceof Error ? err.message : String(err)}`,
          )
        })
      } catch (err) {
        console.error(
          `[worktree-auto-reclaim] best-effort reclaim of ${worktreePath} threw synchronously ` +
            `(session ${rt.desc.id}): ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    // Exit-time sandbox checkpoint gc (best-effort, fire-and-forget, same
    // funnel shape as the auto-reclaim above): a terminal sandboxed session
    // whose checkpoint branch is provably superseded (PR merged/closed, or
    // the snapshot's content already in base or the work branch) deletes
    // that ref from the workspace remote. The gating lives in the
    // reclaimer's own classify; absent port or absent work branch = no-op.
    if (runSandboxCheckpointGc && rt.desc.kind === "agent-cli" && rt.desc.sandboxDeliveryTarget?.branch) {
      const branch = rt.desc.sandboxDeliveryTarget.branch
      const input = { cwd: rt.desc.cwd, branch }
      try {
        void runSandboxCheckpointGc(input).catch(err => {
          console.error(
            `[sandbox-checkpoint-gc] best-effort reclaim of ${branch} failed ` +
              `(session ${rt.desc.id}): ${err instanceof Error ? err.message : String(err)}`,
          )
        })
      } catch (err) {
        console.error(
          `[sandbox-checkpoint-gc] best-effort reclaim of ${branch} threw synchronously ` +
            `(session ${rt.desc.id}): ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
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

  // Clear a row's `stalledSinceMs` flag the instant any activity disproves
  // the stall claim — shared by `pulseActivity` (new adapter traffic), turn
  // start, and the turn's own `finally` (busy flips false), and by the
  // `clearStalled` registry method itself. No-ops (no persist, no event)
  // when the row wasn't flagged, so recovery is silent for the overwhelming
  // majority of turns that were never stalled in the first place.
  const clearStalledFlag = (rt: SessionRuntime): void => {
    if (rt.desc.stalledSinceMs === undefined) return
    rt.desc.stalledSinceMs = undefined
    schedulePersist()
    sessionEvents?.emit({
      type: "session:stall-cleared",
      sessionId: rt.desc.id,
      ...(rt.desc.label ? { label: rt.desc.label } : {}),
      ts: new Date().toISOString(),
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
      ...(evt._meta !== undefined ? { _meta: evt._meta } : {}),
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
      // Durable counterpart to the "agent-prompt" this resolves — without
      // it the book view's structured log never learns the ask was
      // answered and shows it as pending forever (see transcript-writer.ts's
      // "permission-resolved" case).
      transcriptWriter.recordEvent(rt.desc.id, {
        kind: "permission-resolved",
        toolCallId: id,
        decision: "cancelled",
      })
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
    // Free-text feedback rides on the optionId resolution — the acp client
    // forwards it on the ACP outcome's `_meta` (agentproto/feedback). A
    // cancelled resolution has nothing to attach it to.
    const resolution: { optionId: string; feedback?: string } | { cancelled: true } =
      "optionId" in selected
        ? { optionId: selected.optionId, ...(input.feedback ? { feedback: input.feedback } : {}) }
        : selected
    const okResolved = await respond(id, resolution)
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
    // Durable counterpart to the "agent-prompt" this resolves — see
    // cancelPendingPermissionsForSession's identical call for why.
    transcriptWriter.recordEvent(pending.sessionId, {
      kind: "permission-resolved",
      toolCallId: id,
      decision: input.decision,
      ...(chosenOptionId ? { optionId: chosenOptionId } : {}),
    })
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
    // agent-cli sessions as before, PLUS conversation terminals (a native
    // provider TUI in a PTY — claude/hermes/…): those hold a real provider
    // conversation too, discovered by the link probe / exit-hint sniffer
    // below. Plain shells and command rows still never get an index row.
    const isConvTerminal = desc.kind === "terminal" && isConversationTerminal(desc)
    if (desc.kind !== "agent-cli" && !isConvTerminal) return
    // A bare native launch (argv ["claude"]) may have no stamped
    // adapterSlug — derive it from the same classifier table.
    const adapterSlug =
      desc.adapterSlug ?? (isConvTerminal ? conversationTerminalSlugFor(desc) : undefined)
    const adapterSessionId = adapterSessionIdOverride ?? desc.adapterSessionId
    const cwd = desc.cwd
    if (!adapterSlug || !adapterSessionId || !cwd) return
    void (async () => {
      try {
        const native = await resolveNativeLink({
          cwd,
          adapterSlug,
          adapterSessionId,
          // Config-dir-isolated session (#824): the native transcript lives
          // under the session's own CLAUDE_CONFIG_DIR, not ~/.claude.
          ...(desc.adapterConfigDir ? { adapterConfigDir: desc.adapterConfigDir } : {}),
        })
        const registered = readRegisteredSlugs(workspacesConfigPath)
        const slug = resolveBucketSlug(desc.workspaceSlug, registered)
        const record: ConversationIndexRecord = {
          sessionId: desc.id,
          workspace: slug,
          cwd,
          adapterSlug,
          adapterSessionId,
          ...(desc.adapterConfigDir ? { adapterConfigDir: desc.adapterConfigDir } : {}),
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

  /** A revival (restart / lazy fork) mints a NEW descriptor for the SAME
   *  conversation. `resumedFrom` alone is invisible to list/tree consumers,
   *  so every revival also records `continuedFrom` — the field the session
   *  list, tree and UI group by — and back-links `continuedTo` on the prior
   *  row (see {@link linkContinuedTo}). */
  const resumeLineage = (
    resumedFrom: string | undefined,
  ): { resumedFrom?: string; continuedFrom?: string; continuationGeneration?: number } => {
    if (!resumedFrom) return {}
    // The revived row is ONE more hop of the same lineage: prev's own
    // generation + 1 (prev without a stamp counts as a base row, gen 0 → 1).
    // Keeping the count here means a later `session_continue_fresh` of the
    // revived row continues the chain instead of resetting to 1.
    // The prior generation is read from the in-memory `sessions` map ONLY:
    // persisted rows are rehydrated into it at startup, so a predecessor is
    // normally resident. A predecessor that is NOT in the map (forgotten, or
    // never loaded) reads as gen 0, so that one revival restarts at 1.
    const prevGen = sessions.get(resumedFrom)?.desc.continuationGeneration
    return {
      resumedFrom,
      continuedFrom: resumedFrom,
      continuationGeneration: (prevGen ?? 0) + 1,
    }
  }

  const retiredListeners = new Set<(ev: SessionRetiredEvent) => void>()

  /** Stamp a row retired (see `isRetired`) and tell the cleanup listeners.
   *  `killed` also stamps `retiredAt` (the only retirement signal a row that
   *  had already ended can carry); archive/forget/continue are already carried
   *  by `archived` / the row's absence / `continuedTo`. */
  const retireRow = (rt: SessionRuntime, cause: SessionRetiredCause, continuedTo?: string): void => {
    if (continuedTo) rt.desc.continuedTo = continuedTo
    if (cause === "killed" && rt.desc.retiredAt === undefined) {
      rt.desc.retiredAt = new Date().toISOString()
    }
    // A retired session's AGENT.md is no longer worth watching — stop the
    // opt-in hot-role-refresh watch, if any (never leaked across retirement).
    stopAgentRoleWatch(rt.desc.id)
    // PARENT RELAY: an archived / forgotten / retired row (box session or
    // parent) never takes part in a relay again - revoke its grants (the
    // exit funnel already did for a row that ended; this covers a retire
    // that did not go through it).
    revokeParentRelayGrantsForSession(rt.desc.id)
    schedulePersist()
    const ev: SessionRetiredEvent = {
      sessionId: rt.desc.id,
      cause,
      ...(rt.desc.continuedTo ? { continuedTo: rt.desc.continuedTo } : {}),
    }
    for (const listener of retiredListeners) {
      try {
        listener(ev)
      } catch {
        // A cleanup listener must never break the retirement itself.
      }
    }
  }

  const linkContinuedTo = (resumedFrom: string | undefined, newId: string): void => {
    if (!resumedFrom || resumedFrom === newId) return
    const prevRt = sessions.get(resumedFrom)
    if (prevRt) retireRow(prevRt, "continued", newId)
  }

  const schedulePersist = (): void => {
    if (!persist || shutdownDone) return
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      void persistSnapshot()
    }, PERSIST_DEBOUNCE_MS)
  }

  // ── Per-session index sidecar (sessions find / session_recap) ─────────
  // A compact `<sessionsDir>/<id>/index.json` kept best-effort and throttled.
  // Turn-end schedules a trailing write (never one per streaming frame);
  // spawn/rename/exit write immediately. A failed index write is swallowed
  // and can never fail a session write. See `session-index.ts`.
  const INDEX_WRITE_THROTTLE_MS = 400
  const dirtyIndexIds = new Set<string>()
  let indexFlushTimer: ReturnType<typeof setTimeout> | undefined

  /** The transcript-derived slice of an entry: prefer the live in-memory
   *  buffers (a turn's just-finished output may not have hit the debounced
   *  transcript writer yet), fall back to a bounded tail read only when a
   *  field is missing (a row loaded from history, a rename of an old row). */
  const captureIndexTail = (
    rt: SessionRuntime,
  ): { lastUserPrompt?: TranscriptPrompt; lastOutputText?: string } => {
    let lastUserPrompt = rt.lastUserPrompt
    let lastOutputText = rt.lastAssistantText
    if (lastUserPrompt === undefined || lastOutputText === undefined) {
      const tail = readTranscriptTail(sessionEventsPath(rt.desc.id, transcriptBaseDir), INDEX_TAIL_BYTES)
      if (lastUserPrompt === undefined && tail.prompts.length > 0) {
        lastUserPrompt = tail.prompts[tail.prompts.length - 1]
      }
      if (lastOutputText === undefined) lastOutputText = tail.lastOutputText
    }
    return {
      ...(lastUserPrompt ? { lastUserPrompt } : {}),
      ...(lastOutputText ? { lastOutputText } : {}),
    }
  }

  const writeIndexNow = (rt: SessionRuntime): void => {
    try {
      writeSessionIndex(indexEntryFromDescriptor(rt.desc, captureIndexTail(rt)), transcriptBaseDir)
    } catch {
      // best-effort — an index write must never fail a session write
    }
  }

  /** True when any held session already carries `candidate` as its handle
   *  (`getSlug` — slug, or legacy name). `exceptId` excludes one session so a
   *  row's own legacy `name` never blocks minting its replacement `slug`
   *  during backfill. */
  const isSlugTaken = (candidate: string, exceptId?: string): boolean => {
    for (const rt of sessions.values()) {
      if (rt.desc.id === exceptId) continue
      if (getSlug(rt.desc) === candidate) return true
    }
    return false
  }

  /** Lazy slug backfill (session-addressing PLAN §4 WP-B1). A descriptor
   *  restored from `sessions.json` before `slug` existed (or one whose slug
   *  was somehow dropped) gets one minted here, from the same frozen
   *  derivation `spawnAgent`/`spawnPty` use. Idempotent by construction: a
   *  row that already has a non-empty `slug` is left untouched, so a user
   *  override (or a prior boot's mint) is never rewritten. Rows minted in one
   *  pass are visible to the next (they're written straight onto `sessions`),
   *  so two restored rows with the same title land `x` and `x-2`. Persists via
   *  the ordinary debounced snapshot (sessions.json) — the per-session
   *  `index.json` sidecar has no `slug` field, so there is nothing to refresh
   *  there and this deliberately does not pay for a synchronous index write
   *  (with its transcript-tail read) per restored row at boot. */
  const backfillMissingSlugs = (): void => {
    let changed = false
    for (const rt of sessions.values()) {
      const desc = rt.desc
      if (desc.slug !== undefined && desc.slug !== "") continue
      desc.slug = mintSlug(
        // Prefer a legacy row's existing `name` handle so backfill keeps the
        // address a human already knows, rather than deriving a new one.
        desc.name || desc.title || desc.label || desc.adapterSlug || desc.kind,
        candidate => isSlugTaken(candidate, desc.id),
        desc.id,
      )
      changed = true
    }
    if (changed) schedulePersist()
  }

  backfillMissingSlugs()

  const flushDirtyIndexes = (): void => {
    if (indexFlushTimer) {
      clearTimeout(indexFlushTimer)
      indexFlushTimer = undefined
    }
    if (dirtyIndexIds.size === 0) return
    const ids = [...dirtyIndexIds]
    dirtyIndexIds.clear()
    for (const id of ids) {
      const rt = sessions.get(id)
      if (rt) writeIndexNow(rt)
    }
  }

  const scheduleIndexWrite = (rt: SessionRuntime): void => {
    if (shutdownDone) return
    dirtyIndexIds.add(rt.desc.id)
    if (indexFlushTimer) return
    indexFlushTimer = setTimeout(() => {
      indexFlushTimer = undefined
      flushDirtyIndexes()
    }, INDEX_WRITE_THROTTLE_MS)
    indexFlushTimer.unref?.()
  }

  /**
   * Conversation-terminal link probe. A fresh native launch (argv
   * `["claude"]`, no `CLAUDE_CONFIG_DIR` threaded) writes its transcript to
   * the provider's GLOBAL store — there is no id to record until the
   * provider creates the file. This probe watches for it: first shortly
   * after spawn, then on a debounced interval while the PTY is alive and
   * unlinked (never per output byte). Exact-bind discipline mirrors the
   * fs-probe's: exactly ONE fresh transcript since `startedAt` in this cwd
   * binds; several ⇒ record nothing and mark `linkStatus: "ambiguous"` —
   * never bind a sibling. On a bind it records `adapterSessionId` +
   * `resumeMetadata[storeAs]`, derives the title ONCE from the transcript's
   * own first user message (the discover candidate's `preview` — the
   * existing scanner, no second parser), and writes the conversations.jsonl
   * link. Adapters with a launch entry but no conversation store yet
   * (grok) are classify-only: no probe, title stays the spawn label.
   */
  const conversationLinkProbeMs = opts?.conversationLinkProbeMs ?? {
    initialMs: 3_000,
    intervalMs: 15_000,
  }
  const startConversationTerminalLinkProbe = (rt: SessionRuntime): void => {
    const desc = rt.desc
    const slug = desc.adapterSlug ?? conversationTerminalSlugFor(desc)
    const store = slug ? CONVERSATION_STORES[slug] : undefined
    const cwd = desc.cwd
    if (!store || !cwd) return
    let inFlight = false
    let stopped = false
    const timers: Array<ReturnType<typeof setTimeout>> = []
    const stop = (): void => {
      stopped = true
      for (const t of timers) clearTimeout(t)
      timers.length = 0
    }
    rt.linkProbeStop = stop
    const tick = async (): Promise<void> => {
      if (stopped || inFlight) return
      if (desc.status !== "running") {
        stop()
        return
      }
      // Wait for the provider to have SAID anything before hitting the fs.
      if (!desc.lastOutputAt) return
      if (desc.adapterSessionId) {
        stop()
        return
      }
      inFlight = true
      try {
        const candidates = await store.discover({
          cwd,
          since: desc.startedAt,
          // A PTY writes through the provider's native arm, never ACP.
          attachmentMode: "native",
          // No configDir on purpose: nothing threaded CLAUDE_CONFIG_DIR
          // into this PTY, so the global store is where the file is.
        })
        if (candidates.length === 1) {
          const candidate = candidates[0]!
          desc.adapterSessionId = candidate.conversationId
          desc.resumeMetadata = {
            ...(desc.resumeMetadata ?? {}),
            [store.storeAs]: candidate.conversationId,
          }
          delete desc.linkStatus
          if (!desc.title && candidate.preview) {
            const derived = deriveSessionTitle(candidate.preview)
            if (derived) desc.title = derived
          }
          schedulePersist()
          recordConversationLink(rt, candidate.conversationId)
          stop()
        } else if (candidates.length > 1) {
          desc.linkStatus = "ambiguous"
          schedulePersist()
        }
      } catch {
        // Best-effort, like every other conversation-index write point.
      } finally {
        inFlight = false
      }
    }
    const schedule = (delayMs: number): void => {
      if (stopped) return
      const t = setTimeout(() => {
        void tick().finally(() => schedule(conversationLinkProbeMs.intervalMs))
      }, delayMs)
      t.unref?.()
      // Only one pending timer at a time — drop the fired one's handle.
      timers.length = 0
      timers.push(t)
    }
    schedule(conversationLinkProbeMs.initialMs)
  }

  /** Descriptors as they go to disk. Read-time projections are stripped so a
   *  restored descriptor is never seen with a stale value before the next
   *  list()/get() recomputes it.
   *
   *  The remote parent's relay TOKEN is stripped too (belt and braces: the
   *  descriptor never carries it in the first place - see
   *  `remoteParentFields`), so a secret can never reach `sessions.json`. */
  const snapshotRows = (): SessionDescriptor[] =>
    Array.from(sessions.values()).map(s => {
      const {
        processAlive: _processAlive,
        interrupted: _interrupted,
        currentPhase: _currentPhase,
        secondsSinceLastActivity: _secondsSinceLastActivity,
        toolCallsThisTurn: _toolCallsThisTurn,
        eventsPath: _eventsPath,
        availableModes: _availableModes,
        spawnEnforcedPostures: _spawnEnforcedPostures,
        configOptions: _configOptions,
        ...rest
      } = s.desc
      if (rest.remoteParent) {
        const { token: _token, ...remoteParent } = rest.remoteParent as {
          sessionId: string
          url: string
          token?: string
        }
        rest.remoteParent = remoteParent
      }
      // A live provider-box session keeps its re-attach record on disk, so a
      // daemon that dies without a graceful shutdown (crash, SIGKILL) still
      // leaves the next boot something to reattach with. The cursor can be
      // stale — a reattach then replays a little duplicated tail rather than
      // losing events.
      if ((s.desc.status === "running" || s.desc.status === "starting") && s.agentSession?.detachRecord) {
        const rec = s.agentSession.detachRecord()
        if (rec) {
          return {
            ...rest,
            sandboxReattach: { ...rec, ...(rest.sandboxReattach?.detachedAt ? { detachedAt: rest.sandboxReattach.detachedAt } : {}) },
          }
        }
      }
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

  const persistOnce = async (): Promise<void> => {
    try {
      // The sync flush in `shutdownImpl` is the FINAL word on disk. Any
      // async round still alive past that point is working from a
      // registry that `shutdownImpl` has since cleared (or is about to),
      // and its writes would land after the flush — the 2026-08-14
      // evening wipe: a child killed at shutdown re-armed the debounce
      // timer, and the round it fired wrote `sessions: []` over every
      // bucket. Checked per bucket, not just at entry, so a round that
      // was mid-loop when shutdown started stops writing immediately.
      if (shutdownDone) return
      const savedAt = new Date().toISOString()
      if (partitioned) {
        for (const [slug, rows] of groupRowsByBucket()) {
          if (shutdownDone) return
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

  // Serialize persist rounds. `schedulePersist` debounces only the START
  // of a round — under churn a new debounce timer fires while the
  // previous (async, multi-await) round is still writing, and the two
  // rounds then interleave writes to the same bucket files. With the
  // old shared tmp path that interleaving truncated snapshots (the
  // 2026-08-14 registry wipe); with unique tmp names it "only" wastes
  // writes and can land an older round's rename after a newer one's.
  // One round in flight at a time, with a single coalesced re-run for
  // every request that arrived mid-round, removes the overlap entirely.
  let persistRunning = false
  let persistRerun = false
  const persistSnapshot = async (): Promise<void> => {
    if (shutdownDone) return
    if (persistRunning) {
      persistRerun = true
      return
    }
    persistRunning = true
    try {
      do {
        persistRerun = false
        await persistOnce()
        // A rerun coalesced before shutdown must not execute after it:
        // `shutdownImpl` runs synchronously between this round's awaits,
        // clears the sessions Map, and a post-clear `groupRowsByBucket()`
        // would persist that emptiness verbatim into every boot-loaded
        // bucket (same wipe as the timer path — see `persistOnce`).
      } while (persistRerun && !shutdownDone)
    } finally {
      persistRunning = false
    }
  }

  const appendLine = (
    rt: SessionRuntime,
    line: string,
    stream: "stdout" | "stderr"
  ): void => {
    // A line-count cap alone allows 500 multi-megabyte tool-result lines.
    // Keep a bounded replay preview; observers and the durable transcript
    // still receive the original event. Copy a truncated suffix through a
    // Buffer so V8 cannot keep the entire large parent string via a slice.
    const preview = line.length > RECENT_LINE_CHARS_CAP
      ? `[output preview truncated] ${Buffer.from(line.slice(-RECENT_LINE_CHARS_CAP), "utf8").toString("utf8")}`
      : line
    rt.recentLines.push(preview)
    rt.recentLinesChars = (rt.recentLinesChars ?? 0) + preview.length
    while (rt.recentLines.length > RECENT_LINES_CAP || rt.recentLinesChars > RECENT_LINES_CHARS_CAP) {
      rt.recentLinesChars -= rt.recentLines.shift()!.length
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
    // agent-cli lines as before, plus conversation-terminal PTY lines
    // (fed by `sniffConversationTerminalChunk`) — a native TUI prints the
    // same `claude --resume <uuid>` hint on graceful exit, and dropping it
    // used to lose the PTY's only conversation handle.
    if (rt.desc.kind !== "agent-cli" && rt.conversationTerminal !== true) return
    const strategySlug = rt.desc.adapterSlug ?? conversationTerminalSlugFor(rt.desc)
    const strategy = strategySlug ? RESUME_STRATEGIES[strategySlug] : undefined
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
  /**
   * Line-assembly shim between a conversation terminal's raw byte stream
   * and `sniffResumeHints` (which matches per COMPLETE line). Carries a
   * partial trailing line across chunks; capped so an alt-screen redraw
   * that never emits a newline can't grow it unboundedly. Only called for
   * `rt.conversationTerminal` rows — plain shells skip it entirely.
   */
  const sniffConversationTerminalChunk = (rt: SessionRuntime, chunk: Buffer): void => {
    const text = (rt.sniffCarry ?? "") + chunk.toString("utf8")
    const lines = text.split(/\r?\n|\r/)
    rt.sniffCarry = (lines.pop() ?? "").slice(-4096)
    for (const line of lines) {
      if (line) sniffResumeHints(rt, line)
    }
  }

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
    if (rt.conversationTerminal === true) sniffConversationTerminalChunk(rt, chunk)
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

  /** Record one tool-call announcement in the live phase state. ACP may emit
   *  later enrichment events for the same id; those refresh the name/order but
   *  do not increment the per-turn count. */
  const trackToolCall = (rt: SessionRuntime, evt: AgentStreamEvent): void => {
    if (!rt.activeToolCalls) rt.activeToolCalls = new Map()
    if (!rt.toolCallIdsThisTurn) rt.toolCallIdsThisTurn = new Set()

    let key: string
    if (evt.toolCallId) {
      key = evt.toolCallId
      if (!rt.toolCallIdsThisTurn.has(key)) {
        rt.toolCallIdsThisTurn.add(key)
        rt.toolCallsThisTurn = (rt.toolCallsThisTurn ?? 0) + 1
      }
    } else if (evt.isUpdate && rt.activeToolCalls.size > 0) {
      key = Array.from(rt.activeToolCalls.keys()).at(-1)!
    } else {
      rt.toolCallsThisTurn = (rt.toolCallsThisTurn ?? 0) + 1
      key = `anonymous:${rt.toolCallsThisTurn}`
    }

    const toolName = evt.toolName ?? rt.activeToolCalls.get(key) ?? "unknown"
    // Re-insert so the most recently announced/enriched active call is the
    // phase shown when calls overlap.
    rt.activeToolCalls.delete(key)
    rt.activeToolCalls.set(key, toolName)
  }

  const resolveToolCall = (rt: SessionRuntime, toolCallId?: string): void => {
    if (!rt.activeToolCalls || rt.activeToolCalls.size === 0) return
    if (toolCallId) {
      rt.activeToolCalls.delete(toolCallId)
      return
    }
    const latest = Array.from(rt.activeToolCalls.keys()).at(-1)
    if (latest) rt.activeToolCalls.delete(latest)
  }

  /**
   * Project ACP-style stream events into ring-buffer lines. Keeps
   * the line shape simple so the existing /stream SSE consumer
   * (and the xterm panel) just renders them as-is.
   */
  /**
   * Rewrite a `usage_update`'s `size` to the session's effective window
   * (see `context-window.ts`) BEFORE it's recorded, so events.jsonl and every
   * live consumer of the stream (session UIs, the VS Code transcript, SSE)
   * see the same corrected figure the descriptor holds, instead of each
   * re-deriving occupancy from the adapter's inferred size. The adapter's own
   * value is kept as `reportedSize` whenever it differs.
   */
  const normalizeUsageFrame = (rt: SessionRuntime, evt: AgentStreamEvent): AgentStreamEvent => {
    const size = foldUsageFrameWindow(rt.desc, evt, rt.desc.activeModel ?? rt.desc.model)
    if (size === undefined || typeof evt.size !== "number" || evt.size <= 0 || size === evt.size) {
      return evt
    }
    return { ...evt, size, reportedSize: evt.size }
  }

  const projectEvent = (rt: SessionRuntime, evt: AgentStreamEvent): void => {
    switch (evt.kind) {
      case "text-delta":
        // Assistant text means the model has the floor again, so it cannot
        // still be waiting on the tool that blocked it — the result landed
        // (whether or not the adapter bothered to emit one; several don't).
        // This is the catch-all behind the explicit releases below.
        releaseBlockedOn(rt.desc)
        rt.activeToolCalls?.clear()
        if (evt.text) {
          const prior = rt.lastAssistantTextSealed ? "" : (rt.lastAssistantText ?? "")
          const text = prior + evt.text
          rt.lastAssistantText =
            text.length > LAST_ASSISTANT_TEXT_CAP ? text.slice(text.length - LAST_ASSISTANT_TEXT_CAP) : text
          rt.lastAssistantTextSealed = false
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
        // Thinking means the model has the floor again, just like assistant
        // text, even when an adapter omitted the preceding tool-result.
        rt.activeToolCalls?.clear()
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
        trackToolCall(rt, evt)
        rt.lastAssistantTextSealed = true
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
        resolveToolCall(rt, evt.toolCallId)
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
        // Artifact-ledger passthrough: the CI delivery helper
        // (`deliver-artifact.mjs`) prints `::agentproto-artifact::{…}` to a
        // tool's stdout so the agentproto-run driver can harvest created
        // PR/review/comment ids back out of `agent_output` — the one-line
        // summary above would otherwise destroy the marker ("N lines, XB")
        // and the provenance stamp degrades to sha-discovery every time.
        // Re-emit marker lines verbatim under a `[tool-artifact]` prefix:
        // clean mode still strips them from human-facing output (the
        // `[tool…` filter in `cleanAgentLines`), while the raw ring keeps
        // them harvestable. NO ANSI styling — the harvester JSON-parses the
        // line's tail, and a trailing reset code would corrupt it.
        for (const marker of artifactMarkerLines(evt.result)) {
          appendLine(rt, `[tool-artifact] ${marker}`, "stdout")
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
        rt.activeToolCalls?.clear()
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
        rt.activeToolCalls?.clear()
        const errorMessage = evt.error?.message
          ? tagLimitErrorWithWallet(evt.error.message, rt.desc.accessProfile)
          : undefined
        if (errorMessage) rt.lastErrorMessage = errorMessage
        const code =
          typeof evt.error?.code === "number" ? ` (code ${evt.error.code})` : ""
        appendLine(
          rt,
          `\x1b[31m[error]${code} ${errorMessage ?? "unknown"}\x1b[0m`,
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
      case "notice": {
        // Daemon-synthesized banners are written straight to the transcript
        // (`transcriptWriter.recordEvent`, never through `send()`), so no
        // adapter reaches this case — the only producer is the sandbox proxy
        // forwarding a HOST session's notice. Render it so a device spawn's
        // surfaced host-side error line lands in `agent_output` too, not just
        // `agent_export`. Not assistant text, so the empty-turn
        // classification is unaffected.
        if (evt.text) {
          for (const line of evt.text.split(/\r?\n/)) {
            if (line.trim()) appendLine(rt, `\x1b[2m[notice] ${line}\x1b[0m`, "stderr")
          }
        }
        break
      }
      case "plan": {
        const entries = evt.entries ?? []
        const done = entries.filter(e => e.status === "completed").length
        const label = evt.title ? `[plan] ${evt.title} ${done}/${entries.length}` : `[plan] ${done}/${entries.length}`
        appendLine(
          rt,
          `\x1b[35m${label} ${entries.map(e => e.content).join("; ")}\x1b[0m`,
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
        // Not "latest frame wins": an adapter's in-turn frames can carry an
        // INFERRED window (claude-agent-acp guesses 200k for a bare 1M model
        // id until its first result) — `foldUsageFrameWindow` keeps a
        // cost-bearing frame's size sticky and prefers the catalog over a
        // guess. Idempotent, so the frame already normalized by
        // `normalizeUsageFrame` folds to the same state here.
        foldUsageFrameWindow(rt.desc, evt, rt.desc.activeModel ?? rt.desc.model)
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
          rt.contextUsedInconsistent = used === undefined
        }
        if (evt.cost) {
          rt.desc.costUsd = evt.cost.amount
          rt.adapterReportedCost = true
        }
        if (typeof evt.tokensIn === "number") rt.desc.tokensIn = evt.tokensIn
        if (typeof evt.tokensOut === "number") rt.desc.tokensOut = evt.tokensOut
        // ── Running-cost estimate (best-effort, live) ────────────────
        // In-turn frames are frequently COST-LESS: claude-code's `used`-only
        // occupancy frames stream the whole turn, opencode's live arm never
        // carries a cost block (its cost/tokens arrive via the turn-end
        // readUsage hook), and hermes only prices at its own reader — so a
        // busy session's row showed NO cost at all until the first
        // adapter-priced signal at turn-end. While NO authoritative cost has
        // ever arrived (`adapterReportedCost` false — a cost-bearing frame
        // above, or the turn-end reader, flips it), price the latest
        // cumulative token count the frame carries against the in-repo
        // catalog and surface that as a running estimate tagged
        // `source: "computed"`. The moment an authoritative cost lands it
        // REPLACES this estimate (never adds to it) — `adapterReportedCost`
        // gates this branch off and the adapter branch above already
        // overwrote `costUsd`, so there is no double counting window.
        //
        // Token basis, per frame shape: explicit cumulative tokensIn/tokensOut
        // when the adapter reports them; otherwise `used`. For claude-code
        // `used` is tokens-in-context (a LOWER bound on consumed input — each
        // API call re-charges its context prefix), so the estimate reads low,
        // not high — the right direction for a "best-effort running" figure.
        // An unpriced model yields nothing (`no-pricing`), never a cost.
        if (!rt.adapterReportedCost) {
          // The model this usage belongs to: the frame's own report first
          // (claude-agent-acp names it in `_meta["_claude/model"]`), then the
          // session's active/spawned model.
          const model =
            (typeof evt.model === "string" && evt.model.length > 0 ? evt.model : undefined) ??
            rt.desc.activeModel ??
            rt.desc.model
          const usage = deriveSessionUsage({
            ...(model !== undefined ? { model } : {}),
            ...(typeof evt.tokensIn === "number" ? { tokensIn: evt.tokensIn } : {}),
            ...(typeof evt.tokensOut === "number" ? { tokensOut: evt.tokensOut } : {}),
            ...(typeof evt.tokensIn !== "number" &&
            typeof evt.tokensOut !== "number" &&
            typeof evt.used === "number" &&
            evt.used > 0
              ? { tokensIn: evt.used }
              : {}),
          })
          if (
            usage.source === "computed" &&
            usage.costUsd !== undefined &&
            // A reader's real token split (applyUsageRead) is the better
            // estimate; don't let a `used`-only frame overwrite it.
            (!rt.readerReportedTokens ||
              typeof evt.tokensIn === "number" ||
              typeof evt.tokensOut === "number")
          ) {
            rt.desc.costUsd = usage.costUsd
            rt.desc.usageSource = "computed"
          }
        }
        break
      }
      // Mirror the latest command list onto the descriptor, same as
      // usage_update above — read-only state for session_list/GET /sessions,
      // no ring-buffer line (this isn't turn output, it's capability
      // metadata that changes rarely and isn't part of the conversation).
      case "available-commands":
        rt.desc.availableCommands = evt.commands ?? []
        break
      case "background-task":
        noteBackgroundTask(rt, evt)
        break
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
  const validateAgentTurn = (
    id: string,
    caller: string,
    admit?: { compaction?: boolean },
  ): SessionRuntime => {
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
    // A flag left by an earlier daemon on a session that is still alive is
    // stale: the rescue below acts on the live reading instead.
    if (rt.desc.contextContinuityHardStopped) {
      delete rt.desc.contextContinuityHardStopped
      schedulePersist()
    }
    // Context floor: never admit a prompt into a window the policy calls
    // full — and never leave the session stuck behind it either: start the
    // rescue (auto-compact) and tell the caller to retry. A compaction prompt
    // is the way out, so it is always admitted.
    if (!admit?.compaction) {
      if (rt.contextRescue) {
        throw new Error(`${caller}: session "${id}" ${CONTEXT_RESCUE_BUSY_MESSAGE}`)
      }
      const pct = computeContextPct(rt.desc.contextSize, rt.desc.contextUsed)
      if (
        pct !== null &&
        !rt.contextUsedInconsistent &&
        rt.desc.contextContinuity &&
        isContextContinuityHardStopped(pct, rt.desc.contextContinuity)
      ) {
        void performContextRescue(rt, pct)
        throw new Error(`${caller}: session "${id}" ${CONTEXT_RESCUE_BUSY_MESSAGE} (context at ${pct}%)`)
      }
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
   * `caller` shapes error messages and the transcript notice; every entry
   * point reaches the same logic, so a message naming the wrong one would
   * misdirect debugging.
   *
   * Marks the turn as daemon-interrupted (`rt.interruptRequested`) so its
   * `finally` holds `promptQueue` instead of draining it — pass
   * `deliverQueueId` to drain exactly that item. Also writes a `notice`
   * into the session's events log: an adapter-side `cancelled` turn-end
   * is otherwise indistinguishable from the agent stopping on its own.
   */
  const interruptInFlightTurn = async (
    rt: SessionRuntime,
    id: string,
    caller: string,
    deliverQueueId?: string,
    deliveryOrigin?: string
  ): Promise<void> => {
    // A bare stop means stop: a delivery notice armed by an earlier
    // interrupt whose prompt never ran must not ride on the next turn.
    if (deliveryOrigin === undefined) rt.pendingInterruptNotice = undefined
    // An autonomous turn has no `session/prompt` to cancel (cancelling with
    // none in flight would mark the adapter's session cancelled and swallow
    // the NEXT prompt's result). Close the daemon-side turn; the agent folds
    // the incoming prompt into the cycle it is running.
    if (rt.autonomousTurn) {
      endAutonomousTurn(rt, "cancelled")
      autonomousReopenHoldUntil.set(rt.desc.id, Date.now() + AUTONOMOUS_REOPEN_HOLD_MS)
      return
    }
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
    if (rt.busy) {
      rt.interruptRequested = { by: caller, ...(deliverQueueId ? { deliverQueueId } : {}) }
      if (deliveryOrigin !== undefined) {
        rt.pendingInterruptNotice = interruptDeliveryNotice(deliveryOrigin)
      }
      const held = (rt.desc.promptQueue ?? []).filter(p => p.id !== deliverQueueId).length
      const banner =
        `── turn interrupted by ${INTERRUPT_CALLER_LABELS[caller] ?? caller}` +
        (held > 0
          ? `; ${held} queued prompt(s) held until the next turn ends on its own ──`
          : " ──")
      appendLine(rt, banner, "stdout")
      transcriptWriter.recordEvent(rt.desc.id, { kind: "notice", text: banner })
    }
    try {
      await session.cancel()
    } catch (err) {
      // Nothing was cancelled — the turn will end on its own, so its
      // `finally` must drain the queue as usual.
      rt.interruptRequested = undefined
      rt.pendingInterruptNotice = undefined
      throw new Error(
        `${caller}: session "${id}" does not support interrupt — cancelling the in-flight turn failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
    await waitForTurnSettled(rt, id, caller)
  }

  /**
   * Drain one item off `SessionDescriptor.promptQueue` — called at the
   * very end of `runAgentTurn`'s finally, so this runs after EVERY turn,
   * normal or abnormal. Re-validates via `validateAgentTurn` before
   * dispatching (a queued item may have sat through a crash/restart): a
   * session that's no longer alive drops the item with a logged
   * `[error]` line instead of dispatching into a dead connection. Fire-
   * and-forget, same shape as `enqueuePrompt`'s own dispatch — nothing
   * is awaiting this. Recurses through `runAgentTurn`'s own finally on
   * the turn it fires, so a burst of N queued prompts drains one at a
   * time, in order, without unbounded call-stack growth (each dispatch
   * is a fresh microtask via the `void (async () => ...)()` below, not
   * a direct recursive call).
   *
   * `onlyId` dispatches that item instead of the head (deliver-now).
   * No-op while another turn is already running — a prompt admitted during
   * the ending turn's awaited `finally` took the slot, and ITS `finally`
   * drains next. Slicing the item off here anyway would only have it
   * rejected as mid-turn and dropped.
   */
  const dispatchQueuedPrompt = (rt: SessionRuntime, onlyId?: string): void => {
    const queue = rt.desc.promptQueue
    if (!queue?.length || rt.busy || rt.steerInFlight || rt.contextRescue) return
    const next = onlyId ? queue.find(p => p.id === onlyId) : queue[0]
    if (!next) return
    // A typed message at the head drains together with every envelope item
    // queued right behind it — one turn, N sibling tags — but a plain
    // prompt always stops the run: a message batch and a human prompt are
    // never one turn.
    const batch: QueuedPrompt[] = [next]
    if (next.envelope && !onlyId) {
      for (const item of queue.slice(1)) {
        if (!item.envelope) break
        batch.push(item)
      }
    }
    rt.desc.promptQueue = queue.filter(p => !batch.includes(p))
    schedulePersist()
    void (async () => {
      try {
        await maybeResumeAgent(rt, "daemon-restart", next.source ? { source: next.source } : {})
        const liveRt = validateAgentTurn(rt.desc.id, "queue-drain", { compaction: isCompactPrompt(next.message) })
        if (next.envelope) {
          await runMessageTurn(
            liveRt,
            batch.map(p => p.envelope!),
            "turn",
            next.source,
          )
          return
        }
        const answer = isChildPromptSource(next.source)
          ? undefined
          : matchStructuredQuestionAnswer(liveRt, next.message)
        if (answer) {
          await answerStructuredQuestion(liveRt, answer)
          return
        }
        await runAgentTurn(
          liveRt,
          next.message,
          next.source ? { promptSource: next.source } : undefined
        )
      } catch (err) {
        appendLine(
          rt,
          `[error] queued prompt dropped — ${err instanceof Error ? err.message : String(err)}`,
          "stderr"
        )
      }
    })()
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
   *
   * `resumedFrom` (default `"daemon-restart"`, the lazy/eager prompt-path
   * value) is what the emitted `session:resumed` event's `resumedFrom` field
   * carries — the restart-scheduler's `triggerResume` passes `"restarted"`
   * so a proactive crash/error restart isn't misreported as a daemon-restart
   * revival.
   */
  /** A reaped row whose BOX is gone and must be cold-booted again: killed by
   *  the idle reaper, ran in a provider box, and not already superseded. */
  const isReapedBoxRow = (desc: SessionDescriptor): boolean =>
    desc.status === "killed" &&
    desc.endedReason === "idle-reaped" &&
    isProviderBoxSession(desc) &&
    desc.archived !== true &&
    desc.continuedTo === undefined

  /** Prompt-time revival of an idle-reaped box session: move it to a fresh box
   *  (once, however many prompts race) and return the successor id the prompt
   *  must be delivered to. `undefined` ⇒ not a reaped box row / no hook wired —
   *  the caller carries on with its normal path. A failed move throws, loudly:
   *  falling through to the local in-place resume would start the adapter on
   *  the HOST against a path that only exists inside the dead box. */
  const needsReapedBoxMove = (rt: SessionRuntime): boolean =>
    rt.reapedBoxMove !== undefined ||
    (moveReapedBoxHook !== undefined && !rt.agentSession && isReapedBoxRow(rt.desc))

  const moveReapedBoxIfNeeded = async (rt: SessionRuntime): Promise<string | undefined> => {
    if (rt.reapedBoxMove) return rt.reapedBoxMove
    if (!needsReapedBoxMove(rt) || !moveReapedBoxHook) return undefined
    const id = rt.desc.id
    const move = (async () => {
      // Let the reap's own teardown (final checkpoint + delivery) finish first.
      await rt.reapTeardown
      delete rt.reapTeardown
      let outcome: Awaited<ReturnType<typeof moveReapedBoxHook>>
      try {
        outcome = await moveReapedBoxHook({ sessionId: id, prev: rt.desc })
      } catch (err) {
        outcome = { ok: false, blocker: err instanceof Error ? err.message : String(err) }
      }
      if (!outcome.ok) {
        const text =
          `[idle-reaped] cannot move this session to a fresh box: ${outcome.blocker} — ` +
          "fix the cause and `session_restart` it manually."
        appendLine(rt, text, "stderr")
        transcriptWriter.recordEvent(id, { kind: "notice", text })
        schedulePersist()
        throw new Error(`session "${id}" was idle-reaped and could not be moved to a fresh box: ${outcome.blocker}`)
      }
      return outcome.newSessionId
    })()
    rt.reapedBoxMove = move
    try {
      return await move
    } finally {
      // Keep the settled promise only while a racing prompt may still hold it;
      // the old row is superseded (`continuedTo`) after a successful move, so
      // later prompts take the standard `session_superseded` path.
      if (rt.reapedBoxMove === move) delete rt.reapedBoxMove
    }
  }

  const maybeResumeAgent = async (
    rt: SessionRuntime,
    resumedFrom: "daemon-restart" | "restarted" = "daemon-restart",
    intent: { source?: string; force?: boolean } = {},
  ): Promise<void> => {
    // A RETIRED dead row is never revived by an automated path, and never by
    // anyone once it has a successor (`session_superseded`) — unless the
    // caller explicitly forces it. Checked FIRST so a stale `kill()` binding
    // can't mask it behind a generic "not alive".
    if (rt.desc.status !== "running" && rt.desc.status !== "starting") {
      if (!intent.force && isRetired(rt.desc)) {
        const { continuedTo } = rt.desc
        if (continuedTo || isAutomatedPromptSource(intent.source)) {
          throw new SessionRetiredError(rt.desc.id, rt.desc.status, "maybeResumeAgent", continuedTo)
        }
      }
    }
    if (rt.agentSession) {
      // A bound session is normally proof of life — but a bound session whose
      // TRANSPORT is provably dead is the exact shape this whole path used to
      // be blind to: `rt.agentSession` set, `status: "running"`, and every
      // prompt rejecting "ACP connection closed" into the void. Reconcile it
      // here, at the choke point every prompt path (sendPrompt, enqueuePrompt,
      // queue drain) already funnels through, so the very next prompt revives
      // the session instead of dispatching into a dead socket.
      //
      // Normally the push watcher (`bindAgentSession`) has already done this
      // within microseconds of the close; this is the backstop for a session
      // whose adapter exposes no `onDisconnect` subscription, and the reason a
      // prompt never has to wait up to a sweep interval to find out.
      //
      // `markCrashedInternal` clears the binding, so control falls through to
      // the resume below. If it refuses (the row is already terminal), the
      // binding stays and we return — `validateAgentTurn` then raises
      // `SessionNotAliveError`, a clear error rather than a silent drop.
      if (rt.agentSession.isConnected?.() === false) {
        markCrashedInternal(rt.desc.id, "transport-closed")
      }
      if (rt.agentSession) return
    }
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
          // AIP-66 cloud: the cloud adapter resumes the VENDOR's own session
          // id, learned onto `meta.cloud.sessionId` — prefer it over the ACP
          // uuid (which is not the vendor id). resolveCloudResumeId also
          // falls back to the relay's meta file inside this row's own config
          // dir when the descriptor never learned the id (the spawn-time
          // watch died with a daemon restart), stamping it back through
          // mergeMeta. A row with neither source falls back to
          // `adapterSessionId` and fails closed at the vendor if that isn't
          // resolvable there.
          resumeSessionId:
            (await resolveCloudResumeId(rt.desc, cloud =>
              registry.mergeMeta(rt.desc.id, { cloud: encodeCloudSessionMeta(cloud) }),
            )) ?? adapterSessionId,
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
        bindAgentSession(rt, fresh)
        bindOutOfTurnEvents(rt)
        stampCapabilities(rt)
        rt.adapterSlug = adapterSlug
        rt.desc.adapterSessionId = fresh.sessionId
        // The resumed session is a fresh child process — refresh pid so
        // `processAlive` reflects the new process, not the dead one that
        // triggered this resume.
        rt.desc.pid = fresh.pid ?? null
        if (rt.desc.status !== "running") {
          rt.desc.status = "running"
          // An explicit revival lifts a deliberate retirement — otherwise the
          // row would read as retired while alive.
          delete rt.desc.retiredAt
          if (rt.desc.endedReason && DELIBERATE_END_REASONS.has(rt.desc.endedReason)) {
            delete rt.desc.endedReason
          }
          delete rt.desc.endedAt
          delete rt.desc.exitCode
          // Alive again — the next death records its own outcome.
          delete rt.desc.outcome
          rt.emitter.emit("status", rt.desc.status)
        }
        // `emitExited` is a once-per-`rt`-lifetime latch (dedup via
        // `exitedEmitted`) — without clearing it here, a session that
        // crashes, resumes, then crashes AGAIN would never re-emit
        // `session:exited` for the second death (the in-memory `rt` object
        // survives the resume), silently breaking any consumer — including
        // the restart-scheduler — that relies on that event firing once per
        // death. A successful resume proves this session has a fresh death
        // to report next time.
        rt.exitedEmitted = false
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
        // Symmetric honesty banner (resume-honesty fix): this adapter declared
        // `capabilities.resumable: false` (hermes, mastra-agent, …) — the
        // in-place revival got a live process back, but it CANNOT rehydrate
        // the prior conversation from `adapterSessionId`, so what just came
        // back is a blank session wearing the old id, not a continuation.
        // Announced exactly as loudly as the interrupted-turn banner below so
        // a lazily-revived unresumable session never looks like a silent,
        // empty continuation. `resumable !== false` (true/unknown — every
        // adapter this fix doesn't touch, including claude-code) stays silent.
        const contextNotRestored = rt.desc.resumable === false
        // Fix D: this is an in-place revival — same session id, same
        // `events.jsonl` — so that file's own pre-death content IS the prior
        // conversation to summarize. Read here, BEFORE either banner below is
        // written into that same file — `transcriptWriter.recordEvent`'s
        // write and this read are two independent stream handles on one
        // path, so building the digest AFTER a banner write raced that
        // write's buffered, asynchronous flush: read late and the banner's
        // own "notice" text could be read back as if it were prior
        // conversation, injecting a bogus digest into a session with no real
        // transcript at all — the source of the CI flake reddening PR
        // #721/#724. Best-effort: stashed for `runAgentTurn` to inject once;
        // absent when there's nothing to summarize (see
        // `buildResumeContextDigest`).
        let digestRecovered = false
        if (contextNotRestored) {
          const result = await buildResumeContextDigest(rt.desc.id)
          if (result.digest) {
            rt.desc.pendingResumeContext = result.digest
            digestRecovered = result.hasContent
          }
        }
        if (interrupted) {
          const banner =
            "── resumed after daemon restart; previous turn was interrupted " +
            "and was NOT re-run — re-prompt to continue ──"
          appendLine(rt, banner, "stdout")
          transcriptWriter.recordEvent(rt.desc.id, { kind: "notice", text: banner })
        }
        if (contextNotRestored) {
          const banner = digestRecovered
            ? `── resumed WITH PARTIAL context — adapter '${adapterSlug}' ` +
              "does not support resume; context was recovered from the daemon " +
              "transcript, not the adapter's native conversation ──"
            : `── resumed WITHOUT prior context — adapter '${adapterSlug}' ` +
              "does not support resume, this is a fresh session, not a " +
              "continuation ──"
          appendLine(rt, banner, "stdout")
          transcriptWriter.recordEvent(rt.desc.id, { kind: "notice", text: banner })
        }
        sessionEvents?.emit({
          type: "session:resumed",
          sessionId: rt.desc.id,
          interrupted,
          resumedFrom,
          ...(contextNotRestored ? { contextRestored: false } : {}),
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
   * The crash-mark ACTION, shared by the `markCrashed` registry method (the
   * crash-detect sweep's entry point) and the push-based transport watcher
   * below. See `SessionsRegistry.markCrashed` for the full contract.
   *
   * The `status !== "running"` guard is doing double duty. For the sweep
   * it's idempotence. For the transport watcher it's the entire "was this
   * death expected?" test: `kill()` and `reapIdle()` both flip `status`
   * BEFORE closing the adapter connection, so the disconnect their own
   * teardown triggers arrives here and is correctly refused as a no-op —
   * only a connection that died while the row still believed it was running
   * is a crash.
   */
  const markCrashedInternal = (
    id: string,
    reason: SessionCrashReason = "process-gone",
  ): boolean => {
    const rt = sessions.get(id)
    if (!rt) return false
    // Only a LIVE agent-cli row can be marked crashed — same guard as
    // reapIdle, kept honest for any caller regardless of what the sweep
    // already filtered for.
    if (rt.desc.kind !== "agent-cli" || rt.desc.status !== "running") {
      return false
    }
    const pid = rt.desc.pid
    // A recent driver-reported usage-cap error (Claude Code's "hit your
    // session limit" et al) explains the process going away far better
    // than a generic "crashed" — the crash-detect sweep only ever
    // observes the pid gone, never why, so lean on the last `error`
    // stream event this session saw.
    const providerLimitMessage = isProviderLimitError(rt.lastErrorMessage)
      ? rt.lastErrorMessage
      : undefined
    // A provider-limit death outranks the discovered `reason`: whichever
    // liveness axis failed, a driver-reported cap is the truer explanation.
    // Otherwise `reason` picks the wording ("process-gone" vs
    // "transport-closed") so the banner names the axis that actually failed.
    const detail = providerLimitMessage
      ? `provider usage limit hit: ${providerLimitMessage}`
      : crashReasonText(reason, pid)
    rt.desc.status = "error"
    rt.desc.endedAt = new Date().toISOString()
    rt.desc.endedReason = providerLimitMessage ? "provider-limit" : "crashed"
    rt.desc.crashedAt = rt.desc.endedAt
    rt.desc.lastError = detail
    if (rt.agentSession) {
      releaseOutOfTurnEvents(rt)
      delete rt.desc.backgroundTasks
      // Durable usage recap on exit — before close() flushes the stream.
      recordExitUsageSnapshot(rt)
      void rt.agentSession.close().catch(() => undefined)
      void transcriptWriter.close(rt.desc.id)
      tracedSessions.delete(rt.desc.id)
      // THE difference from a plain kill(): drop the binding so the row is
      // immediately lazy-resumable — `maybeResumeAgent` early-returns while
      // `rt.agentSession` is set. adapterSessionId/cwd stay on the
      // descriptor, so `isResumable` still holds.
      rt.agentSession = undefined
    }
    schedulePersist()
    const banner = providerLimitMessage
      ? `[provider-limit] ${providerLimitMessage}`
      : `[crashed] ${detail}`
    appendLine(rt, banner, "stderr")
    transcriptWriter.recordEvent(rt.desc.id, { kind: "notice", text: banner })
    // The usual lifecycle exit (carrying reason:"crashed" or "provider-limit"
    // via emitExited, which reads desc.endedReason) so existing
    // session:exited consumers see the row leave "running".
    emitExited(rt)
    if (providerLimitMessage) void suggestHandoff(rt, "provider-limit", "exit")
    return true
  }

  /**
   * The EXPECTED-EXPIRY end action — the clean twin of
   * {@link markCrashedInternal} for a sandbox box the proxy declared dead at
   * or past its known lifetime deadline while idle
   * (`sandbox-agent-session-proxy.ts`'s `SandboxBoxExpiredError`): the box's
   * work was checkpointed/delivered while it was alive, so this is the box
   * lifecycle running its course, not a failure. Mirrors `markCrashed`'
   * cleanup (same close/clear-binding shape so the row stays
   * operationally identical — `isResumable` holds, the thread of record is
   * closed) but flips the row to `status: "exited"` /
   * `endedReason: "sandbox-expired"` instead of `error`/`crashed`, so restart
   * policies (`restart-scheduler.ts` — crash-restart and sandbox-gone alike)
   * never fire on a death the system designed, and the UI shows the session
   * ENDED (with its delivered work branch in the outcome), not FAILED
   * without an artifact. Same `running`-only guard, hence idempotent.
   */
  const markSandboxExpiredInternal = (id: string, detail: string): boolean => {
    const rt = sessions.get(id)
    if (!rt || rt.desc.kind !== "agent-cli" || rt.desc.status !== "running") {
      return false
    }
    rt.desc.status = "exited"
    rt.desc.endedAt = new Date().toISOString()
    rt.desc.endedReason = "sandbox-expired"
    rt.desc.lastError = detail
    if (rt.agentSession) {
      releaseOutOfTurnEvents(rt)
      delete rt.desc.backgroundTasks
      // Durable usage recap on exit — before close() flushes the stream.
      recordExitUsageSnapshot(rt)
      // close() runs the teardown delivery / final checkpoint on a best-effort
      // basis; the box is already gone, so this is mostly a no-op salvage.
      void rt.agentSession.close().catch(() => undefined)
      void transcriptWriter.close(rt.desc.id)
      tracedSessions.delete(rt.desc.id)
      // Drop the binding exactly as a crash would: the row becomes
      // lazy-resumable (a future prompt to this session can revive it).
      rt.agentSession = undefined
    }
    schedulePersist()
    const banner = `[sandbox-expired] ${detail}`
    appendLine(rt, banner, "stdout")
    transcriptWriter.recordEvent(rt.desc.id, { kind: "notice", text: banner })
    emitExited(rt)
    return true
  }

  /**
   * Bind an agent session onto its runtime handle AND subscribe to its
   * transport death — the single place `rt.agentSession` is ever assigned a
   * live session, so spawn, lazy resume, and adopt-into-existing-row all get
   * the same watcher without each remembering to add it.
   *
   * What it buys: the daemon learns an ACP stream died the INSTANT it dies,
   * instead of at the next crash-detect sweep (≤30s later) or — for a parked
   * session nobody prompts — never. That was the `sess_950d1251` failure:
   * connection closed at 15:04Z, row still `running`/`alive: true` 40+
   * minutes later, `agent_prompt` going nowhere.
   *
   * Orderly teardown is not special-cased here on purpose: `markCrashed`'s
   * own `running`-only guard already rejects it (see above), so this stays a
   * one-line subscription rather than a second copy of the liveness rules.
   */
  const bindAgentSession = (rt: SessionRuntime, session: AgentSessionLike): void => {
    rt.agentSession = session
    if (rt.desc.remote === true && typeof session.sessionId === "string" && session.sessionId.length > 0) {
      rt.desc.sandboxRemoteSessionId = session.sessionId
    }
    session.onDisconnect?.(err => {
      const id = rt.desc.id
      // Re-read the CURRENT binding rather than closing over `session`: by
      // the time a stale connection's abort lands, the row may already have
      // been resumed onto a fresh session. Crash-marking then would kill a
      // healthy session on the strength of its dead predecessor.
      if (rt.agentSession !== session) return
      // A sandbox box dying AT/PAST its known lifetime deadline while idle is
      // expected expiry, not a crash — end the row cleanly with the delivered
      // work branch surfaced (see `SandboxBoxExpiredError` in
      // `sandbox-agent-session-proxy.ts`).
      if (isSandboxBoxExpiredError(err)) {
        if (markSandboxExpiredInternal(id, err.message)) {
          console.warn(
            `[sessions] ${id}: sandbox box lifetime expired (${err.message}) — ` +
              "marked sandbox-expired; the row stays lazy-resumable.",
          )
        }
        return
      }
      if (markCrashedInternal(id, "transport-closed")) {
        console.warn(
          `[sessions] ${id}: adapter connection closed (${err.message}) — ` +
            "marked crashed; the row stays lazy-resumable.",
        )
      }
    })
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
      ...pickUsageDetail({ ...rt.desc, turns: rt.desc.turnsCompleted }),
      ...(rt.desc.contextSize !== undefined ? { contextSize: rt.desc.contextSize } : {}),
      ...(rt.desc.contextUsed !== undefined ? { contextUsed: rt.desc.contextUsed } : {}),
    })

  /**
   * Fold the turn in progress into the cumulative `durationMs` / `toolCalls`
   * descriptor fields. Idempotent per turn (keyed on `turnStartedAtMs`), so
   * the exit recap and the turn's own `finally` can both call it.
   */
  const closeTurnStats = (rt: SessionRuntime): void => {
    if (rt.turnStartedAtMs === undefined) return
    rt.desc.durationMs =
      (rt.desc.durationMs ?? 0) + Math.max(0, Date.now() - rt.turnStartedAtMs)
    rt.desc.toolCalls = (rt.desc.toolCalls ?? 0) + (rt.toolCallsThisTurn ?? 0)
    rt.turnStartedAtMs = undefined
  }

  /**
   * Write a final `usage_snapshot` recap when an agent session exits (kill,
   * turn error, cost-cap, shutdown). Stamps `usageSource` on the descriptor
   * and skips writing when there's nothing measured (`source: "none"`) so a
   * never-run session doesn't leave an empty transcript file. Must run BEFORE
   * `transcriptWriter.close(id)`.
   */
  const recordExitUsageSnapshot = (rt: SessionRuntime): void => {
    if (rt.desc.kind !== "agent-cli") return
    closeTurnStats(rt)
    const usage = buildUsageSnapshot(rt)
    rt.desc.usageSource = usage.source
    if (usage.source === "none") return
    transcriptWriter.recordUsageSnapshot(rt.desc.id, usage)
  }

  /** Adapter-reader usage: the shape `readUsage` hooks return, modulo the doc
   *  on `SessionRuntime.readUsage`. */
  type AdapterUsageRead = UsageReadResult

  /**
   * Mirror one adapter-reader usage snapshot onto a session — the shared body
   * behind the turn-end cost refresh AND the live-usage poller
   * (`armUsageRefresh` below). Mirrors model, cost, and tokens onto the
   * descriptor, stamps `adapterReportedCost` (which demotes any running
   * "computed" estimate to the authoritative adapter figure — replacement,
   * never addition), and records a `usage_update` into the transcript plus a
   * refreshed durable `usage_snapshot` when the reader returned any signal
   * (size/used 0, cost + tokens when present).
   *
   * `dedupe: true` (the live poller) skips both the mirror and the recording
   * when the read is content-identical to the previous one — an idle session
   * polls every few seconds and its reader returns the same numbers every
   * time; writing those out would spam events.jsonl without carrying news.
   */
  const applyUsageRead = (
    rt: SessionRuntime,
    usage: AdapterUsageRead,
    opts?: { dedupe?: boolean },
  ): void => {
    if (rt.desc.kind !== "agent-cli") return
    const key = [
      usage.model ?? "",
      usage.costUsd ?? "",
      usage.tokensIn ?? "",
      usage.tokensOut ?? "",
      usage.cacheReadTokens ?? "",
      usage.cacheWriteTokens ?? "",
      usage.reasoningTokens ?? "",
    ].join("|")
    if (opts?.dedupe && rt.lastUsageReadKey === key) return
    rt.lastUsageReadKey = key

    // A reader that knows the model (a sandbox box's `session_usage`)
    // fills a descriptor that was spawned without one, so the
    // provenance footer / session_usage can name it. Never
    // overrides a model the spawn itself pinned.
    if (typeof usage.model === "string" && usage.model.length > 0 && rt.desc.model === undefined) {
      rt.desc.model = usage.model
    }
    if (usage.costUsd !== undefined) {
      rt.desc.costUsd = usage.costUsd
      rt.adapterReportedCost = true
      // Live adapter-priced truth — stamped immediately, not only at the
      // turn-end re-derivation, so `session_usage`'s `source` is truthful
      // while the session is busy.
      rt.desc.usageSource = "adapter"
    }
    if (usage.tokensIn !== undefined) rt.desc.tokensIn = usage.tokensIn
    if (usage.tokensOut !== undefined) rt.desc.tokensOut = usage.tokensOut
    if (usage.cacheReadTokens !== undefined) rt.desc.cacheReadTokens = usage.cacheReadTokens
    if (usage.cacheWriteTokens !== undefined) rt.desc.cacheWriteTokens = usage.cacheWriteTokens
    if (usage.reasoningTokens !== undefined) rt.desc.reasoningTokens = usage.reasoningTokens
    const readerHasTokens =
      usage.tokensIn !== undefined ||
      usage.tokensOut !== undefined ||
      usage.cacheReadTokens !== undefined ||
      usage.cacheWriteTokens !== undefined
    if (readerHasTokens) rt.readerReportedTokens = true

    // Tokens without an adapter cost (opencode's broker store reports a
    // tokens-only row on some sessions) still surface a computed running
    // figure — the same derivation the usage_update-frame path does, so a
    // live session never shows bare tokens with an unexplained absent cost.
    if (!rt.adapterReportedCost && usage.costUsd === undefined && readerHasTokens) {
      const model = rt.desc.activeModel ?? rt.desc.model
      const derived = deriveSessionUsage({
        ...(model !== undefined ? { model } : {}),
        ...(usage.tokensIn !== undefined ? { tokensIn: usage.tokensIn } : {}),
        ...(usage.tokensOut !== undefined ? { tokensOut: usage.tokensOut } : {}),
        ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
        ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
      })
      if (derived.source === "computed" && derived.costUsd !== undefined) {
        rt.desc.costUsd = derived.costUsd
        rt.desc.usageSource = "computed"
      }
    }

    // Only when the reader actually returned a signal — never
    // synthesize a usage event from nothing. Shape is identical to
    // the ACP-arm's usage_update: size/used default to 0 (this reader
    // carries no context-window figure, and `projectEvent` guards on
    // >0 so the 0s never clobber a real size already mirrored onto
    // the descriptor).
    if (usage.costUsd !== undefined || readerHasTokens) {
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
      // Refresh the durable recap too: snapshots are cumulatives and the
      // rollup sums latest-in-window deltas (usage-rollup pin 1), so an extra
      // mid-turn row is a delta input, never a double count. This also heals
      // the "reader beat the adapter's own state-store write at turn-end"
      // race, which used to strand a `source:"none"` row in the snapshot log
      // while the live descriptor carried real numbers.
      const snapshot = buildUsageSnapshot(rt)
      if (snapshot.source !== "none") {
        rt.desc.usageSource = snapshot.source
        transcriptWriter.recordUsageSnapshot(rt.desc.id, snapshot)
      }
      schedulePersist()
    }
  }

  /** Stop the live-usage poller, if armed. */
  const stopUsageRefresh = (rt: SessionRuntime): void => {
    if (rt.usageRefreshTimer) {
      clearInterval(rt.usageRefreshTimer)
      rt.usageRefreshTimer = undefined
    }
    rt.usageRefreshInFlight = false
  }

  /** One live-usage poll: re-read the adapter's usage reader and mirror any
   *  changed values onto the descriptor + transcript. See `armUsageRefresh`. */
  const pollUsageOnce = async (rt: SessionRuntime): Promise<void> => {
    if (rt.usageRefreshInFlight) return
    // The poll's own lifecycle gate: a session that is no longer "running"
    // (killed / exited / errored, or still "starting") has no live usage to
    // read and its timer is stale — disarm it. Checked before anything async
    // so a raced stop still lands on the next tick rather than never.
    if (rt.desc.status !== "running" || sessions.get(rt.desc.id) !== rt) {
      stopUsageRefresh(rt)
      return
    }
    if (!rt.readUsage) return
    rt.usageRefreshInFlight = true
    try {
      const usage = await rt.readUsage()
      // Re-check after the await: the session may have been killed or
      // replaced mid-read; a late read must not touch the descriptor.
      if (usage && rt.desc.status === "running" && sessions.get(rt.desc.id) === rt) {
        applyUsageRead(rt, usage, { dedupe: true })
      }
    } catch {
      // best-effort — swallow, same contract as the turn-end refresh
    } finally {
      rt.usageRefreshInFlight = false
    }
  }

  /**
   * Arm the live-usage poller for a session that carries a `readUsage` hook.
   *
   * WHY this exists: those readers were polled ONLY at turn-end
   * (`runAgentTurn`'s turnCompleted block) — for hermes, whose ACP server
   * emits NO usage frames at all, an entire long turn showed no cost/tokens
   * until the turn ended; on the observed hermes executor session the first
   * (and only) `usage_update` landed together with its aborted turn-end
   * about 30 minutes after spawn. A calm 5s re-read keeps the cost/token
   * fields on `session_list` / `session_usage` live for the whole session
   * instead. The turn-end refresh keeps running too — the poller is merely
   * the between-ends filler, and both paths funnel through `applyUsageRead`
   * so mirroring cannot drift apart.
   */
  const armUsageRefresh = (rt: SessionRuntime): void => {
    if (!rt.readUsage || rt.usageRefreshTimer) return
    if (rt.desc.kind !== "agent-cli") return
    const ms = opts?.usageRefreshIntervalMs ?? USAGE_REFRESH_INTERVAL_MS
    const timer = setInterval(() => void pollUsageOnce(rt), ms)
    // Never hold the daemon open for an idle poller.
    timer.unref?.()
    rt.usageRefreshTimer = timer
  }

  function adapterSupportsCompact(agentSession: AgentSessionLike | undefined): boolean {
    if (!agentSession?.availableModes) return false
    return agentSession.availableModes.some(m => m.id.toLowerCase() === "compact")
  }


  /**
   * Write a checkpoint (goal, plan, decisions, changed files, tests, errors,
   * risks, next step) BEFORE a step that discards conversation context —
   * runtime compaction, a `/compact` prompt, a hard stop. Throws when the
   * checkpoint can't be built or persisted; the caller decides whether the
   * step may proceed without it (compaction: no; hard stop: yes, loudly).
   *
   * `askSource` puts a handoff turn to the live session so the checkpoint
   * carries its own decisions/risks. That needs the session idle, so only the
   * pre-turn `/compact` gate can ask; the turn-boundary paths run while the
   * finishing turn still holds `busy` and extract from the transcript alone
   * (the checkpoint's `handoffTurn` says which happened).
   */
  async function checkpointBeforeContextLoss(
    rt: SessionRuntime,
    reason: string,
    askSource: boolean,
  ): Promise<ContextCheckpoint> {
    const policy = rt.desc.contextContinuity ?? CONTEXT_CONTINUITY_DEFAULTS
    const pct = computeContextPct(rt.desc.contextSize, rt.desc.contextUsed) ?? policy.continueFreshAtPct
    // The checkpoint reads events.jsonl: make the turn that just ended durable first.
    await transcriptWriter.drain?.(rt.desc.id)
    const checkpoint = await buildContextCheckpoint(
      rt.desc.contextContinuity ? rt.desc : { ...rt.desc, contextContinuity: policy },
      { contextPct: pct, baseDir: transcriptBaseDir, registry, askSource },
    )
    await persistCheckpoint(checkpoint)
    const line = `[context] checkpoint ${checkpoint.checkpointId} written to ${checkpoint.checkpointPath} before ${reason}`
    appendLine(rt, line, "stdout")
    transcriptWriter.recordEvent(rt.desc.id, { kind: "notice", text: line })
    return checkpoint
  }

  /** Compaction slash commands a harness acts on: `/compact` (claude-code,
   *  opencode, codex) and `/compress` (hermes). Harness-specific aliases
   *  beyond these are not recognised. */
  const COMPACT_PROMPT_RE = /^\s*\/(?:compact|compress)(?=\s|$)/i

  function isCompactPrompt(message: unknown): boolean {
    let text: unknown = message
    if (Array.isArray(text)) text = text[0]
    if (text && typeof text === "object") text = (text as { text?: unknown }).text
    return typeof text === "string" && COMPACT_PROMPT_RE.test(text)
  }

  /** Synchronous admission check for a compaction prompt: a session whose
   *  policy sets `compactRequiresOperator` takes it only from the operator
   *  (a source-less prompt), never from a session — itself included. */
  function assertCompactionAllowed(rt: SessionRuntime, message: unknown, source: string | undefined, caller: string): void {
    if (!rt.desc.contextContinuity?.compactRequiresOperator) return
    if (!isCompactPrompt(message)) return
    if (source === undefined || !source.startsWith("agent:")) return
    throw new Error(
      `${caller}: session "${rt.desc.id}" requires the operator's agreement to compact its context — a compaction prompt from ${source} is refused`,
    )
  }

  async function attemptContextCompact(rt: SessionRuntime): Promise<void> {
    if (!adapterSupportsCompact(rt.agentSession)) {
      appendLine(
        rt,
        "[context] compact threshold reached but harness does not advertise compact support; waiting for continue-fresh threshold",
        "stderr",
      )
      return
    }
    try {
      await checkpointBeforeContextLoss(rt, "runtime compaction", false)
    } catch (err) {
      appendLine(
        rt,
        `[context] compact skipped: no checkpoint could be written first (${err instanceof Error ? err.message : String(err)})`,
        "stderr",
      )
      return
    }
    try {
      await rt.agentSession?.setSessionMode?.("compact")
      appendLine(rt, "[context] compact requested from harness", "stdout")
    } catch (err) {
      appendLine(
        rt,
        `[context] compact failed: ${err instanceof Error ? err.message : String(err)}`,
        "stderr",
      )
    }
  }

  /**
   * Announce — never perform — a cross-harness handoff: a
   * `session:handoff-suggested` event plus readable transcript lines carrying
   * the command in clear. Once per `key` per session; silent when no other
   * harness is eligible. Best-effort: never throws.
   */
  async function suggestHandoff(
    rt: SessionRuntime,
    reason: "provider-limit" | "quota-threshold",
    key: string,
    quota?: { remaining: number; window: string },
  ): Promise<void> {
    try {
      const tag = `${reason}:${key}`
      if (rt.handoffSuggested?.has(tag)) return
      ;(rt.handoffSuggested ??= new Set()).add(tag)
      const fromHarness = rt.desc.harness ?? rt.desc.adapterSlug ?? "claude-code"
      const harnesses = await listHandoffHarnesses(fromHarness, opts?.listHarnessCapabilities)
      if (harnesses.length === 0) return
      const suggestions = buildHandoffSuggestions(rt.desc.id, harnesses)
      for (const line of handoffSuggestionLines({
        sessionId: rt.desc.id,
        fromHarness,
        reason,
        suggestions,
        ...(quota ? { quota } : {}),
      })) {
        appendLine(rt, line, "stderr")
        transcriptWriter.recordEvent(rt.desc.id, { kind: "notice", text: line })
      }
      sessionEvents?.emit({
        type: "session:handoff-suggested",
        sessionId: rt.desc.id,
        fromHarness,
        reason,
        suggestions,
        ...(rt.desc.label ? { label: rt.desc.label } : {}),
        ts: new Date().toISOString(),
      })
    } catch {
      // a suggestion is a courtesy — it must never break the exit/turn path
    }
  }

  /** Proactive quota threshold (`contextContinuity.handoffAtQuotaRemaining`):
   *  suggest once per quota window when the session's auth profile is at or
   *  under the threshold. Throttled; best-effort. */
  async function evaluateQuotaHandoff(rt: SessionRuntime): Promise<void> {
    const watch = opts?.quotaWatch
    const threshold = rt.desc.contextContinuity?.handoffAtQuotaRemaining
    const profileRef = rt.desc.accessProfile?.profileRef
    if (!watch || threshold === undefined || !profileRef || rt.desc.kind !== "agent-cli") return
    const now = Date.now()
    if (rt.quotaCheckedAt !== undefined && now - rt.quotaCheckedAt < (watch.minIntervalMs ?? 300_000)) return
    rt.quotaCheckedAt = now
    try {
      const profile = await watch.resolveProfile(profileRef)
      if (!profile) return
      const window = watch.window ?? "5h"
      const quota = await watch.reader.readRemainingQuota(profile, window)
      if (!quota || quota.remaining > threshold) return
      if (rt.quotaSuggestedResetsAt === quota.resetsAt) return
      rt.quotaSuggestedResetsAt = quota.resetsAt
      await suggestHandoff(rt, "quota-threshold", quota.resetsAt, {
        remaining: quota.remaining,
        window: quota.window,
      })
    } catch {
      // best-effort — a failing reader must never break the turn boundary
    }
  }

  /** The user picked a `handoff:<harness>` option: the same path as
   *  `POST /sessions/:id/handoff`. The source session is left running, like
   *  the explicit verb. */
  async function performContextHandoff(rt: SessionRuntime, harness: string): Promise<void> {
    rt.desc.awaitingInput = false
    rt.desc.awaitingQuestion = undefined
    const pct = computeContextPct(rt.desc.contextSize, rt.desc.contextUsed)
    if (pct !== null) rt.desc.contextContinuityAckedAtPct = pct
    schedulePersist()
    if (!resolveAgentAdapter) {
      appendLine(rt, "[context] handoff requested but no adapter resolver is configured", "stderr")
      return
    }
    try {
      const result = await continueAgentSessionFresh({ registry, resolveAgentAdapter }, rt.desc, {
        harness,
        baseDir: transcriptBaseDir,
      })
      appendLine(
        rt,
        `[context] handed off to ${harnessDisplayName(harness)} as ${result.descriptor.id} (checkpoint ${result.checkpoint.checkpointId})`,
        "stdout",
      )
      schedulePersist()
    } catch (err) {
      appendLine(
        rt,
        `[context] handoff to ${harness} failed: ${err instanceof Error ? err.message : String(err)}`,
        "stderr",
      )
    }
  }

  const CONTEXT_RESCUE_SOURCE = "runtime:context-rescue"
  const CONTEXT_RESCUE_BUSY_MESSAGE = "is compacting its context automatically — retry shortly (mid-turn)"
  const CONTEXT_RESCUE_FOCUS =
    "Keep the current goal, open tasks and decisions, running child sessions, pending reports, and who is waiting for what."

  const isSessionAlive = (rt: SessionRuntime): boolean =>
    rt.desc.status === "running" || rt.desc.status === "starting"

  const sleepMs = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

  function contextPctNow(rt: SessionRuntime): number | null {
    return rt.contextUsedInconsistent ? null : computeContextPct(rt.desc.contextSize, rt.desc.contextUsed)
  }

  function announceContextRescue(
    rt: SessionRuntime,
    outcome: ContextRescueOutcome,
    pctBefore: number,
    pctAfter?: number | null,
  ): void {
    const after = pctAfter === null || pctAfter === undefined ? "" : ` → ${pctAfter}%`
    const text =
      outcome === "compacted"
        ? `[context] auto-compacted at the hard-stop floor (${pctBefore}%${after}); the session continues`
        : outcome === "continued"
          ? `[context] auto-compaction could not free the window (${pctBefore}%${after}); the session was continued fresh`
          : `[context-hard-stop] context at ${pctBefore}% and neither compaction nor a fresh continuation was possible; the session was ended`
    appendLine(rt, text, outcome === "hard-stopped" ? "stderr" : "stdout")
    transcriptWriter.recordEvent(rt.desc.id, { kind: "notice", text })
    sessionEvents?.emit({
      type: "session:context-rescue",
      sessionId: rt.desc.id,
      outcome,
      pctBefore,
      ...(pctAfter !== null && pctAfter !== undefined ? { pctAfter } : {}),
      ...(rt.desc.label ? { label: rt.desc.label } : {}),
      ts: new Date().toISOString(),
    })
  }

  /**
   * The policy floor (`hardStopAtPct`) used to end the session outright — and,
   * reached while the session was idle, left it "running" but rejecting every
   * prompt. Now the floor is a trigger, not an exit: compact first (checkpoint
   * written, then `/compact` as the runtime itself), continue fresh when that
   * did not free the window, and only then stop — loudly. One rescue per
   * session at a time; prompts wait for it.
   */
  function performContextRescue(rt: SessionRuntime, pct: number): Promise<void> {
    if (rt.contextRescue) return rt.contextRescue
    const run = async (): Promise<void> => {
      await Promise.resolve()
      try {
        while (rt.busy && isSessionAlive(rt)) await sleepMs(250)
        if (!isSessionAlive(rt)) return
        const pctBefore = contextPctNow(rt) ?? pct
        const policy = rt.desc.contextContinuity
        if (policy && pctBefore < policy.hardStopAtPct) return
        appendLine(
          rt,
          `[context] context at ${pctBefore}% — compacting automatically (checkpoint first, queued prompts wait)`,
          "stdout",
        )
        const cmd = (rt.desc.harness ?? rt.desc.adapterSlug ?? "").includes("hermes") ? "/compress" : "/compact"
        try {
          await runAgentTurn(rt, `${cmd} ${CONTEXT_RESCUE_FOCUS}`, { promptSource: CONTEXT_RESCUE_SOURCE })
        } catch (err) {
          appendLine(
            rt,
            `[context] auto-compaction failed: ${err instanceof Error ? err.message : String(err)}`,
            "stderr",
          )
        }
        if (!isSessionAlive(rt)) return
        const floor = policy?.hardStopAtPct ?? CONTEXT_CONTINUITY_DEFAULTS.hardStopAtPct
        const deadline = Date.now() + (opts?.contextRescueSettleMs ?? 30_000)
        let pctAfter = contextPctNow(rt)
        while ((pctAfter === null || pctAfter >= floor) && Date.now() < deadline && isSessionAlive(rt)) {
          await sleepMs(500)
          pctAfter = contextPctNow(rt)
        }
        if (!isSessionAlive(rt)) return
        if (pctAfter !== null && pctAfter < floor) {
          delete rt.desc.contextContinuityHardStopped
          delete rt.desc.contextContinuityAckedAtPct
          schedulePersist()
          announceContextRescue(rt, "compacted", pctBefore, pctAfter)
          return
        }
        if (resolveAgentAdapter) {
          await performContextContinueFresh(rt)
          if (!isSessionAlive(rt)) {
            announceContextRescue(rt, "continued", pctBefore, pctAfter)
            return
          }
        }
        await performContextHardStop(rt, pctAfter ?? pctBefore)
        announceContextRescue(rt, "hard-stopped", pctBefore, pctAfter)
      } finally {
        rt.contextRescue = undefined
        if (isSessionAlive(rt)) dispatchQueuedPrompt(rt)
      }
    }
    rt.contextRescue = run()
    return rt.contextRescue
  }

  async function performContextHardStop(rt: SessionRuntime, pct: number): Promise<void> {
    // The stop itself is not optional (a prompt into a full window is
    // truncated or rejected), but the work done so far must survive it:
    // checkpoint first, while the transcript is still open. A failure here
    // is reported, never silent — the operator then knows to recover from
    // `events.jsonl` by hand.
    try {
      await checkpointBeforeContextLoss(rt, "hard stop", false)
    } catch (err) {
      appendLine(
        rt,
        `[context-hard-stop] WARNING: stopping WITHOUT a checkpoint — it could not be written (${err instanceof Error ? err.message : String(err)}). The transcript at ${sessionEventsPath(rt.desc.id, transcriptBaseDir)} is the only record.`,
        "stderr",
      )
    }
    if (rt.desc.status !== "running" && rt.desc.status !== "starting") return
    appendLine(
      rt,
      `[context-hard-stop] context at ${pct}% — no new prompts will be admitted. Use continue fresh.`,
      "stderr",
    )
    rt.desc.contextContinuityHardStopped = true
    rt.desc.status = "killed"
    rt.desc.endedAt = new Date().toISOString()
    rt.desc.endedReason = "context-hard-stop"
    void rt.agentSession?.close().catch(() => undefined)
    void transcriptWriter.close(rt.desc.id)
    tracedSessions.delete(rt.desc.id)
    schedulePersist()
    emitExited(rt)
  }

  async function performContextContinueFresh(rt: SessionRuntime): Promise<void> {
    if (!resolveAgentAdapter) {
      appendLine(
        rt,
        "[context] continue-fresh requested but no adapter resolver is configured; hard-stopping instead",
        "stderr",
      )
      await performContextHardStop(
        rt,
        computeContextPct(rt.desc.contextSize, rt.desc.contextUsed) ?? 100,
      )
      return
    }
    try {
      const result = await continueAgentSessionFresh(
        { registry, resolveAgentAdapter },
        rt.desc,
        // The session is at its context limit: don't spend another turn on
        // a handoff question, extract from the transcript instead.
        { askSource: false, baseDir: transcriptBaseDir },
      )
      appendLine(
        rt,
        `[context] continued fresh to ${result.descriptor.id} (checkpoint ${result.checkpoint.checkpointId})`,
        "stdout",
      )
      // Gracefully end the original session now that the handoff is done.
      rt.desc.status = "killed"
      rt.desc.endedAt = new Date().toISOString()
      rt.desc.contextContinuityHardStopped = true
      void rt.agentSession?.close().catch(() => undefined)
      void transcriptWriter.close(rt.desc.id)
      tracedSessions.delete(rt.desc.id)
      schedulePersist()
      emitExited(rt)
      retireRow(rt, "continued", result.descriptor.id)
    } catch (err) {
      appendLine(
        rt,
        `[context] continue-fresh failed: ${err instanceof Error ? err.message : String(err)}`,
        "stderr",
      )
    }
  }

  /**
   * Ask the harness to compact the session's context, the same way the
   * `session_compact` verb does (a `/compact` prompt; hermes gets
   * `/compress`), and report the state of the session as it was BEFORE
   * the compaction went out.
   *
   * The snapshot is taken FIRST, on purpose: the compaction is a turn of
   * its own, and a turn overwrites the turn-end markers
   * (`lastTurnReason` / `lastTurnErroredAt`) and clears `awaitingInput`.
   * Read after it, every session would look like a clean, completed turn
   * and nothing would ever be resumed.
   *
   * The compaction itself carries the full transcript path and a reminder
   * that `transcript_search` / `transcript_read` exist, so the session can
   * recover whatever the summary dropped. A harness whose compact command
   * takes an argument gets that instruction on the command itself
   * (claude-code: `/compact <instructions>`); every other harness gets the
   * same one-line reminder as a pending note that rides along with the
   * NEXT prompt the session receives, never as a turn of its own.
   */
  async function requestAutoCompact(rt: SessionRuntime): Promise<AutoCompactOutcome> {
    // The snapshot is taken FIRST, on purpose: the compaction is a turn of
    // its own, and a turn overwrites the turn-end markers
    // (`lastTurnReason` / `lastTurnErroredAt`) and clears `awaitingInput`.
    // Read after it, every session would look like a clean, completed turn
    // and nothing would ever be resumed.
    const snapshot = autoCompactSnapshot(rt)
    let goal: string | undefined
    try {
      const checkpoint = await checkpointBeforeContextLoss(rt, "auto compaction", false)
      // The checkpoint's goal section falls back to the session TITLE when
      // the transcript carries no goal, and a title is not a mission: it is
      // not repeated as one. The goal is optional TEXT in the resume
      // prompt; it never decides whether that prompt is sent.
      const checkpointGoal = checkpoint.sections.goal?.trim()
      const title = rt.desc.title?.trim()
      if (checkpointGoal && checkpointGoal !== title) goal = checkpointGoal
    } catch (err) {
      appendLine(
        rt,
        `[auto-compact] no checkpoint could be written: ${err instanceof Error ? err.message : String(err)}`,
        "stderr",
      )
    }
    const harness = rt.desc.harness ?? rt.desc.adapterSlug ?? ""
    const cmd = harness.includes("hermes") ? "/compress" : "/compact"
    // Harness support for a compact ARGUMENT (the instructions that tell
    // the summary where the full transcript is):
    //   - claude-code: its CLI accepts `/compact <instructions>`, and the
    //     adapter advertises the command with an input hint ("optional
    //     context about what to preserve").
    //   - codex / opencode / hermes: the adapter dispatches the command by
    //     NAME (opencode routes `/compact` to `session.summarize`, hermes
    //     matches `_handle_slash_command`), so trailing text is not a
    //     compaction instruction there.
    const takesInstructions = compactCommandTakesInstructions(harness)
    const prompt = takesInstructions
      ? `${cmd} ${buildAutoCompactCompactInstructions({ transcriptPath: autoCompactTranscriptPath(rt) })}`
      : cmd
    // The runtime's own compaction prompt: not attributed to a session
    // (`agent:<id>`), so a policy that reserves compaction for the operator
    // (`compactRequiresOperator`) still refuses session-initiated
    // compactions while the runtime may rescue a session on its own.
    await registry.sendPrompt(rt.desc.id, prompt, { source: "runtime:auto-compact" })
    // The pointer to the full transcript must reach the session after EVERY
    // autocompaction, also when no resume prompt is sent (the idle case):
    // arm it for the next prompt the session receives. It never starts a
    // turn of its own.
    // A harness that took the pointer on the compact command itself
    // already has it: arming it again would deliver the same line twice.
    if (!takesInstructions) {
      rt.pendingAutoCompactNote = buildAutoCompactTranscriptNote(autoCompactTranscriptPath(rt))
    }
    return { ...(goal !== undefined ? { goal } : {}), snapshot }
  }

  /** The absolute path of the session's full transcript. */
  function autoCompactTranscriptPath(rt: SessionRuntime): string {
    return rt.desc.eventsPath ?? sessionEventsPath(rt.desc.id, transcriptBaseDir)
  }

  /**
   * The runtime state of an idle session, read at the moment the
   * autocompact fires: what was going on when the session was compacted.
   *
   * A session parked on an unanswered question (`awaitingInput`) is
   * deliberately not read here: the resume prompt would clear the parked
   * question and tell the agent to carry on without its answer. Likewise a
   * `cancelled` turn end (a user stop) does not count as work in progress.
   * A session that merely finished its work carries none of these flags,
   * and gets no resume prompt.
   */
  function autoCompactSnapshot(rt: SessionRuntime): WorkInProgressSnapshot {
    return {
      backgroundTaskOutstanding:
        (rt.desc.pendingBgTasks ?? 0) > 0 || (rt.desc.backgroundTasks?.length ?? 0) > 0,
      pendingToolCall:
        rt.desc.awaitingPermission === true || (rt.activeToolCalls?.size ?? 0) > 0,
      lastTurnOutcome: deriveLastTurnOutcome({
        reason: rt.desc.lastTurnReason,
        errored: rt.desc.lastTurnErroredAt !== undefined,
        interrupted: rt.desc.killedMidTurn === true,
      }),
    }
  }

  /**
   * Autocompact: the ABSOLUTE token threshold path.
   *
   * The percent ladder (`warnAtPct` / `compactAtPct` / …) cannot see a
   * session whose window is huge: 558k tokens in a 1M window is "55%",
   * the warn band, so nothing ever compacts and every call re-reads the
   * whole context. An absolute count does not care how big the window is.
   *
   * Fires only on an idle session (turn ended, no background task), at
   * most once per compaction, and injects a short resume prompt only when
   * the session really had WORK IN PROGRESS when it was compacted (see
   * `hasWorkInProgress`). An idle session that was simply done gets its
   * context freed and nothing else.
   */
  async function maybeAutoCompact(rt: SessionRuntime): Promise<void> {
    if (rt.desc.kind !== "agent-cli") return
    if (rt.desc.status !== "running" && rt.desc.status !== "starting") return
    // A harness that does not advertise compact support would be sent
    // `/compact` again on every growth re-arm — a repeated-prompt loop. Stay
    // silent instead, like `attemptContextCompact` (which also gates on this).
    if (!adapterSupportsCompact(rt.agentSession)) return
    const controller = (rt.autoCompact ??= createAutoCompactController({
      readTokens: () => rt.desc.contextUsed,
      readThreshold: () =>
        rt.desc.contextContinuity?.autoCompactAtTokens ??
        CONTEXT_CONTINUITY_DEFAULTS.autoCompactAtTokens,
      isIdle: () => rt.busy !== true,
      hasBackgroundTask: () =>
        (rt.desc.pendingBgTasks ?? 0) > 0 || (rt.desc.backgroundTasks?.length ?? 0) > 0,
      isCompacting: () => rt.contextRescue !== undefined,
      requestCompact: () => requestAutoCompact(rt),
      requestResume: async prompt => {
        // The resume prompt cites the transcript path and the lookup tools
        // itself, so the pending note armed for the next prompt would
        // repeat it: drop it.
        rt.pendingAutoCompactNote = undefined
        await registry.sendPrompt(rt.desc.id, prompt, { source: "runtime:auto-compact-resume" })
      },
      transcriptPath: () => autoCompactTranscriptPath(rt),
      log: line => {
        appendLine(rt, line, "stdout")
        transcriptWriter.recordEvent(rt.desc.id, { kind: "notice", text: line })
      },
    }))
    await controller.maybeTrigger()
  }

  /**
   * Schedule the autocompact check for the next tick: the check runs a
   * compaction TURN, so it must not be re-entered from inside the turn
   * that just ended.
   */
  function scheduleAutoCompact(rt: SessionRuntime): void {
    if (rt.autoCompactScheduled) return
    rt.autoCompactScheduled = true
    setTimeout(() => {
      rt.autoCompactScheduled = false
      void maybeAutoCompact(rt).catch(() => undefined)
    }, 0)
  }

  async function evaluateContextContinuity(rt: SessionRuntime): Promise<void> {
    if (rt.desc.kind !== "agent-cli") return
    // Autocompact is ABSOLUTE and window-independent: it must be evaluated
    // even when the window size is unknown (the percent ladder cannot act
    // without one, and that is exactly the 1M-context case).
    scheduleAutoCompact(rt)
    const policy = rt.desc.contextContinuity
    if (!policy) return
    const pct = computeContextPct(rt.desc.contextSize, rt.desc.contextUsed)
    if (pct === null) return

    const nextAction = contextContinuityNextAction(
      contextContinuityStateForPct(pct, policy),
      policy.mode,
    )

    switch (nextAction) {
      case "none":
        return
      case "warn": {
        const status = computeContextContinuityStatus(
          rt.desc.id,
          policy,
          rt.desc.contextSize,
          rt.desc.contextUsed,
        )
        appendLine(rt, `[context] ${status.summary}`, "stderr")
        return
      }
      case "ask": {
        // Suppress re-asking the same question at (or below) the pct the
        // user already answered "keep-going" at — the `ask` action covers
        // the whole `[compactAtPct, hardStopAtPct)` band, not just the
        // instant a threshold is crossed, so without this the very next
        // turn-boundary check (context hasn't moved) would immediately
        // re-raise a question the user just dismissed. `hard-stop` is a
        // separate `nextAction` entirely (checked ahead of `ask` in
        // `contextContinuityStateForPct`), so it's never suppressed by this.
        const ackedAtPct = rt.desc.contextContinuityAckedAtPct
        if (ackedAtPct !== undefined && pct <= ackedAtPct) return
        const handoffHarnesses = await listHandoffHarnesses(
          rt.desc.harness ?? rt.desc.adapterSlug ?? "claude-code",
          opts?.listHarnessCapabilities,
        )
        rt.desc.awaitingInput = true
        rt.desc.awaitingQuestion = {
          source: "structured",
          text: `Context is at ${pct}%. Continue fresh to avoid losing continuity?`,
          options: [
            "continue-fresh",
            ...handoffHarnesses.map(h => `${HANDOFF_OPTION_PREFIX}${h}`),
            "keep-going",
          ],
          // The question IS the recommendation — "Continue fresh" is the
          // daemon's own sentence — so surface it for one-click answers.
          recommended: "continue-fresh",
        }
        appendLine(
          rt,
          `[context] context at ${pct}% — waiting for user decision (continue fresh or keep going)`,
          "stdout",
        )
        schedulePersist()
        return
      }
      case "compact":
        await attemptContextCompact(rt)
        return
      case "continue-fresh":
        await performContextContinueFresh(rt)
        return
      case "hard-stop":
        // The latest frame's `used` contradicted the window (see
        // `contextUsedInconsistent`), so `pct` is a stale reading — ending a
        // session on it is irreversible, a warning is not.
        if (rt.contextUsedInconsistent) {
          appendLine(
            rt,
            `[context] hard-stop skipped at ${pct}% — the adapter's last usage frame reported more tokens than the window holds, so the reading is unreliable`,
            "stderr",
          )
          return
        }
        // Not awaited: the rescue waits for this very turn to settle.
        void performContextRescue(rt, pct)
        return
    }
  }

  // ── Inbox + waiters (AIP-46 §Session messages) ────────────────────────
  interface InboxWaiter {
    filter: MessageFilter
    ack: boolean
    resolve: (messages: SessionMessage[]) => void
  }
  const inboxWaiters = new Map<string, InboxWaiter[]>()
  /** Ids already surfaced in an fyi digest (per daemon lifetime — a restart
   *  re-surfaces them once, which is harmless). */
  const digestedFyi = new Set<string>()

  // ── AIP-42 hot role refresh: opt-in file watch ────────────────────────
  // In-memory only (never persisted) — a daemon restart simply drops it,
  // same as every other live-process-only watcher. Stopped explicitly via
  // `setAgentRoleWatch(id, false)` or implicitly when the session retires
  // (`retireRow`, below).
  interface AgentRoleWatchState {
    watcher: FSWatcher
    debounce: ReturnType<typeof setTimeout> | null
  }
  const agentRoleWatchers = new Map<string, AgentRoleWatchState>()
  const AGENT_ROLE_WATCH_DEBOUNCE_MS = 400
  const stopAgentRoleWatch = (id: string): boolean => {
    const state = agentRoleWatchers.get(id)
    if (!state) return false
    if (state.debounce) clearTimeout(state.debounce)
    state.watcher.close()
    agentRoleWatchers.delete(id)
    return true
  }

  const setInbox = (rt: SessionRuntime, next: SessionMessage[]): void => {
    rt.desc.inbox = next
    schedulePersist()
  }
  const addToInbox = (rt: SessionRuntime, msg: SessionMessage): void => {
    let next = [...(rt.desc.inbox ?? []).filter(m => m.id !== msg.id), msg]
    while (next.length > INBOX_CAP) {
      const [dropped, ...rest] = next
      next = rest
      appendLine(rt, `[inbox] dropped ${dropped!.id} (inbox full, cap ${INBOX_CAP})`, "stderr")
    }
    setInbox(rt, next)
  }
  const rememberReceived = (rt: SessionRuntime, msgs: readonly SessionMessage[]): void => {
    if (!msgs.length) return
    const ids = new Set(msgs.map(m => m.id))
    const next = [...(rt.recentlyReceived ?? []).filter(m => !ids.has(m.id)), ...msgs]
    rt.recentlyReceived = next.length > INBOX_CAP ? next.slice(-INBOX_CAP) : next
  }
  const removeFromInbox = (rt: SessionRuntime, ids: ReadonlySet<string>): void => {
    if (!rt.desc.inbox?.some(m => ids.has(m.id))) return
    rememberReceived(rt, rt.desc.inbox.filter(m => ids.has(m.id)))
    setInbox(rt, rt.desc.inbox.filter(m => !ids.has(m.id)))
  }
  const dropQueuedEnvelopes = (rt: SessionRuntime, ids: ReadonlySet<string>): void => {
    const queue = rt.desc.promptQueue
    if (!queue?.some(p => p.envelope && ids.has(p.envelope.id))) return
    rt.desc.promptQueue = queue.filter(p => !(p.envelope && ids.has(p.envelope.id)))
    schedulePersist()
  }
  /** Consume matched messages for a waiter: stamp `via:"wait"` (recording a
   *  `session-message` for any not already surfaced into a turn), pull them
   *  out of the prompt queue, and ack them off the inbox when asked. */
  const consumeForWait = (
    rt: SessionRuntime,
    msgs: readonly SessionMessage[],
    ack: boolean,
  ): SessionMessage[] => {
    const at = new Date().toISOString()
    const ids = new Set(msgs.map(m => m.id))
    const out = msgs.map(m => {
      if (m.delivered && m.delivered.via !== "inbox") return m
      const stamped: SessionMessage = { ...m, delivered: { via: "wait", at } }
      transcriptWriter.recordSessionMessage?.(rt.desc.id, stamped)
      emitSessionMessage(stamped)
      return stamped
    })
    dropQueuedEnvelopes(rt, ids)
    if (ack) {
      removeFromInbox(rt, ids)
    } else {
      const byId = new Map(out.map(m => [m.id, m]))
      setInbox(rt, (rt.desc.inbox ?? []).map(m => byId.get(m.id) ?? m))
    }
    return out
  }
  /** Try to steer `msg` into `rt`'s running turn. True only when it was
   *  injected (then it's consumed: recorded as `session-message` via
   *  `steer`, never queued, never in the inbox). False — nothing sent, or
   *  the agent said no turn is running — means "deliver as next-turn". */
  const trySteer = async (rt: SessionRuntime, msg: SessionMessage): Promise<boolean> => {
    const agent = rt.agentSession
    // Host-turn gate: only while OUR prompt is in flight, never during an
    // agent-autonomous cycle (#1410/#1412 — a steer there folds into a
    // result the daemon never sees), and only for an agent that steers.
    if (!agent?.steer || agent.steeringSupported !== true) return false
    if (!rt.busy || rt.autonomousTurn) return false
    const now = Date.now()
    if (rt.lastSteerAt !== undefined && now - rt.lastSteerAt < STEER_MIN_INTERVAL_MS) return false
    const at = new Date().toISOString()
    const stamped: SessionMessage = {
      ...msg,
      delivered: { via: "steer", at, turnSeq: (rt.desc.turnsCompleted ?? 0) + 1 },
    }
    let content = renderSessionMessages([stamped])
    const teach = !rt.desc.messagePreambleSent
    if (teach) content = `${MESSAGE_PREAMBLE}\n\n${content}`
    rt.lastSteerAt = now
    const outcome = await agent.steer(content)
    if (outcome !== "steered") {
      rt.lastSteerAt = undefined
      return false
    }
    if (teach) {
      rt.desc.messagePreambleSent = true
      schedulePersist()
    }
    recordSent(stamped)
    transcriptWriter.recordSessionMessage?.(rt.desc.id, stamped)
    rememberReceived(rt, [stamped])
    emitSessionMessage(stamped)
    appendLine(rt, `[message] ${stamped.id} from ${stamped.from.relation} steered into the running turn`, "stdout")
    return true
  }

  const canSteerPrompt = (rt: SessionRuntime): boolean => {
    const agent = rt.agentSession
    return !!agent?.steer && agent.steeringSupported === true && rt.busy && !rt.autonomousTurn
  }

  /** Inject one queued prompt into the running turn (ACP steering). Records it
   *  as a user prompt in the transcript, like a turn it would have become. */
  const steerQueuedPrompt = async (rt: SessionRuntime, item: QueuedPrompt): Promise<boolean> => {
    const agent = rt.agentSession
    if (!agent?.steer) return false
    let outcome: "steered" | "promptRequired" | "unsupported"
    try {
      const content = typeof item.message === "string" ? escapeHumanPrompt(item.message) : item.message
      outcome = await agent.steer(content)
    } catch {
      return false
    }
    if (outcome !== "steered") return false
    const at = new Date().toISOString()
    transcriptWriter.recordPrompt(
      rt.desc.id,
      item.message,
      item.source ? { source: item.source } : undefined,
    )
    rt.lastUserPrompt = { ts: at, text: promptTextForIndex(item.message, undefined) }
    appendLine(rt, `[prompt] ${item.id} from ${promptOriginLabel(item)} steered into the running turn`, "stdout")
    const seen = (rt.steeredPromptAt ??= new Map())
    seen.set(item.id, at)
    if (seen.size > 100) seen.delete(seen.keys().next().value as string)
    return true
  }

  /** Steer every `steer`-flagged queued prompt into the running turn, in queue
   *  (FIFO) order, as soon as the agent can take it. Non-steer items are
   *  skipped (they keep waiting for turn end); a refused steer stops the run so
   *  later items never overtake an earlier one. Serialized per session. */
  const flushSteerableQueue = (rt: SessionRuntime): Promise<void> => {
    const run = async (): Promise<void> => {
      try {
        while (canSteerPrompt(rt)) {
          const head = rt.desc.promptQueue?.find(p => p.steer && !p.envelope)
          if (!head) break
          rt.steerInFlight = head.id
          let ok = false
          try {
            ok = await steerQueuedPrompt(rt, head)
          } finally {
            rt.steerInFlight = undefined
          }
          if (!ok) break
          rt.desc.promptQueue = (rt.desc.promptQueue ?? []).filter(p => p.id !== head.id)
          schedulePersist()
        }
      } finally {
        // The turn may have ended while a steer RPC was in flight and
        // `dispatchQueuedPrompt` held off — drain now.
        if (!rt.busy) dispatchQueuedPrompt(rt)
      }
    }
    rt.steerChain = (rt.steerChain ?? Promise.resolve()).then(run, run)
    return rt.steerChain
  }

  /** One pass over every session's prompt queue: force-deliver items past
   *  their `deliverWithin` deadline, and tell the sender once about items that
   *  have waited past the staleness threshold. */
  const sweepPendingPrompts = async (
    sweepOpts?: { now?: number; staleMs?: number },
  ): Promise<PendingPromptSweepSummary> => {
    const now = sweepOpts?.now ?? Date.now()
    if (sweepOpts?.staleMs !== undefined && sweepOpts.staleMs > 0) {
      pendingPromptStaleMs = sweepOpts.staleMs
    }
    const summary: PendingPromptSweepSummary = { stale: 0, forced: 0, ids: [] }
    for (const rt of Array.from(sessions.values())) {
      for (const item of [...(rt.desc.promptQueue ?? [])]) {
        if (!rt.desc.promptQueue?.some(p => p.id === item.id)) continue
        if (item.deliverBy && Date.parse(item.deliverBy) <= now) {
          const via = item.deliverVia ?? "auto"
          if (via !== "interrupt" && canSteerPrompt(rt)) {
            rt.desc.promptQueue = rt.desc.promptQueue.map(p => (p.id === item.id ? { ...p, steer: true } : p))
            await flushSteerableQueue(rt)
          }
          if (rt.desc.promptQueue?.some(p => p.id === item.id) && via !== "steer") {
            try {
              await registry.deliverQueuedPrompt(rt.desc.id, item.id)
            } catch (err) {
              appendLine(rt, `[error] deliverWithin: ${err instanceof Error ? err.message : String(err)}`, "stderr")
            }
          }
          if (!rt.desc.promptQueue?.some(p => p.id === item.id)) {
            summary.forced++
            summary.ids.push(item.id)
            continue
          }
        }
        const age = now - Date.parse(item.queuedAt)
        // Typed-message envelopes are skipped: a notice about a notice would loop.
        if (!item.envelope && !item.staleNotifiedAt && age >= pendingPromptStaleMs) {
          rt.desc.promptQueue = (rt.desc.promptQueue ?? []).map(p =>
            p.id === item.id ? { ...p, staleNotifiedAt: new Date(now).toISOString() } : p,
          )
          schedulePersist()
          summary.stale++
          summary.ids.push(item.id)
          await notifyStalePrompt(rt, item, age)
        }
      }
    }
    return summary
  }

  /** Tell the sender (the `agent:<id>` session that queued it, else the
   *  target's parent) that a prompt is still undelivered — as a typed `notice`
   *  into its inbox. A human sender has no inbox; they see `pendingPrompts`. */
  const notifyStalePrompt = async (rt: SessionRuntime, item: QueuedPrompt, ageMs: number): Promise<void> => {
    const caller = item.source?.startsWith("agent:") ? item.source.slice("agent:".length) : undefined
    const recipientId = caller && sessions.has(caller) ? caller : rt.desc.parentSessionId
    if (!recipientId || recipientId === rt.desc.id || !sessions.has(recipientId)) return
    const minutes = Math.round(ageMs / 60_000)
    try {
      await registry.sendMessage(
        createSessionMessage({
          to: recipientId,
          from: { relation: "system" },
          kind: "notice",
          urgency: "steer",
          text:
            `Prompt ${item.id} to session ${rt.desc.id} ("${previewPrompt(item.message, 60)}") has been ` +
            `queued for ${minutes} min and has NOT been delivered: the target is mid-turn. ` +
            `Re-send with agent_prompt interrupt:true to redirect it now, or deliverWithin to force it.`,
          data: { kind: "prompt-stale", sessionId: rt.desc.id, queueId: item.id, ageMs },
        }),
      )
    } catch {
      // Best-effort: the recipient may have exited — pendingPrompts still shows it.
    }
  }

  const recordSent = (msg: SessionMessage): void => {
    if (!msg.from.sessionId) return
    transcriptWriter.recordSessionMessageSent?.(msg.from.sessionId, {
      messageId: msg.id,
      to: msg.to,
      kind: msg.kind,
      urgency: msg.urgency,
    })
  }

  /** Emit the bus `session:message` edge for one message — at send (no
   *  `delivered`) and again at delivery. */
  const emitSessionMessage = (msg: SessionMessage): void => {
    sessionEvents?.emit({
      type: "session:message",
      sessionId: msg.to,
      messageId: msg.id,
      ...(msg.from.sessionId ? { fromSessionId: msg.from.sessionId } : {}),
      relation: msg.from.relation,
      kind: msg.kind,
      urgency: msg.urgency,
      ...(msg.delivered ? { delivered: msg.delivered } : {}),
      ts: new Date().toISOString(),
    })
  }

  /** Deliver a batch of typed messages as ONE turn: stamp `delivered`,
   *  render the envelope tags, and run it — recorded as `session-message`
   *  records, never a `user-prompt`, and never matched as a structured-
   *  question answer. */
  const runMessageTurn = async (
    rt: SessionRuntime,
    envelopes: readonly SessionMessage[],
    via: MessageDeliveryVia,
    promptSource?: string,
  ): Promise<void> => {
    const at = new Date().toISOString()
    const turnSeq = (rt.desc.turnsCompleted ?? 0) + 1
    const delivered = envelopes.map(m => ({ ...m, delivered: { via, at, turnSeq } }))
    for (const m of delivered) emitSessionMessage(m)
    // Surfaced into a turn ⇒ consumed: auto-ack off the durable inbox.
    removeFromInbox(rt, new Set(delivered.map(m => m.id)))
    await runAgentTurn(rt, renderSessionMessages(delivered), {
      ...(promptSource ? { promptSource } : {}),
      messages: delivered,
    })
  }

  // Stamp `lastActivityAt` from a turn's own event stream. The ACP
  // `onActivity` circuit only fires for adapter PROCESS traffic, so a
  // SANDBOX proxy session (whose "adapter" runs on a remote box and streams
  // events to the host) never pulses while its turn runs: `lastActivityAt`
  // stays at `startedAt`, and both the stall watchdog and the idle reaper
  // then measure silence from turn start. Observed 2026-10-18: a sandboxed
  // session 72 tool calls into a busy first turn was flagged
  // "stalled" and reaped "idle" 19m20s after its box was created.
  // Feeding the pulse from the turn loop closes that gap for every driver
  // shape, and `clearStalledFlag` mirrors `pulseActivity` so recovery
  // disproves a stall claim without waiting for the next sweep tick.
  // (Redundant-but-harmless for local sessions, which already pulse from
  // `onActivity`; both stamp the same field.)
  const pulseTurnActivity = (rt: SessionRuntime): void => {
    rt.desc.lastActivityAt = new Date().toISOString()
    clearStalledFlag(rt)
    schedulePersist()
  }

  const runAgentTurn = async (
    rt: SessionRuntime,
    message: unknown,
    // Prompt provenance for the transcript's "user-prompt" record —
    // `agent:<sessionId>` when another session injected this turn
    // (agent_prompt from a supervisor, a parent's spawn prompt), absent for
    // a human operator. Recording-only: never alters turn behavior.
    // `messages` marks a typed-message turn (`runMessageTurn`): `message`
    // is then the rendered envelope tags.
    // `reattach` marks the turn a re-attached sandbox session picks up from
    // its box after a host restart: the prompt already ran on the box, so
    // nothing is sent and no `user-prompt` is recorded — the box's own events
    // are replayed into the host transcript via `resumeTurn()`.
    turnOpts?: {
      promptSource?: string
      system?: string
      messages?: readonly SessionMessage[]
      reattach?: boolean
    }
  ): Promise<void> => {
    if (!rt.agentSession) {
      throw new Error("runAgentTurn: session has no agentSession")
    }
    const reattachTurn = turnOpts?.reattach === true
    // A compaction prompt discards context: refuse it where the policy
    // reserves compaction to the operator, and otherwise checkpoint BEFORE
    // it reaches the harness. This is the single choke point every prompt
    // path funnels through (sendPrompt, enqueuePrompt, the queue drain), and
    // it must run before `busy` is taken — a throw inside the turn would mark
    // the session errored. No checkpoint, no compaction.
    if (isCompactPrompt(message)) {
      assertCompactionAllowed(rt, message, turnOpts?.promptSource, "runAgentTurn")
      // A handoff turn is opt-in (`compactHandoffTurn`), and the rescue never
      // asks: default `/compact` writes the checkpoint from the transcript
      // alone, with no billed model turn before the harness compacts in place.
      const compactHandoffTurn = rt.desc.contextContinuity?.compactHandoffTurn ?? false
      const askSource =
        compactHandoffTurn && turnOpts?.promptSource !== CONTEXT_RESCUE_SOURCE
      try {
        // The rescue runs at the window's edge: no handoff turn into it.
        await checkpointBeforeContextLoss(rt, "compaction", askSource)
      } catch (err) {
        throw new Error(
          `runAgentTurn: compaction refused — no checkpoint could be written first (${err instanceof Error ? err.message : String(err)})`,
        )
      }
      // The checkpoint awaited a handoff turn: the session may have moved on.
      validateAgentTurn(rt.desc.id, "runAgentTurn", { compaction: true })
    }
    const messageTurn = turnOpts?.messages !== undefined && turnOpts.messages.length > 0
    if (messageTurn) {
      // Teach the envelope invariant once, the first time this session
      // receives a message — as a `system-prompt` slice, not a user bubble.
      if (!rt.desc.messagePreambleSent && typeof message === "string") {
        message = `${MESSAGE_PREAMBLE}\n\n${message}`
        turnOpts = { ...turnOpts, system: MESSAGE_PREAMBLE }
        rt.desc.messagePreambleSent = true
        schedulePersist()
      }
    } else if (typeof message === "string") {
      // A human line opening with the envelope sentinel is escaped, so text
      // outside an `<agentproto-message>` tag is always the human's.
      message = escapeHumanPrompt(message)
    }
    // `fyi` messages never wake a session; the next turn it runs anyway
    // opens with a one-line typed digest of them (a `system-prompt` slice,
    // never glued into the human's text), once per message.
    if (typeof message === "string") {
      const fresh = (rt.desc.inbox ?? []).filter(m => m.urgency === "fyi" && !digestedFyi.has(m.id))
      if (fresh.length) {
        for (const m of fresh) digestedFyi.add(m.id)
        const digest = renderInboxDigest(fresh)
        message = `${digest}\n\n${message}`
        turnOpts = { ...turnOpts, system: turnOpts?.system ? `${digest}\n\n${turnOpts.system}` : digest }
      }
    }
    // This turn was delivered by cutting the previous one — say so first,
    // as a `system-prompt` slice, so the model doesn't read the cancel as a
    // human stop and park. String messages only (same rule as the resume
    // digest below): a raw content block keeps it for the next string turn.
    if (rt.pendingInterruptNotice && typeof message === "string") {
      const notice = rt.pendingInterruptNotice
      rt.pendingInterruptNotice = undefined
      message = `${notice}\n\n${message}`
      turnOpts = { ...turnOpts, system: turnOpts?.system ? `${notice}\n\n${turnOpts.system}` : notice }
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
    if (!rt.desc.title && !messageTurn && !reattachTurn) rt.desc.title = deriveSessionTitle(message)
    // Flush a queued best-effort resume-context digest (Fix D — see
    // `SessionDescriptor.pendingResumeContext`'s doc) onto THIS turn's
    // outgoing message, exactly once. String messages only — a non-string
    // turn (a raw ACP ContentBlock) has no text slot to prepend into; the
    // digest stays queued for the next turn that does. (Child reports and
    // crash notices are NOT flushed this way any more — they're their own
    // `promptQueue` turns, see `isChildPromptSource`.)
    if (rt.desc.pendingResumeContext && typeof message === "string") {
      message = `${rt.desc.pendingResumeContext}\n\n${message}`
      rt.desc.pendingResumeContext = undefined
    }
    // A pending autocompact note (the path of the full transcript plus the
    // two lookup tools) rides along with the NEXT prompt this session
    // receives: it is delivered as part of that prompt, never as a turn of
    // its own (waking an idle session just to tell it where the transcript
    // is would cost a turn and a model call for nothing).
    //
    // Runtime-internal autocompact prompts (the compaction itself, the
    // resume prompt) do not consume it: the compaction IS the thing the
    // note is about, and the resume prompt already cites the path.
    //
    // A prompt that starts with "/" is left alone: the adapters dispatch a
    // slash command on the LEADING slash of the first text block, so
    // gluing the note in front of it would turn the command into prose.
    // Such a prompt does not consume the note either: it stays armed for
    // the next ordinary prompt.
    //
    // It is flushed AFTER the title is derived, so the note never leaks
    // into the session's name.
    const autoCompactNote = rt.pendingAutoCompactNote
    if (
      autoCompactNote !== undefined &&
      !isRuntimeAutoCompactSource(turnOpts?.promptSource) &&
      typeof message === "string" &&
      !message.trimStart().startsWith("/")
    ) {
      rt.pendingAutoCompactNote = undefined
      message = `${autoCompactNote}\n\n${message}`
      turnOpts = {
        ...turnOpts,
        system: turnOpts?.system ? `${autoCompactNote}\n\n${turnOpts.system}` : autoCompactNote,
      }
    }
    rt.busy = true
    rt.desc.busy = true             // mirror onto the public descriptor for session_monitor
    rt.emitter.emit("busy", true)
    rt.desc.awaitingInput = false  // clear stale awaiting-input flag from prior turn
    rt.desc.awaitingQuestion = undefined
    releaseBlockedOn(rt.desc)      // clear stale blocked-on from prior turn
    clearStalledFlag(rt)           // clear stale stall flag from prior turn
    rt.activeToolCalls = new Map()
    rt.toolCallIdsThisTurn = new Set()
    rt.toolCallsThisTurn = 0
    rt.turnStartedAtMs = Date.now()
    rt.turnHadOutput = false
    // Clear a stale parked-with-background-tasks flag from the prior turn —
    // the session was re-prompted, so it is by definition no longer parked:
    // this turn will see whatever its background tasks produced. Counter
    // resets for the new turn either way; the descriptor flag + bus event
    // only fire when the flag was actually set (mirrors clearStalledFlag's
    // no-op-when-clean shape).
    rt.bgTaskStarts = 0
    rt.bgTaskCountedIds = new Set()
    // A prompt reaches the agent anyway — it will see any task that settled
    // meanwhile, so the fallback wake would only repeat the news.
    takeBackgroundTaskWake(rt)
    if (rt.desc.pendingBgTasks !== undefined) {
      delete rt.desc.pendingBgTasks
      sessionEvents?.emit({
        type: "session:bg-tasks-cleared",
        sessionId: rt.desc.id,
        ...(rt.desc.label ? { label: rt.desc.label } : {}),
        ts: new Date().toISOString(),
      })
    }
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
    // Captures the message of an in-band `error` stream event observed
    // during THIS turn — deliberately separate from `rt.lastErrorMessage`,
    // which is cross-turn and never cleared (reserved for the
    // markCrashed/provider-limit paths below). Lets the P5 fallback below
    // classify a turn whose generator simply returns (no explicit
    // adapter turn-end, no thrown error) after emitting an `error` event
    // as "error" instead of the default "exited" — see
    // `SessionDescriptor.lastTurnErroredAt`'s doc. Also rides along on
    // `lastTurnErrorMessage` and the `session:turn-end` bus event's `error`.
    let turnErrorMessage: string | undefined
    // Productivity signals for empty-turn detection: a turn that produces
    // ZERO assistant text AND zero tool calls is a silent no-op (a bad /
    // unrecognized model id, or a provider that returned an empty
    // completion) and must be flagged, not reported as a green turn-end.
    let sawAssistantText = false
    let sawToolCall = false
    // Tool names this turn called, keyed by toolCallId (an enrichment update
    // may name a call announced untitled). Rides on the `session:turn-end`
    // event's `toolCalls` so the turn-retry controller can refuse to re-run
    // a turn that already did something with side effects.
    const turnToolNames = new Map<string, string>()
    // Track tool-call IDs announced during this turn so the finally block can
    // emit synthetic tool-results for adapters that silently drop them.
    const pendingToolCallIds = new Set<string>()
    // Settle missing adapter completions at the terminal boundary. This must
    // run BEFORE a real turn-end is persisted: transcript consumers replay in
    // sequence, and a terminal event is the last chance to close nested or
    // parallel tool cards without making them look live forever.
    const settlePendingToolCalls = (): void => {
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
    try {
      if (!reattachTurn) {
        appendLine(
          rt,
          `\x1b[2m── ▶ ${typeof message === "string" ? message : JSON.stringify(message)} ──\x1b[0m`,
          "stdout"
        )
        transcriptWriter.recordPrompt(
          rt.desc.id,
          message,
          turnOpts?.promptSource || turnOpts?.system || messageTurn
            ? {
                ...(turnOpts?.promptSource ? { source: turnOpts.promptSource } : {}),
                ...(turnOpts?.system ? { system: turnOpts.system } : {}),
                ...(messageTurn ? { messages: turnOpts!.messages } : {}),
              }
            : undefined
        )
        // Capture the caller's own ask (system preamble stripped, mirroring the
        // transcript writer) so the index sidecar carries it without a
        // transcript read on the write path.
        rt.lastUserPrompt = { ts: new Date().toISOString(), text: promptTextForIndex(message, turnOpts?.system) }
      }
      // ACP's `prompt` field expects ContentBlock[] (or a single
      // block). Hosts that send a raw string get auto-wrapped into
      // `{type: "text", text: "..."}` so callers can hand us
      // human-friendly prompts without shaping the wire format.
      const wrapped =
        typeof message === "string" ? { type: "text", text: message } : message
      // Learn a model switch sent as an ORDINARY prompt instead of the
      // `agent_set_model` verb — the shape a `/model <id>` shortcut typed
      // into chat actually produces (see `activeModel`'s doc on
      // `SessionDescriptor`). Only bothers checking events against
      // `isModelSwitchAcknowledgement` when the outgoing text looks like a
      // switch request at all, so an ordinary chat turn pays nothing extra.
      const switchCandidate =
        typeof message === "string" ? parseModelSwitchCommand(message) : undefined
      let switchLearned = false
      const turnStream =
        reattachTurn && rt.agentSession.resumeTurn
          ? rt.agentSession.resumeTurn()
          : rt.agentSession.send(wrapped)
      for await (let evt of turnStream) {
        // Every event from the turn stream is adapter activity — stamp
        // `lastActivityAt` so the stall watchdog and idle reaper age the
        // silence from the LAST output, not `startedAt` (sandbox proxies
        // have no `onActivity` circuit; see `pulseTurnActivity` above).
        pulseTurnActivity(rt)
        // Hermes may end a turn with nested/parallel tool calls still lacking
        // their terminal `tool_call_update`. Persist synthetic settlements
        // first so durable replay observes result → turn-end, never the
        // reverse. Real results already removed their ids from the set.
        if (evt.kind === "turn-end") settlePendingToolCalls()
        // Capture the structured event to events.jsonl BEFORE
        // projectEvent flattens it into an ANSI ring-buffer line — the
        // only point downstream of the driver where the original
        // shape (tool arguments, plan entries, ...) still exists.
        if (evt.kind === "usage_update") evt = normalizeUsageFrame(rt, evt)
        if (evt.kind === "error" && evt.error?.message) {
          const tagged = tagLimitErrorWithWallet(evt.error.message, rt.desc.accessProfile)
          if (tagged !== evt.error.message) evt = { ...evt, error: { ...evt.error, message: tagged } }
        }
        transcriptWriter.recordEvent(rt.desc.id, evt)
        projectEvent(rt, evt)
        if (switchCandidate && !switchLearned && isModelSwitchAcknowledgement(evt)) {
          switchLearned = true
          if (rt.desc.activeModel !== switchCandidate) {
            rt.desc.activeModel = switchCandidate
            resetContextWindowForModel(rt.desc, switchCandidate)
            schedulePersist()
            sessionEvents?.emit({
              type: "session:model-changed",
              sessionId: rt.desc.id,
              model: rt.desc.model ?? switchCandidate,
              activeModel: switchCandidate,
              label: rt.desc.label,
              ts: new Date().toISOString(),
            })
          }
        }
        // `text-delta` is the sole assistant-text channel (see projectEvent);
        // a whitespace-only delta doesn't count as real output.
        if (evt.kind === "text-delta" && evt.text?.trim()) sawAssistantText = true
        else if (evt.kind === "tool-call") {
          sawToolCall = true
          if (evt.toolCallId) pendingToolCallIds.add(evt.toolCallId)
          const toolKey = evt.toolCallId ?? `anon-${turnToolNames.size}`
          if (evt.toolName || !turnToolNames.has(toolKey)) turnToolNames.set(toolKey, evt.toolName ?? "")
          // Count background task starts for the turn-end "parked" heuristic
          // (`SessionDescriptor.pendingBgTasks`). Claude Code's Bash announces
          // a background task as a tool-call whose arguments object carries
          // `run_in_background: true` — matched generically on the property,
          // not the tool name, so any adapter/tool with the same convention
          // counts. Dedup is keyed on the toolCallId, NOT on `isUpdate`: an
          // announce can arrive argument-less with a later isUpdate
          // enrichment filling in the arguments (transcript-writer merges
          // late arguments for exactly this flow), so the flag can show up on
          // ANY announcement of the call — count the first one that carries
          // it, dedupe the rest by id. A call with no toolCallId (defensive)
          // falls back to counting once per bg-arguments event.
          if (isBackgroundToolCallArguments(evt.arguments)) {
            const alreadyCounted =
              evt.toolCallId !== undefined && rt.bgTaskCountedIds?.has(evt.toolCallId) === true
            if (!alreadyCounted) {
              rt.bgTaskStarts = (rt.bgTaskStarts ?? 0) + 1
              if (evt.toolCallId !== undefined) {
                if (!rt.bgTaskCountedIds) rt.bgTaskCountedIds = new Set()
                rt.bgTaskCountedIds.add(evt.toolCallId)
              }
            }
          }
        }
        if (evt.kind === "tool-result" && evt.toolCallId) {
          pendingToolCallIds.delete(evt.toolCallId)
        }
        // Any output or usage proves the provider is producing something —
        // a later stall is then "slow", not "silently retrying", so the
        // stall watchdog must NOT attach a provider-retry turn error.
        if (isTurnOutputEvent(evt)) rt.turnHadOutput = true
        if (evt.kind === "error" && evt.error?.message) {
          turnErrorMessage = evt.error.message
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
        const message = tagLimitErrorWithWallet(
          err instanceof Error ? err.message : String(err),
          rt.desc.accessProfile,
        )
        appendLine(rt, `[turn error] ${message}`, "stderr")
        // A thrown provider/subscription usage-cap error (or one reported via
        // an `error` stream event just before the generator gave up) gets its
        // own reason instead of the bare "turn error" — see
        // `isProviderLimitError`'s doc.
        if (isProviderLimitError(message) || isProviderLimitError(rt.lastErrorMessage)) {
          rt.desc.endedReason = "provider-limit"
          rt.desc.lastError = message
        }
        recordExitUsageSnapshot(rt)
        schedulePersist()
        emitExited(rt)
        if (rt.desc.endedReason === "provider-limit") void suggestHandoff(rt, "provider-limit", "exit")
      }
    } finally {
      // Captured BEFORE `busy` flips: the awaits further down this block let
      // the interrupting caller start its own turn (and that turn could be
      // interrupted in turn), so reading the flag at the drain would see
      // someone else's.
      const interruptedBy = rt.interruptRequested
      rt.interruptRequested = undefined
      closeTurnStats(rt)
      rt.busy = false
      rt.desc.busy = false           // mirror onto the public descriptor for session_monitor
      rt.emitter.emit("busy", false)
      // Safety net: a tool-call that never receives its tool-result (child
      // crashed, stream ended early) must not leave the session flagged
      // blocked forever — the turn is over, nothing is pending anymore.
      releaseBlockedOn(rt.desc)
      rt.activeToolCalls?.clear()
      // The turn is over either way — "mid-turn and silent" can no longer
      // hold, so any stall flag from this turn is stale.
      clearStalledFlag(rt)

      // ── Synthetic tool-results for orphaned pending tool calls ─────────
      // Adapters that execute a tool but silently drop the matching
      // `tool_call_update status=completed` leave the tool card stuck
      // "pending" in every UI consumer. Emit a synthetic `tool-result`
      // before the turn-end so transcript reducers can resolve the segment.
      settlePendingToolCalls()

      // ── P5: guarantee exactly one terminal turn-end per turn ──────────
      // If the adapter's event stream ended without a turn-end (generator
      // returned early, subprocess exited, threw, or was aborted), inject
      // one so downstream orchestration can rely on turn-end as a uniform
      // completion signal instead of hanging. Idempotent — `sawTurnEnd`
      // short-circuits when the adapter already produced one.
      if (!sawTurnEnd) {
        // A generator that returns cleanly (no throw) after having emitted
        // an in-band `error` event is still an errored turn, not a clean
        // "exited" one — `abnormalReason`/`killed` (a real abort/kill) take
        // precedence when set, since those are more specific than "the
        // stream carried an error somewhere".
        const reason =
          abnormalReason ??
          (rt.desc.status === "killed"
            ? "aborted"
            : turnErrorMessage !== undefined
              ? "error"
              : "exited")
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
        // ...and the continue-interrupted bookkeeping that qualifies them: a
        // recovered session is no longer "interrupted by the last restart",
        // and its auto-continue budget starts fresh.
        delete rt.desc.interruptedAtBoot
        delete rt.desc.autoContinueAttempts
        delete rt.desc.lastAutoContinueBoot

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

        // ── Crash-loop reset (restart-scheduler, PR-2): a turn that ran to
        // completion proves the session is genuinely healthy again, not just
        // resumed — so the crash-loop rolling window is cleared, letting a
        // session that crashes again later start its backoff/cap fresh
        // instead of inheriting a stale attempt count. Guarded the same way
        // as the resumeAttempts reset above.
        if (rt.desc.restartAttempts) {
          delete rt.desc.restartAttempts
          delete rt.desc.lastRestartAt
          delete rt.desc.nextRestartAt
          delete rt.desc.nextRestartFreshBox
          delete rt.desc.recentRestartAts
        }

        // ── Turn-level adapter error (crash-reaper's twin for a turn that
        // fails IN-BAND while the process stays alive — see
        // `SessionDescriptor.lastTurnErroredAt`'s docblock). `turnEndReason`
        // is only ever "error" here (inside `turnCompleted`) when the
        // adapter's OWN turn-end event reported it — the thrown/rejected
        // stream path is the separate `catch` branch above, which already
        // flips `status` to `"error"`. A later turn that completes WITHOUT
        // one proves recovery, so it clears the marker — same reset shape
        // as `resumeAttempts`/`restartAttempts` above.
        if (turnEndReason === "error") {
          rt.desc.lastTurnErroredAt = new Date().toISOString()
          if (turnErrorMessage !== undefined) {
            rt.desc.lastTurnErrorMessage = turnErrorMessage
          } else {
            delete rt.desc.lastTurnErrorMessage
          }
          schedulePersist()
        } else if (rt.desc.lastTurnErroredAt !== undefined) {
          delete rt.desc.lastTurnErroredAt
          delete rt.desc.lastTurnErrorMessage
          schedulePersist()
        }

        // ── Cost refresh (best-effort) ───────────────────────────────
        // The adapter's own reader (e.g. hermes state.db) is authoritative —
        // a returned `costUsd` marks the session as adapter-priced.
        if (rt.readUsage) {
          try {
            const usage = await rt.readUsage()
            if (usage) applyUsageRead(rt, usage)
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

        // ── Context-continuity policy evaluation ─────────────────────
        await evaluateContextContinuity(rt)
        if (opts?.quotaWatch && rt.desc.contextContinuity?.handoffAtQuotaRemaining !== undefined) {
          await evaluateQuotaHandoff(rt)
        }

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
          rt.desc.endedReason = "cost-cap-exceeded"
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
        // Persist alongside the bus event so `monitorSessionWait`'s sync
        // fast-path (descriptor-only, no event object) can surface the
        // same signal — see `SessionDescriptor.lastTurnEmpty`'s doc.
        if (emptyTurn) {
          rt.desc.lastTurnEmpty = true
        } else if (rt.desc.lastTurnEmpty !== undefined) {
          delete rt.desc.lastTurnEmpty
        }
        if (turnEndReason !== undefined) {
          rt.desc.lastTurnReason = turnEndReason
        } else if (rt.desc.lastTurnReason !== undefined) {
          delete rt.desc.lastTurnReason
        }
        // Device-spawn first-turn failure — see `firstTurnFailed`'s doc.
        if (
          rt.desc.remote === true &&
          rt.desc.sandboxProvider?.startsWith("device:") &&
          rt.desc.turnsCompleted === 1 &&
          (emptyTurn || turnEndReason === "error")
        ) {
          rt.desc.firstTurnFailed = true
          schedulePersist()
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
            ...(turnErrorMessage !== undefined ? { error: turnErrorMessage } : {}),
            ...(interruptedBy ? { interrupted: true } : {}),
            ...(turnToolNames.size > 0 ? { toolCalls: [...turnToolNames.values()] } : {}),
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

        // ── Parked-with-background-tasks (turn-END twin of session:stalled)
        // The turn just ended having started one or more background tool
        // calls and is NOT awaiting input — the harness's task-completion
        // notification does NOT wake it, so the session is about to sit
        // busy:false / awaitingInput:false with work pending: a silent dead
        // end. Flag the descriptor (session_list consumers see it even with
        // no bus wired) and announce on the bus. Detection + signal ONLY —
        // no auto-wake (what to say is the supervisor's call, not the
        // daemon's). Cleared on the next turn start / on session exit.
        // Only for an agent that does NOT report its task lifecycle: one that
        // does is tracked in `backgroundTasks` and woken when a task settles.
        if ((rt.bgTaskStarts ?? 0) > 0 && !rt.desc.awaitingInput && !rt.reportsBackgroundTasks) {
          rt.desc.pendingBgTasks = rt.bgTaskStarts
          schedulePersist()
          sessionEvents?.emit({
            type: "session:bg-tasks-parked",
            sessionId: rt.desc.id,
            count: rt.bgTaskStarts ?? 0,
            ...(rt.desc.label ? { label: rt.desc.label } : {}),
            ts: new Date().toISOString(),
          })
        }
        if (overBudget) emitExited(rt)

        // ── Session titler (opt-in, first completed turn only) ──────
        // Fire-and-forget: `maybeTitleSession` never throws and never
        // blocks the turn-end path. Gated on the FIRST turn
        // (`turnsCompleted` was just bumped, so 1 = first), agent-cli
        // only; the titler itself re-checks eligibility (config off,
        // default-label guard, once-only set) and no-ops otherwise.
        if ((rt.desc.turnsCompleted ?? 0) === 1) {
          void maybeTitleSession(registry, rt.desc.id)
        }
      } else {
        // ── Abnormal turn end (error / abort) ────────────────────────
        // The adapter's stream broke before a turn-end. We already
        // synthesized the terminal turn-end above; still stamp
        // turnsCompleted and emit the bus turn-end so a `session_monitor`
        // (or any consumer waiting on completion) doesn't hang on a turn
        // that will never signal done through the normal path.
        rt.desc.turnsCompleted = (rt.desc.turnsCompleted ?? 0) + 1
        // Not an "empty" turn in the tracked sense (that classification is
        // normal-path only, mirroring the bus event) — but the reason still
        // needs to reach the sync fast-path the same way. See
        // `SessionDescriptor.lastTurnEmpty`/`lastTurnReason`'s doc.
        if (rt.desc.lastTurnEmpty !== undefined) delete rt.desc.lastTurnEmpty
        if (turnEndReason !== undefined) {
          rt.desc.lastTurnReason = turnEndReason
        } else if (rt.desc.lastTurnReason !== undefined) {
          delete rt.desc.lastTurnReason
        }
        // Device-spawn first-turn failure — see `firstTurnFailed`'s doc.
        if (
          rt.desc.remote === true &&
          rt.desc.sandboxProvider?.startsWith("device:") &&
          rt.desc.turnsCompleted === 1 &&
          turnEndReason === "error"
        ) {
          rt.desc.firstTurnFailed = true
          schedulePersist()
        }
        if (sessionEvents) {
          sessionEvents.emit({
            type: "session:turn-end",
            sessionId: rt.desc.id,
            awaitingInput: rt.desc.awaitingInput ?? false,
            label: rt.desc.label,
            ts: new Date().toISOString(),
            ...(turnEndReason ? { reason: turnEndReason } : {}),
            ...(turnErrorMessage !== undefined ? { error: turnErrorMessage } : {}),
            ...(interruptedBy ? { interrupted: true } : {}),
            ...(turnToolNames.size > 0 ? { toolCalls: [...turnToolNames.values()] } : {}),
          })
        }
      }

      // A turn just ended (normal or abnormal) — refresh the sidecar on the
      // throttled trailing schedule, never per streaming frame.
      scheduleIndexWrite(rt)

      // ── FIFO queue drain (session-queue-ux) ──────────────────────
      // Runs after every turn that ended on its own, normal or abnormal —
      // see `dispatchQueuedPrompt`'s doc for why re-dispatching into a
      // no-longer-alive session is safe (it re-validates and drops with
      // a logged error rather than throwing here).
      //
      // A turn the DAEMON interrupted drains nothing: queued means "after
      // the current turn ends", not "the moment anyone cuts it". Draining
      // here made a Stop start the next queued prompt immediately, made an
      // unrelated queued prompt look like the cause of the cancel, and
      // raced an `interrupt: true` prompt for the freed slot. The parked
      // items drain after the next turn that ends naturally. The one
      // exception is deliver-now, which interrupted precisely to run its
      // item.
      if (!interruptedBy) dispatchQueuedPrompt(rt)
      else if (interruptedBy.deliverQueueId) {
        dispatchQueuedPrompt(rt, interruptedBy.deliverQueueId)
      }
    }
  }

  // ── Background tasks + autonomous turns ───────────────────────────────
  // An agent can keep working with no prompt in flight: Claude Code wakes
  // the model itself when a `run_in_background` task settles (a
  // "task-notification" cycle) and streams that work as ordinary ACP
  // updates. The ACP client hands those to `handleOutOfTurnEvent` (they used
  // to be dropped — the session looked idle, "waiting on the notification",
  // while the agent worked invisibly and a supervisor re-prompted or reaped
  // it). The registry now tracks such a stretch as an AUTONOMOUS turn (busy,
  // recorded, closed with a turn-end), mirrors the task lifecycle onto
  // `SessionDescriptor.backgroundTasks`, and — for an agent that does NOT
  // wake itself — sends the wake prompt when a task settles on an idle
  // session (`backgroundTaskWake`, on by default).
  const bgWakeEnabled = opts?.backgroundTaskWake?.enabled ?? true
  const bgWakeGraceMs = opts?.backgroundTaskWake?.graceMs ?? DEFAULT_BG_TASK_WAKE_GRACE_MS
  /** Silence after which an autonomous turn with no open tool call is closed
   *  even though its closing cost frame never arrived. */
  const AUTONOMOUS_SILENCE_CLOSE_MS = 120_000
  /** The same fallback while a tool call is still open — generous, since a
   *  foreground command inside the cycle can legitimately run for minutes. */
  const AUTONOMOUS_SILENCE_CLOSE_WITH_TOOLS_MS = 30 * 60_000
  /** After an interrupt closes an autonomous turn, the agent's in-progress
   *  cycle keeps streaming until the new prompt lands on the wire; don't
   *  re-open a turn (which would make the prompt's admission see `busy`)
   *  for this long. */
  const AUTONOMOUS_REOPEN_HOLD_MS = 5_000
  /** Out-of-turn event kinds that mean the model is actually working. Task
   *  lifecycle, usage and capability metadata alone do not open a turn. */
  const AUTONOMOUS_WORK_KINDS = new Set([
    "text-delta",
    "thought",
    "tool-call",
    "tool-result",
    "plan",
    "agent-prompt",
  ])
  const autonomousReopenHoldUntil = new Map<string, number>()

  /** Mirror one `background-task` lifecycle edge onto the descriptor, the
   *  ring buffer and the bus; a settle on an idle session arms the wake. */
  const noteBackgroundTask = (rt: SessionRuntime, evt: AgentStreamEvent): void => {
    const info = evt.task
    if (!info?.taskId) return
    rt.reportsBackgroundTasks = true
    const tasks = rt.desc.backgroundTasks ?? []
    // A task that already settled can settle AGAIN: claude-agent-acp closes a
    // task best-effort as "stopped" when its replace-level drops it, then
    // corrects that with the authoritative "completed"/"failed" edge. Merge
    // the correction onto the settled record (still held for the wake).
    const settledBefore = rt.bgWake?.settled.find(t => t.taskId === info.taskId)
    const prior = tasks.find(t => t.taskId === info.taskId) ?? settledBefore
    const taskKind = info.taskKind ?? prior?.taskKind
    const description = info.description ?? prior?.description
    const outputFile = info.outputFile ?? prior?.outputFile
    const summary = info.summary ?? prior?.summary
    const toolCallId = info.toolCallId ?? prior?.toolCallId
    const task: SessionBackgroundTask = {
      taskId: info.taskId,
      status: info.status ?? prior?.status ?? "running",
      startedAt: prior?.startedAt ?? new Date().toISOString(),
      ...(taskKind ? { taskKind } : {}),
      ...(description ? { description } : {}),
      ...(outputFile ? { outputFile } : {}),
      ...(summary ? { summary } : {}),
      ...(toolCallId ? { toolCallId } : {}),
    }
    const busEvent = (phase: "started" | "settled") =>
      sessionEvents?.emit({
        type: "session:bg-task",
        sessionId: rt.desc.id,
        phase,
        taskId: task.taskId,
        ...(task.taskKind ? { taskKind: task.taskKind } : {}),
        ...(task.description ? { description: task.description } : {}),
        ...(task.outputFile ? { outputFile: task.outputFile } : {}),
        status: task.status,
        ...(task.summary ? { summary: task.summary } : {}),
        ...(rt.desc.label ? { label: rt.desc.label } : {}),
        ts: new Date().toISOString(),
      })
    if (evt.phase === "settled") {
      const rest = tasks.filter(t => t.taskId !== task.taskId)
      if (rest.length > 0) rt.desc.backgroundTasks = rest
      else delete rt.desc.backgroundTasks
      // A repeated settle is only news when it corrects the status.
      if (settledBefore?.status !== task.status) {
        appendLine(
          rt,
          `\x1b[2m[bg-task] ${task.taskId} ${task.status}` +
            `${task.description ? ` — ${task.description}` : ""}\x1b[0m`,
          "stdout"
        )
        busEvent("settled")
      }
      // Mid-turn the agent hears about it in-turn; only an idle session
      // can be left parked.
      if (!rt.busy) queueBackgroundTaskWake(rt, task)
    } else {
      rt.desc.backgroundTasks = prior
        ? tasks.map(t => (t.taskId === task.taskId ? task : t))
        : [...tasks, task]
      if (!prior) {
        appendLine(
          rt,
          `\x1b[2m[bg-task] ${task.taskId} started` +
            `${task.description ? ` — ${task.description}` : ""}\x1b[0m`,
          "stdout"
        )
        busEvent("started")
      }
    }
    schedulePersist()
  }

  /** Remember a settled task and arm the (coalescing) wake timer: every
   *  settle inside one grace window rides the same wake. */
  const queueBackgroundTaskWake = (rt: SessionRuntime, task: SessionBackgroundTask): void => {
    if (!bgWakeEnabled || rt.desc.status !== "running") return
    const wake = (rt.bgWake ??= { settled: [] })
    // Latest edge wins — a corrected settle replaces the provisional one.
    wake.settled = [...wake.settled.filter(t => t.taskId !== task.taskId), task]
    if (wake.timer) return
    wake.timer = setTimeout(() => {
      void fireBackgroundTaskWake(rt)
    }, bgWakeGraceMs)
    wake.timer.unref?.()
  }

  /** Disarm the wake and hand back what it would have announced. */
  const takeBackgroundTaskWake = (rt: SessionRuntime): SessionBackgroundTask[] => {
    const wake = rt.bgWake
    if (!wake) return []
    if (wake.timer) clearTimeout(wake.timer)
    rt.bgWake = undefined
    return wake.settled
  }

  /** The grace window elapsed without the agent waking itself: prompt it. */
  const fireBackgroundTaskWake = async (rt: SessionRuntime): Promise<void> => {
    const settled = takeBackgroundTaskWake(rt)
    if (settled.length === 0) return
    // Working again (its own wake, or a prompt landed) — it hears the
    // notification itself; a dead session has nobody to wake.
    if (rt.busy || rt.desc.status !== "running" || !rt.agentSession) return
    const message = buildBackgroundTaskWakePrompt(settled)
    try {
      const live = validateAgentTurn(rt.desc.id, "background-task-wake")
      await runAgentTurn(live, message, { promptSource: "background-task" })
    } catch (err) {
      appendLine(
        rt,
        `[error] background-task wake dropped — ${err instanceof Error ? err.message : String(err)}`,
        "stderr"
      )
    }
  }

  /** Open an autonomous turn: the agent started working with no prompt. */
  const beginAutonomousTurn = (rt: SessionRuntime): void => {
    // It woke itself — the registry's fallback wake is moot.
    const settled = takeBackgroundTaskWake(rt)
    rt.autonomousTurn = { pendingToolCallIds: new Set() }
    rt.busy = true
    rt.desc.busy = true
    rt.emitter.emit("busy", true)
    rt.desc.awaitingInput = false
    rt.desc.awaitingQuestion = undefined
    releaseBlockedOn(rt.desc)
    clearStalledFlag(rt)
    rt.activeToolCalls = new Map()
    rt.toolCallIdsThisTurn = new Set()
    rt.toolCallsThisTurn = 0
    rt.turnStartedAtMs = Date.now()
    rt.turnHadOutput = false
    // No longer parked — same as a prompted turn start.
    if (rt.desc.pendingBgTasks !== undefined) {
      delete rt.desc.pendingBgTasks
      sessionEvents?.emit({
        type: "session:bg-tasks-cleared",
        sessionId: rt.desc.id,
        ...(rt.desc.label ? { label: rt.desc.label } : {}),
        ts: new Date().toISOString(),
      })
    }
    // Record WHY the agent is talking with nobody having prompted it — the
    // transcript would otherwise show assistant output out of nowhere.
    const note =
      settled.length > 0
        ? buildBackgroundTaskWakePrompt(settled, () => undefined)
        : "(the agent resumed on its own)"
    appendLine(rt, `\x1b[2m── ▶ [autonomous] ${note.split("\n")[0]} ──\x1b[0m`, "stdout")
    transcriptWriter.recordPrompt(rt.desc.id, note, { source: "autonomous" })
    schedulePersist()
  }

  /** Close the autonomous turn the same way a prompted one ends. */
  const endAutonomousTurn = (rt: SessionRuntime, reason: string): void => {
    const auto = rt.autonomousTurn
    if (!auto) return
    if (auto.silenceTimer) clearTimeout(auto.silenceTimer)
    rt.autonomousTurn = undefined
    for (const toolCallId of auto.pendingToolCallIds) {
      const synthetic: AgentStreamEvent = { kind: "tool-result", toolCallId, result: null, isError: false }
      transcriptWriter.recordEvent(rt.desc.id, synthetic)
      projectEvent(rt, synthetic)
    }
    const turnEnd: AgentStreamEvent = { kind: "turn-end", reason }
    transcriptWriter.recordEvent(rt.desc.id, turnEnd)
    projectEvent(rt, turnEnd)
    closeTurnStats(rt)
    rt.busy = false
    rt.desc.busy = false
    rt.emitter.emit("busy", false)
    releaseBlockedOn(rt.desc)
    rt.activeToolCalls?.clear()
    clearStalledFlag(rt)
    rt.desc.turnsCompleted = (rt.desc.turnsCompleted ?? 0) + 1
    rt.desc.lastTurnReason = reason
    if (rt.desc.lastTurnEmpty !== undefined) delete rt.desc.lastTurnEmpty
    const usage = buildUsageSnapshot(rt)
    rt.desc.usageSource = usage.source
    rt.desc.costUsd = usage.costUsd
    transcriptWriter.recordUsageSnapshot(rt.desc.id, usage)
    schedulePersist()
    sessionEvents?.emit({
      type: "session:turn-end",
      sessionId: rt.desc.id,
      awaitingInput: rt.desc.awaitingInput ?? false,
      label: rt.desc.label,
      ts: new Date().toISOString(),
      reason,
      autonomous: true,
    })
    // A turn nobody prompted grows the context just like a prompted one: the
    // policy must run here too, or a session that only wakes itself walks past
    // every threshold unnoticed.
    void evaluateContextContinuity(rt)
      .catch(() => undefined)
      .finally(() => dispatchQueuedPrompt(rt))
  }

  const armAutonomousSilenceClose = (rt: SessionRuntime): void => {
    const auto = rt.autonomousTurn
    if (!auto) return
    if (auto.silenceTimer) clearTimeout(auto.silenceTimer)
    auto.silenceTimer = setTimeout(
      () => endAutonomousTurn(rt, "watchdog-timeout"),
      auto.pendingToolCallIds.size > 0
        ? AUTONOMOUS_SILENCE_CLOSE_WITH_TOOLS_MS
        : AUTONOMOUS_SILENCE_CLOSE_MS
    )
    auto.silenceTimer.unref?.()
  }

  /** One event the agent emitted with no prompt in flight. */
  const handleOutOfTurnEvent = (rt: SessionRuntime, evt: AgentStreamEvent): void => {
    if (rt.desc.status !== "running") return
    if (evt.kind === "usage_update") evt = normalizeUsageFrame(rt, evt)
    if (
      AUTONOMOUS_WORK_KINDS.has(evt.kind) &&
      !rt.busy &&
      (autonomousReopenHoldUntil.get(rt.desc.id) ?? 0) <= Date.now()
    ) {
      beginAutonomousTurn(rt)
    }
    const auto = rt.autonomousTurn
    if (auto && evt.toolCallId) {
      if (evt.kind === "tool-call") auto.pendingToolCallIds.add(evt.toolCallId)
      else if (evt.kind === "tool-result") auto.pendingToolCallIds.delete(evt.toolCallId)
    }
    transcriptWriter.recordEvent(rt.desc.id, evt)
    projectEvent(rt, evt)
    if (!auto) return
    // The cycle's closing result frame: claude-agent-acp reports every
    // result's cost (tagged `origin: task-notification` for this lane).
    if (evt.kind === "usage_update" && evt.cost) endAutonomousTurn(rt, "completed")
    else armAutonomousSilenceClose(rt)
  }

  /** Stamp `desc.capabilities` from the agent session just attached.
   *  `commandsSupported` uses `steer` presence alone (not `steeringSupported`,
   *  which is a separate ACP extension a harness can decline) as the ACP-arm
   *  signal — only `createAcpProtocolArm` wires a `steer` method onto
   *  `AgentSessionLike`; the print and proprietary arms never do. */
  const stampCapabilities = (rt: SessionRuntime): void => {
    const isAcpArm = rt.agentSession?.steer !== undefined
    const steering = isAcpArm && rt.agentSession?.steeringSupported === true
    if (
      rt.desc.capabilities?.steering === steering &&
      rt.desc.capabilities?.commandsSupported === isAcpArm
    ) {
      return
    }
    rt.desc.capabilities = { steering, commandsSupported: isAcpArm }
    schedulePersist()
  }

  /**
   * (Re)subscribe the registry to the live agent session's out-of-turn
   * events. Called wherever `rt.agentSession` is (re)bound. A new agent
   * process owns none of the old one's background tasks or cycle, so both
   * are reset.
   */
  const bindOutOfTurnEvents = (rt: SessionRuntime): void => {
    releaseOutOfTurnEvents(rt)
    delete rt.desc.backgroundTasks
    const session = rt.agentSession
    if (!session?.onOutOfTurnEvent) return
    rt.outOfTurnUnsubscribe = session.onOutOfTurnEvent(evt => {
      if (rt.agentSession !== session) return
      try {
        handleOutOfTurnEvent(rt, evt)
      } catch (err) {
        console.warn(
          `[sessions] ${rt.desc.id}: out-of-turn event (${evt.kind}) failed:`,
          err instanceof Error ? err.message : err
        )
      }
    })
  }

  /** Drop the subscription, the pending wake and any open autonomous
   *  turn's timer — for a session whose agent process is going away. */
  const releaseOutOfTurnEvents = (rt: SessionRuntime): void => {
    rt.outOfTurnUnsubscribe?.()
    rt.outOfTurnUnsubscribe = undefined
    takeBackgroundTaskWake(rt)
    if (rt.autonomousTurn?.silenceTimer) clearTimeout(rt.autonomousTurn.silenceTimer)
    if (rt.autonomousTurn) {
      rt.autonomousTurn = undefined
      rt.busy = false
    }
    autonomousReopenHoldUntil.delete(rt.desc.id)
  }

  /**
   * Structured-question answer handlers, keyed by the exact option string a
   * question declared (case-insensitive). Only options with a registered
   * handler here are intercepted as answers — anything else (including a
   * driver-reported `agent-prompt`'s dynamic options, e.g. a tool
   * permission's "allow"/"deny") falls through to a normal turn unchanged,
   * so this dispatch can't regress conversational replies to prompts it
   * doesn't know about.
   */
  const STRUCTURED_QUESTION_HANDLERS: Record<
    string,
    (rt: SessionRuntime, pct: number | null) => Promise<void>
  > = {
    "continue-fresh": async rt => {
      await performContextContinueFresh(rt)
    },
    "keep-going": async (rt, pct) => {
      rt.desc.awaitingInput = false
      rt.desc.awaitingQuestion = undefined
      // Remember the pct this was acknowledged at so `evaluateContextContinuity`
      // doesn't immediately re-ask on the very next turn-boundary check — see
      // `SessionDescriptor.contextContinuityAckedAtPct`'s doc.
      if (pct !== null) rt.desc.contextContinuityAckedAtPct = pct
      appendLine(rt, `[context] user chose keep-going at ${pct ?? "?"}%`, "stdout")
      schedulePersist()
    },
  }

  interface StructuredQuestionAnswerMatch {
    question: SessionAwaitingQuestion
    matched: string
    handler: (rt: SessionRuntime, pct: number | null) => Promise<void>
  }

  /**
   * Synchronous match check, deliberately split out from
   * `answerStructuredQuestion` below: every prompt-turn seam (`sendPrompt`,
   * `enqueuePrompt`, `dispatchQueuedPrompt`) calls this on EVERY prompt, not
   * just answers, and `runAgentTurn` stamps `busy = true` synchronously as
   * its very first statement. An `async` matcher — even one that returns
   * `false` without ever hitting an internal `await` — still costs the
   * caller one microtask tick to `await`, since calling any `async`
   * function always returns a not-yet-settled promise. Tests that assert
   * `busy` flips true after exactly one `await Promise.resolve()` (see
   * `prompt-queue.test.ts`) would silently see it one tick later than
   * before. Keeping the common "no question to answer" path fully
   * synchronous preserves that timing.
   */
  const matchStructuredQuestionAnswer = (
    rt: SessionRuntime,
    message: unknown,
  ): StructuredQuestionAnswerMatch | undefined => {
    if (!rt.desc.awaitingInput) return undefined
    const question = rt.desc.awaitingQuestion
    if (!question || question.source !== "structured" || !question.options?.length) return undefined
    if (typeof message !== "string") return undefined
    const trimmed = message.trim().toLowerCase()
    const matched = question.options.find(o => o.toLowerCase() === trimmed)
    if (!matched) return undefined
    const handoffHarness = parseHandoffOption(matched)
    const handler = handoffHarness
      ? (r: SessionRuntime) => performContextHandoff(r, handoffHarness)
      : STRUCTURED_QUESTION_HANDLERS[matched.toLowerCase()]
    if (!handler) return undefined
    return { question, matched, handler }
  }

  /**
   * Runs the matched handler for a structured-question answer and emits the
   * `session:awaiting-question-answered` event. Split from the sync matcher
   * above so callers only pay for the `await` once a real answer is found.
   * Shared by every prompt seam (`sendPrompt`, `enqueuePrompt`,
   * `dispatchQueuedPrompt`) so `agent_prompt`, the HTTP prompt route, and
   * the CLI all get this for free without a new tool.
   */
  const answerStructuredQuestion = async (
    rt: SessionRuntime,
    { question, matched, handler }: StructuredQuestionAnswerMatch,
  ): Promise<void> => {
    const pct = computeContextPct(rt.desc.contextSize, rt.desc.contextUsed)
    sessionEvents?.emit({
      type: "session:awaiting-question-answered",
      sessionId: rt.desc.id,
      answer: matched,
      question,
      ...(rt.desc.label ? { label: rt.desc.label } : {}),
      ts: new Date().toISOString(),
    })
    await handler(rt, pct)
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

  const registry: SessionsRegistry = {
    bootId,
    transcriptBaseDir,
    flushSessionIndexes() {
      flushDirtyIndexes()
    },
    recordAutoContinue(id) {
      const rt = sessions.get(id)
      if (!rt) return
      rt.desc.autoContinueAttempts = (rt.desc.autoContinueAttempts ?? 0) + 1
      rt.desc.lastAutoContinueBoot = bootId
      schedulePersist()
    },
    spawn(input) {
      const id = input.id ?? `sess_${randomUUID().slice(0, 8)}`
      if (sessions.has(id)) {
        throw new Error(`sessions.spawn: id "${id}" already in use`)
      }
      const env = { ...process.env, ...(input.env ?? {}) }
      // Filter out Node bookkeeping that confuses subprocesses.
      delete env.NODE_OPTIONS
      // Session identity — assigned AFTER the caller-env merge above, per
      // the rule at SESSION_ID_ENV's doc: `POST /sessions` forwards a
      // caller-supplied `env`, so this must be last or a caller could spoof
      // its own id (or hand a child its parent's).
      env[SESSION_ID_ENV] = id
      env[WORKSPACE_SLUG_ENV] = input.workspaceSlug
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
        ...(input.detached ? { detached: true } : {}),
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
        ...(input.origin ? { origin: input.origin } : {}),
        ...(input.keepAlive ? { keepAlive: true } : {}),
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
      writeIndexNow(rt)
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
        ...(input.origin ? { origin: input.origin } : {}),
        ...(input.argv ? { argv: input.argv } : {}),
        ...(input.cwd ? { cwd: input.cwd, ...worktreeFields(input.cwd) } : {}),
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
      writeIndexNow(rt)
      return desc
    },
    spawnAgent(input) {
      const id = input.id ?? mintSessionId()
      const priorCommandSessionId = findPriorCommandSessionId(sessions, input.cwd)
      const restartPolicy = effectiveRestartPolicy(input)
      // The human handle. Derivation is frozen (PLAN §2): slugify the first
      // present of title || label || adapterSlug || kind, de-duped against
      // every session the registry currently holds. `id` is the fallback tail
      // when the input slugifies to empty.
      const slug = mintSlug(
        input.title || input.label || input.adapterSlug || "agent-cli",
        candidate => isSlugTaken(candidate),
        id,
      )
      const desc: SessionDescriptor = {
        id,
        kind: "agent-cli",
        slug,
        workspaceSlug: input.workspaceSlug,
        command: input.commandPreview ?? `${input.adapterSlug} (agent)`,
        pid: input.agentSession.pid ?? null,
        status: "running", // driver already started the session
        startedAt: new Date().toISOString(),
        cwd: input.cwd,
        ...worktreeFields(input.cwd),
        ...(input.worktreeAutoProvisioned ? { worktreeAutoProvisioned: true } : {}),
        adapterSlug: input.adapterSlug,
        ...(input.resumable !== undefined ? { resumable: input.resumable } : {}),
        ...(input.nativeTerminalResume !== undefined
          ? { nativeTerminalResume: input.nativeTerminalResume }
          : {}),
        harness: input.harness ?? input.adapterSlug,
        ...(input.routeSelection !== undefined
          ? { routeSelection: input.routeSelection }
          : {}),
        ...(input.adapterProvider !== undefined
          ? { adapterProvider: input.adapterProvider }
          : {}),
        ...(input.modelDerivedApiKey !== undefined
          ? { modelDerivedApiKey: input.modelDerivedApiKey }
          : {}),
        // ACP-level session id — sticks across daemon restart so
        // `agentproto sessions restart <id>` can pass it as
        // `resumeSessionId` and the adapter reattaches to the prior
        // conversation rather than starting blank.
        adapterSessionId: input.agentSession.sessionId,
        ...(input.label ? { label: input.label } : {}),
        // Correlation key of the work (crash resume): a relaunch naming the
        // same task id resumes THIS session's checkpoint.
        ...(input.taskId ? { taskId: input.taskId } : {}),
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
        // Persist the resolved skills list, whether or not this adapter
        // consumes it (see `SessionDescriptor.skills`'s doc).
        ...(input.skills && input.skills.length > 0 ? { skills: input.skills } : {}),
        // Persist the delivered imported-skill folders so restart/lazy-resume
        // re-deliver the same set (see `SessionDescriptor.sessionSkills`).
        ...(input.sessionSkills && input.sessionSkills.length > 0
          ? { sessionSkills: input.sessionSkills }
          : {}),
        // Persist the system-prompt text so restart/fresh-continuation can
        // re-apply it (see `SessionDescriptor.appendSystemPrompt`).
        ...(input.appendSystemPrompt !== undefined
          ? { appendSystemPrompt: input.appendSystemPrompt }
          : {}),
        ...(input.bundles && input.bundles.length > 0 ? { bundles: input.bundles } : {}),
        // Persist the isolated-config location so restart/lazy-resume can
        // hand the respawned adapter the SAME dir (native-resume store).
        ...(input.adapterConfigDir ? { adapterConfigDir: input.adapterConfigDir } : {}),
        // Parent attribution + depth (orchestrator WP4). Depth is always
        // recorded (defaults to 0) so subtree/depth logic never has to
        // distinguish "absent" from "root".
        ...(input.parentSessionId
          ? { parentSessionId: input.parentSessionId }
          : {}),
        // The relay TOKEN stays in memory (see `remoteParentFields`) - the
        // descriptor (and therefore the persisted row) carries only the
        // parent session id and the relay URL.
        ...remoteParentFields(input.remoteParent, id),
        ...(input.notifyParentOnCrash ? { notifyParentOnCrash: true } : {}),
        ...(input.sentinelAutoWatch === false ? { sentinelAutoWatch: false } : {}),
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
        // Device-sandbox identity mapping (BOOTSTRAP P7a) — rides the same
        // `...desc` persistence every other field does, so it survives a
        // daemon restart.
        ...(input.hostSessionId ? { hostSessionId: input.hostSessionId } : {}),
        ...(input.hostFingerprint ? { hostFingerprint: input.hostFingerprint } : {}),
        ...(input.sandboxProvider ? { sandboxProvider: input.sandboxProvider } : {}),
        ...(input.sandboxConfig ? { sandboxConfig: input.sandboxConfig } : {}),
        ...(input.sandboxTeardown ? { sandboxTeardown: input.sandboxTeardown } : {}),
        ...(input.sandboxPauseAfterIdleMs !== undefined
          ? { sandboxPauseAfterIdleMs: input.sandboxPauseAfterIdleMs }
          : {}),
        ...(input.sandboxDeliveryTarget ? { sandboxDeliveryTarget: input.sandboxDeliveryTarget } : {}),
        ...(input.sandboxCheckpointOverride !== undefined
          ? { sandboxCheckpointOverride: input.sandboxCheckpointOverride }
          : {}),
        ...(input.sandboxPorts ? { sandboxPorts: input.sandboxPorts } : {}),
        ...(input.commandSandbox ? { commandSandbox: input.commandSandbox } : {}),
        // Descriptor echo of the hold flag (it also lands on the runtime,
        // below): what `session_restart` / `session_continue_fresh` read to
        // keep a held session in hold, and what summaries report.
        ...(input.permissionHold ? { permissionHold: true } : {}),
        ...(input.appServe ? { appServe: input.appServe } : {}),
        // Restart lineage (see SessionDescriptor.resumedFrom's doc). `resumeVia`
        // can legitimately be "" (a fresh fallback spawn with no continuity),
        // so it's gated on `!== undefined` rather than truthiness — a truthy
        // gate would silently drop the empty-string case.
        ...resumeLineage(input.resumedFrom),
        ...(input.resumeVia !== undefined ? { resumeVia: input.resumeVia } : {}),
        ...(restartPolicy ? { restartPolicy } : {}),
        ...(input.turnRetry ? { turnRetry: input.turnRetry } : {}),
        ...(input.clerkHook ? { clerkHook: input.clerkHook } : {}),
        ...(input.contextContinuity ? { contextContinuity: input.contextContinuity } : {}),
        ...(input.keepAlive ? { keepAlive: true } : {}),
      }
      // Seed the window from the catalog so the first turn doesn't show the
      // adapter's inferred size (see context-window.ts) — a no-op for models
      // the catalog doesn't know.
      resetContextWindowForModel(desc, desc.model)
      if (input.trace ?? opts?.langfuseTracingDefault ?? false) {
        tracedSessions.add(id)
      }
      const rt: SessionRuntime = {
        desc,
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
      linkContinuedTo(input.resumedFrom, id)
      // Bind the agent session onto `rt` BEFORE the consumers below that read
      // `rt.agentSession` (`bindOutOfTurnEvents`, `stampCapabilities`,
      // `armUsageRefresh`). `bindAgentSession` is the single place that
      // assignment — and the transport-death watcher — is made, so binding
      // here keeps main's ordering: a connection that already died fires the
      // watcher synchronously and the row is correctly reported dead from the
      // start, rather than these consumers silently no-op'ing on an unbound
      // `rt.agentSession`.
      bindAgentSession(rt, input.agentSession)
      bindOutOfTurnEvents(rt)
      stampCapabilities(rt)
      // Live usage refresh for reader-equipped adapters (hermes/opencode/
      // sandbox) — armUsageRefresh is a no-op when no reader was wired.
      armUsageRefresh(rt)
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
      writeIndexNow(rt)
      recordConversationLink(rt)
      // Stamp the transcript path on the spawn response itself — the
      // caller shouldn't have to wait for a get() to learn WHERE the
      // durable transcript lands (same base dir the writer uses).
      desc.eventsPath = sessionEventsPath(desc.id, transcriptBaseDir)
      // Same read-time stamp a get() applies, so the spawn response itself
      // reports the live modes + spawn-enforced postures — a host proxying
      // this session from a sandbox reads them off this response.
      stampLiveModes(desc, rt)
      stampLiveConfigOptions(desc, rt)
      // Fire-and-forget the initial prompt (if any). Errors land in
      // the ring buffer + bump status to "error" but don't reject
      // the spawn — the descriptor was already returned.
      if (input.initialPrompt) {
        // A spawn with a recorded parent got its opening prompt FROM that
        // parent (agent_start), so attribute the turn to it — same
        // provenance shape as an agent_prompt-injected turn.
        void runAgentTurn(
          rt,
          input.initialPrompt,
          {
            ...(desc.parentSessionId
              ? { promptSource: `agent:${desc.parentSessionId}` }
              : {}),
            ...(input.initialPromptSystem ? { system: input.initialPromptSystem } : {}),
          }
        ).catch(err => {
          appendLine(
            rt,
            `[turn error] ${err instanceof Error ? err.message : String(err)}`,
            "stderr"
          )
        })
      }
      return desc
    },
    spawnAgentPending(input) {
      const id = input.id ?? mintSessionId()
      const priorCommandSessionId = findPriorCommandSessionId(sessions, input.cwd)
      const restartPolicy = effectiveRestartPolicy(input)
      const desc: SessionDescriptor = {
        id,
        kind: "agent-cli",
        workspaceSlug: input.workspaceSlug,
        command: `${input.adapterSlug} (provisioning)`,
        pid: null,
        status: "starting",
        startedAt: new Date().toISOString(),
        cwd: input.cwd,
        ...worktreeFields(input.cwd),
        ...(input.worktreeAutoProvisioned ? { worktreeAutoProvisioned: true } : {}),
        adapterSlug: input.adapterSlug,
        harness: input.harness ?? input.adapterSlug,
        ...(input.routeSelection !== undefined
          ? { routeSelection: input.routeSelection }
          : {}),
        ...(input.adapterProvider !== undefined
          ? { adapterProvider: input.adapterProvider }
          : {}),
        ...(input.modelDerivedApiKey !== undefined
          ? { modelDerivedApiKey: input.modelDerivedApiKey }
          : {}),
        ...(input.label ? { label: input.label } : {}),
        // Correlation key of the work (crash resume), same rule as
        // `spawnAgent`: a relaunch naming this task id resumes the session.
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.label ? { renamedByUser: false } : {}),
        ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
        ...(input.skills && input.skills.length > 0 ? { skills: input.skills } : {}),
        ...(input.sessionSkills && input.sessionSkills.length > 0
          ? { sessionSkills: input.sessionSkills }
          : {}),
        ...(input.appendSystemPrompt !== undefined
          ? { appendSystemPrompt: input.appendSystemPrompt }
          : {}),
        ...(input.adapterConfigDir ? { adapterConfigDir: input.adapterConfigDir } : {}),
        ...(input.parentSessionId
          ? { parentSessionId: input.parentSessionId }
          : {}),
        // The relay TOKEN stays in memory (see `remoteParentFields`) - the
        // descriptor (and therefore the persisted row) carries only the
        // parent session id and the relay URL.
        ...remoteParentFields(input.remoteParent, id),
        ...(input.notifyParentOnCrash ? { notifyParentOnCrash: true } : {}),
        ...(input.sentinelAutoWatch === false ? { sentinelAutoWatch: false } : {}),
        ...(input.origin ? { origin: input.origin } : {}),
        depth: input.depth ?? 0,
        ...(input.meta ? { meta: { ...input.meta } } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.auth ? { auth: input.auth } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        ...(input.posture !== undefined ? { posture: input.posture } : {}),
        ...(input.route ? { route: input.route } : {}),
        ...(input.contextProfile ? { contextProfile: input.contextProfile } : {}),
        ...(input.accessProfile ? { accessProfile: input.accessProfile } : {}),
        ...(priorCommandSessionId ? { priorCommandSessionId } : {}),
        ...(input.remote ? { remote: true } : {}),
        ...(input.sandboxId ? { sandboxId: input.sandboxId } : {}),
        // Device-sandbox identity mapping (BOOTSTRAP P7a) — same rule as
        // `spawnAgent` (the pending path settles through `spawnAgent`, but
        // recording it here keeps a placeholder accurate too).
        ...(input.hostSessionId ? { hostSessionId: input.hostSessionId } : {}),
        ...(input.hostFingerprint ? { hostFingerprint: input.hostFingerprint } : {}),
        ...(input.sandboxProvider ? { sandboxProvider: input.sandboxProvider } : {}),
        ...(input.sandboxConfig ? { sandboxConfig: input.sandboxConfig } : {}),
        ...(input.sandboxTeardown ? { sandboxTeardown: input.sandboxTeardown } : {}),
        ...(input.sandboxPauseAfterIdleMs !== undefined
          ? { sandboxPauseAfterIdleMs: input.sandboxPauseAfterIdleMs }
          : {}),
        ...(input.sandboxDeliveryTarget ? { sandboxDeliveryTarget: input.sandboxDeliveryTarget } : {}),
        ...(input.sandboxCheckpointOverride !== undefined
          ? { sandboxCheckpointOverride: input.sandboxCheckpointOverride }
          : {}),
        ...(input.sandboxPorts ? { sandboxPorts: input.sandboxPorts } : {}),
        ...(input.commandSandbox ? { commandSandbox: input.commandSandbox } : {}),
        // Descriptor echo of the hold flag (it also lands on the runtime,
        // below): what `session_restart` / `session_continue_fresh` read to
        // keep a held session in hold, and what summaries report.
        ...(input.permissionHold ? { permissionHold: true } : {}),
        ...resumeLineage(input.resumedFrom),
        ...(input.resumeVia !== undefined ? { resumeVia: input.resumeVia } : {}),
        ...(restartPolicy ? { restartPolicy } : {}),
        ...(input.turnRetry ? { turnRetry: input.turnRetry } : {}),
        ...(input.clerkHook ? { clerkHook: input.clerkHook } : {}),
        ...(input.contextContinuity ? { contextContinuity: input.contextContinuity } : {}),
        ...(input.keepAlive ? { keepAlive: true } : {}),
      }
      // Seed the window from the catalog so the first turn doesn't show the
      // adapter's inferred size (see context-window.ts) — a no-op for models
      // the catalog doesn't know.
      resetContextWindowForModel(desc, desc.model)
      if (input.trace ?? opts?.langfuseTracingDefault ?? false) {
        tracedSessions.add(id)
      }
      const rt: SessionRuntime = {
        desc,
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
        ...(input.permissionHold ? { permissionHold: true } : {}),
        ...(input.onCancel ? { provisionCancel: input.onCancel } : {}),
      }
      // Provisioning is under way from the first instant: the cheap prep
      // (`git worktree add`) runs unthrottled, so the row starts as `running`
      // in the `worktree` phase and flips to `queued` only if the heavy
      // segment has to wait for a slot.
      desc.provisioning = { state: "running", phase: "worktree", startedAt: desc.startedAt }
      rt.emitter.setMaxListeners(50)
      sessions.set(id, rt)
      // `continuedTo` on the prior row is stamped by `settlePendingAgent` once
      // this placeholder actually provisions — a failed provision must not
      // leave the old row pointing at a successor that never came up.
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
        `── ${input.adapterSlug} agent session provisioning (cwd ${input.cwd}) ──`,
        "stdout"
      )
      schedulePersist()
      writeIndexNow(rt)
      desc.eventsPath = sessionEventsPath(desc.id, transcriptBaseDir)
      return desc
    },
    reportProvisioning(id, progress) {
      const rt = sessions.get(id)
      const ts = new Date().toISOString()
      if (rt && rt.desc.status === "starting") {
        const startedAt = rt.desc.provisioning?.startedAt ?? rt.desc.startedAt
        if (progress.kind === "queued") {
          rt.desc.provisioning = {
            state: "queued",
            position: progress.position,
            phase: progress.phase,
            startedAt,
          }
        } else if (progress.kind === "done") {
          delete rt.desc.provisioning
        } else {
          rt.desc.provisioning = { state: "running", phase: progress.phase, startedAt }
        }
        schedulePersist()
      }
      sessionEvents?.emit({
        type: "session:provisioning",
        sessionId: id,
        kind: progress.kind,
        ...(progress.kind !== "done" ? { phase: progress.phase } : {}),
        ...(progress.kind === "queued" ? { position: progress.position } : {}),
        ...(progress.kind === "done" ? { outcome: progress.outcome } : {}),
        ...(rt?.desc.label ? { label: rt.desc.label } : {}),
        ts,
      })
    },
    settlePendingAgent(id, outcome) {
      const rt = sessions.get(id)
      if (rt && rt.desc.status !== "starting") {
        // Already resolved by something else (an operator killed it mid-
        // provision, e.g.) — never resurrect a terminal descriptor.
        if (outcome.ok) void outcome.agentSession.close().catch(() => undefined)
        return
      }
      if (!rt) {
        // Row removed entirely (shouldn't happen — "starting" is GC-exempt).
        if (outcome.ok) void outcome.agentSession.close().catch(() => undefined)
        return
      }
      // Provisioning finished (ok or not): nothing left to cancel or report.
      rt.provisionCancel = undefined
      delete rt.desc.provisioning
      if (!outcome.ok) {
        rt.desc.status = "error"
        rt.desc.lastError = outcome.message
        rt.desc.endedAt = new Date().toISOString()
        rt.emitter.emit("status", rt.desc.status)
        appendLine(rt, `[error] ${outcome.message}`, "stderr")
        schedulePersist()
        emitExited(rt)
        return
      }
      bindAgentSession(rt, outcome.agentSession)
      bindOutOfTurnEvents(rt)
      stampCapabilities(rt)
      rt.readUsage = outcome.readUsage
      rt.desc.cwd = outcome.cwd
      Object.assign(rt.desc, worktreeFields(outcome.cwd))
      rt.desc.pid = outcome.agentSession.pid ?? null
      rt.desc.adapterSessionId = outcome.agentSession.sessionId
      rt.desc.command = outcome.commandPreview ?? `${rt.desc.adapterSlug} (agent)`
      if (outcome.resumable !== undefined) rt.desc.resumable = outcome.resumable
      if (outcome.nativeTerminalResume !== undefined) {
        rt.desc.nativeTerminalResume = outcome.nativeTerminalResume
      }
      rt.desc.status = "running"
      rt.emitter.emit("status", rt.desc.status)
      linkContinuedTo(rt.desc.resumedFrom, id)
      // The reader just arrived — arm the live-usage poller now that the
      // session is actually running (a "starting" row would never poll).
      armUsageRefresh(rt)
      appendLine(
        rt,
        `── ${rt.desc.adapterSlug} agent session ${outcome.agentSession.sessionId} (cwd ${outcome.cwd}) ──`,
        "stdout"
      )
      schedulePersist()
      // Write point 1/3 (deferred): cwd/adapterSlug/adapterSessionId only
      // became known now — same reasoning as `spawnAgent`'s own call.
      writeIndexNow(rt)
      recordConversationLink(rt)
      // Fire-and-forget the initial prompt (if any) — deferred here,
      // specifically, so it never dispatches into a tree that wasn't built
      // yet (see `settlePendingAgent`'s doc).
      if (outcome.initialPrompt) {
        // Same parent attribution as `spawnAgent`'s own initial-prompt fire.
        void runAgentTurn(
          rt,
          outcome.initialPrompt,
          {
            ...(rt.desc.parentSessionId
              ? { promptSource: `agent:${rt.desc.parentSessionId}` }
              : {}),
            ...(outcome.initialPromptSystem ? { system: outcome.initialPromptSystem } : {}),
          }
        ).catch(err => {
          appendLine(
            rt,
            `[turn error] ${err instanceof Error ? err.message : String(err)}`,
            "stderr"
          )
        })
      }
    },
    spawnPty(input) {
      if (!ptyFactory) {
        throw new Error(
          "sessions.spawnPty: no PTY factory configured (node-pty optional dep missing in the daemon)"
        )
      }
      const id = `sess_${randomUUID().slice(0, 8)}`
      // A terminal's human handle is minted from a caller-supplied `name`
      // (the legacy `--name`/`terminal_start.name`, still the most explicit
      // request), else the display `label`, else the classified provider
      // slug, else `terminal`. Deduped with `-2`, `-3`, … against every LIVE
      // session the registry holds; a DEAD holder's handle is reclaimed so
      // `stop X && terminal --name X` round-trips. The shared `mintSlug`
      // replaces the old terminal-only guard — a colliding name no longer
      // throws; it just gets the next free suffix. Computed after
      // `conversationSlug` below.
      const [bin, ...args] = input.argv
      if (!bin) {
        throw new Error("sessions.spawnPty: argv must include a binary")
      }
      // node-pty forces its own minimal env unless we forward — pass
      // process.env merged with caller overrides. The factory layer
      // also forces TERM=xterm-256color so alt-screen apps render.
      const env = { ...(process.env as Record<string, string>), ...(input.env ?? {}) }
      delete env.NODE_OPTIONS
      // Scrub AFTER the override merge so an explicit `input.env` key always
      // wins over a same-named scrub entry — see `unsetEnv`'s doc.
      for (const key of input.unsetEnv ?? []) {
        if (!(input.env && key in input.env)) delete env[key]
      }
      // Session identity — same assign-last rule as spawn() above
      // (SESSION_ID_ENV's doc): `POST /sessions/terminal` also forwards a
      // caller-supplied `env`.
      env[SESSION_ID_ENV] = id
      env[WORKSPACE_SLUG_ENV] = input.workspaceSlug
      const pty: PtyProcess = ptyFactory({
        command: bin,
        args,
        cwd: input.cwd,
        env,
        cols: input.cols,
        rows: input.rows,
      })
      const priorCommandSessionId = findPriorCommandSessionId(sessions, input.cwd)
      // Conversation-terminal identity (one row, two views): a native
      // provider TUI launch (harness "Terminal" button, `terminal_start`
      // with a NATIVE_LAUNCH_ARGV argv) gets its adapter slug stamped from
      // the shared classifier table, so the Sessions list, the link probe,
      // and a later harness switch all know WHICH provider this PTY is.
      // `nativeTerminalResume` mirrors what the resume-strategy table can
      // actually do for that slug (a declared native TUI resume argv).
      // Plain shells derive nothing and stay exactly as before. The
      // adapterSessionId stays UNSET on purpose — it is unknown until the
      // provider writes a transcript or prints a resume hint.
      const conversationSlug = conversationTerminalSlugFor({ argv: input.argv })
      const conversationStore = conversationSlug ? CONVERSATION_STORES[conversationSlug] : undefined
      // A provider-native RESUME launch (`claude --resume <id|/abs/….jsonl>`,
      // e.g. session_restart's pty-native branch) already names its
      // conversation — seed the identity from the argv instead of leaving
      // the link probe to re-discover (and possibly mis-bind) it. The
      // path form's uuid is its basename.
      const resumeArgvId = (() => {
        if (!conversationStore) return undefined
        for (let i = 0; i < input.argv.length - 1; i++) {
          if (
            input.argv[i] !== "--resume" && input.argv[i] !== "-r" &&
            !(conversationSlug === "opencode" && (input.argv[i] === "--session" || input.argv[i] === "-s"))
          ) continue
          const raw = input.argv[i + 1]!
          const base = raw.slice(raw.lastIndexOf("/") + 1)
          return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : raw
        }
        return undefined
      })()
      // The isolated provider config dir, when the caller threaded it into
      // the PTY's env (`configDirEnvVar` — the pty-native restart path does)
      // — recorded on the descriptor so a LATER restart / index write / fs
      // probe resolves the SAME isolated store this PTY actually writes to.
      const conversationConfigDir =
        conversationStore?.configDirEnvVar && input.env
          ? input.env[conversationStore.configDirEnvVar]
          : undefined
      // The handle this spawn wants. `stop X && terminal --name X` must
      // round-trip: a DEAD holder's handle is free to reuse, so reclaim it
      // (clearing the new `slug` and any legacy `name`) before minting, and
      // only LIVE holders count as taken. `mintSlug` with an always-false
      // predicate yields the bare slugified base (no de-dup), which is what
      // we compare a holder against. Live collisions still append `-2`, `-3`.
      const rawSlug = input.slug || input.name || input.label || conversationSlug || "terminal"
      const baseSlug = mintSlug(rawSlug, () => false, id)
      for (const rt of sessions.values()) {
        if (getSlug(rt.desc) !== baseSlug) continue
        const status = rt.desc.status
        if (status === "running" || status === "starting") continue
        rt.desc.slug = undefined
        rt.desc.name = undefined
      }
      const slug = mintSlug(rawSlug, candidate => isSlugTaken(candidate), id)
      const desc: SessionDescriptor = {
        id,
        kind: "terminal",
        slug,
        workspaceSlug: input.workspaceSlug,
        command: [bin, ...args].map(quoteArg).join(" "),
        pid: pty.pid,
        status: "running",
        startedAt: new Date().toISOString(),
        pty: true,
        argv: input.argv,
        cwd: input.cwd,
        ...worktreeFields(input.cwd),
        ...(input.label ? { label: input.label } : {}),
        // Same rule as spawnAgent: a NEW spawn's label is a slug, not a
        // human rename — let a later derived title outrank it.
        ...(input.label ? { renamedByUser: false } : {}),
        ...(conversationSlug ? { adapterSlug: conversationSlug } : {}),
        ...(conversationSlug && RESUME_STRATEGIES[conversationSlug]?.spawnArgs
          ? { nativeTerminalResume: true }
          : {}),
        ...(conversationConfigDir ? { adapterConfigDir: conversationConfigDir } : {}),
        ...(resumeArgvId && conversationStore
          ? {
              adapterSessionId: resumeArgvId,
              resumeMetadata: { [conversationStore.storeAs]: resumeArgvId },
            }
          : {}),
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
        ...resumeLineage(input.resumedFrom),
        ...(input.resumeVia !== undefined ? { resumeVia: input.resumeVia } : {}),
        // Carried so a LATER `pty-plain` restart of THIS row can still
        // replay the same extra env (see `ptyResumeEnv`'s doc) — the only
        // record of it once this row is no longer an agent-cli descriptor.
        ...(input.env && Object.keys(input.env).length > 0
          ? { ptyResumeEnv: input.env }
          : {}),
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
        ...(isConversationTerminal(desc) ? { conversationTerminal: true } : {}),
      }
      rt.emitter.setMaxListeners(50)
      sessions.set(id, rt)
      linkContinuedTo(input.resumedFrom, id)
      // Lineage-attribution signal (WP-R3) — same rule as spawnAgent above.
      sessionEvents?.emit({
        type: "session:spawned",
        sessionId: id,
        ...(desc.parentSessionId ? { parentSessionId: desc.parentSessionId } : {}),
        ...(desc.label ? { label: desc.label } : {}),
        depth: desc.depth ?? 0,
        ts: new Date().toISOString(),
      })
      // Watch for the provider's native transcript so this PTY becomes a
      // LINKED conversation (id + index row + derived title) — see
      // `startConversationTerminalLinkProbe`'s doc. No-op for plain shells
      // and for classified-but-storeless TUIs (grok). A resume launch
      // already knows its conversation (seeded above): record the link
      // now instead of probing.
      if (rt.conversationTerminal) {
        if (desc.adapterSessionId) recordConversationLink(rt)
        else startConversationTerminalLinkProbe(rt)
      }
      pty.onData((chunk: string) => {
        // node-pty emits utf-8 strings. Convert once at the boundary
        // so the ring buffer + emitter consumers all see Buffer.
        const buf = Buffer.from(chunk, "utf8")
        // Track bracketed-paste mode (\x1b[?2004h/l) from the PTY's own
        // OUTPUT stream — see scanBracketedPaste's doc. Read back by
        // writeTerminalInput's caller (terminal_input) to decide whether
        // multi-line `text` needs the \x1b[200~…\x1b[201~ wrapper.
        rt.bracketedPaste = scanBracketedPaste(
          rt.bracketedPaste ?? { mode: "unknown", carry: "" },
          buf
        )
        appendBytes(rt, buf)
      })
      pty.onExit(evt => {
        // An operator-targeted kill() already flipped status to "killed"
        // BEFORE calling pty.kill() — see kill()'s own ordering comment.
        // Anything else exiting with a nonzero code or a signal is the
        // process dying on its own, e.g. a `claude --resume <id>` that
        // rejected the id and quit before ever reaching a turn — nothing
        // targeted it, so it must never read as the misleadingly-benign
        // "exited". Surface it the same way markCrashed() does for a dead
        // agent-cli process: status:"error" + a readable `lastError` + a
        // real daemon.log line, so a restart that dies before its first
        // turn is loudly diagnosable instead of a silent, empty transcript.
        const wasKilled = rt.desc.status === "killed"
        const abnormal = !wasKilled && (evt.exitCode !== 0 || (evt.signal ?? 0) !== 0)
        if (!wasKilled) {
          rt.desc.status = abnormal ? "error" : "exited"
        }
        rt.desc.endedAt = new Date().toISOString()
        if (typeof evt.exitCode === "number") rt.desc.exitCode = evt.exitCode
        if (abnormal) {
          const signalPart = evt.signal ? `, signal ${evt.signal}` : ""
          const tail = terminalOutputTail(rt)
          rt.desc.lastError = tail
            ? `pty exited with code ${evt.exitCode}${signalPart}: ${tail}`
            : `pty exited with code ${evt.exitCode}${signalPart} — no output captured`
          console.error(
            `[session ${rt.desc.id}] pty '${rt.desc.command}' exited abnormally ` +
              `(code=${evt.exitCode}${signalPart}): ${rt.desc.lastError}`,
          )
        }
        rt.emitter.emit("exit", evt)
        rt.emitter.emit("status", rt.desc.status)
        void terminalTranscriptWriter.close(rt.desc.id)
        schedulePersist()
        emitExited(rt)
      })
      schedulePersist()
      writeIndexNow(rt)
      return desc
    },
    recordCommand(input) {
      const id = input.id ?? `sess_${randomUUID().slice(0, 8)}`
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
        ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
        depth: input.depth ?? 0,
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
      // guarantee on their own. Tracked (not bare-`void`) so
      // `settlePendingWrites()` can drain it — see `pendingWrites`.
      trackWrite(
        writeCommandLogEntry(
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
            ...(input.timedOut ? { timedOut: true } : {}),
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
        // The provenance stamp can land after the session already ended —
        // fold the PR into its recorded outcome (a richer write replaces).
        if (rt.desc.outcome) recordOutcome(rt)
        // Sentinel auto-link (AIP-60 §6/step 4) — fires exactly once per
        // NEWLY-recorded PR, regardless of which lane recorded it
        // (command_execute's stamper and both pr-provenance-reconciler.ts
        // lanes all funnel through this same registry call). Best-effort:
        // a throwing hook must never break PR-recording itself.
        try {
          opts?.onOpenedPr?.(sessionId, input, rt.desc)
        } catch (err) {
          console.warn(
            `[sessions] onOpenedPr hook failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
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
    touchExternal(input) {
      const nowIso = new Date(externalNowMs()).toISOString()
      const existing = sessions.get(input.id)
      if (existing) {
        const desc = existing.desc
        if (desc.kind !== "external") return undefined
        // A deliberately ended row (operator kill / retire) stays ended.
        const deliberate = desc.endedReason !== undefined || isRetired(desc)
        if (desc.status !== "running" && desc.status !== "starting" && !deliberate) {
          desc.status = "running"
          delete desc.endedAt
        }
        desc.lastSeenAt = nowIso
        if (input.host && !desc.externalHost) desc.externalHost = input.host
        schedulePersist()
        return desc
      }
      if (!input.host) return undefined
      const desc: SessionDescriptor = {
        id: input.id,
        kind: "external",
        workspaceSlug: "",
        command: `${input.host} (external session)`,
        pid: null,
        status: "running",
        startedAt: nowIso,
        lastSeenAt: nowIso,
        externalHost: input.host,
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
      rt.emitter.setMaxListeners(50)
      sessions.set(input.id, rt)
      schedulePersist()
      return desc
    },
    async sendPrompt(id, message, opts) {
      const rtPre = sessions.get(id)
      if (rtPre) assertCompactionAllowed(rtPre, message, opts?.source, "sendPrompt")
      // Same mid-turn arm as enqueuePrompt: cancel + await settle BEFORE
      // admission, so `validateAgentTurn` finds the session idle instead
      // of throwing the busy rejection. Without this, `interrupt` was
      // silently dropped on the blocking path — the caller asked to
      // redirect the session and got a 409 (or, worse, nothing).
      if (opts?.interrupt && rtPre?.busy) {
        await interruptInFlightTurn(rtPre, id, "sendPrompt", undefined, promptOriginLabel({ source: opts.source }))
      }
      if (rtPre) {
        // Synchronous gate: no extra microtask tick on the common path.
        const movedTo = needsReapedBoxMove(rtPre) ? await moveReapedBoxIfNeeded(rtPre) : undefined
        if (movedTo) return registry.sendPrompt(movedTo, message, opts)
        await maybeResumeAgent(rtPre, "daemon-restart", {
          ...(opts?.source ? { source: opts.source } : {}),
          ...(opts?.forceResume ? { force: true } : {}),
        })
      }
      const rt = validateAgentTurn(id, "sendPrompt", { compaction: isCompactPrompt(message) })
      const structuredAnswer = isChildPromptSource(opts?.source)
        ? undefined
        : matchStructuredQuestionAnswer(rt, message)
      if (structuredAnswer) {
        await answerStructuredQuestion(rt, structuredAnswer)
        return
      }
      await runAgentTurn(rt, message, {
        ...(opts?.source ? { promptSource: opts.source } : {}),
        ...(opts?.system ? { system: opts.system } : {}),
      })
    },
    async enqueuePrompt(id, message, opts) {
      const deliveredNow = (): EnqueuePromptResult => ({
        queued: false,
        delivery: "delivered",
        deliveredAt: new Date().toISOString(),
        pending: false,
      })
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
      assertCompactionAllowed(rtPre, message, opts?.source, "enqueuePrompt")
      // `interrupt` only ever changes behavior on a mid-turn session —
      // an idle session falls straight through to the normal admission
      // path below, byte-identical to `interrupt` omitted/false. Cancel
      // THEN await the turn actually settling (busy → false) BEFORE
      // `validateAgentTurn` runs, so admission is never bypassed — it's
      // only ever reached once the prior turn is genuinely over.
      const interrupted = opts?.interrupt === true && rtPre.busy
      if (interrupted) {
        await interruptInFlightTurn(
          rtPre,
          id,
          "enqueuePrompt",
          undefined,
          promptOriginLabel({ source: opts?.source, origin: opts?.origin })
        )
      }
      // Queue arm (additive, opt-in — see this method's doc comment):
      // reached only when the caller explicitly asked to queue AND the
      // session is STILL busy after the interrupt arm above (an
      // `{interrupt: true, queue: true}` pair already settled the turn,
      // so `rtPre.busy` is false here and this is skipped — interrupt
      // wins). Resolves immediately without touching admission or
      // dispatch; `dispatchQueuedPrompt` (in `runAgentTurn`'s finally)
      // is what eventually fires it.
      const envelope = opts?.envelope
      if (envelope) {
        // Sender-side trace, once, at acceptance — whichever arm delivers it.
        if (envelope.from.sessionId) {
          transcriptWriter.recordSessionMessageSent?.(envelope.from.sessionId, {
            messageId: envelope.id,
            to: envelope.to,
            kind: envelope.kind,
            urgency: envelope.urgency,
          })
        }
      }
      if (opts?.queue && (rtPre.busy || rtPre.contextRescue)) {
        // Coalesce-in-place (sentinel notices, mostly): a newer enqueue that
        // names a key an item is already waiting under REPLACES that item —
        // same id, same queue position, newest message/envelope/timestamp,
        // `coalescedCount` bumped — rather than parking a second item about
        // the same underlying thing.
        const coalesceKey = opts.coalesceKey
        const waiting = rtPre.desc.promptQueue ?? []
        if (coalesceKey !== undefined) {
          const idx = waiting.findIndex(p => p.coalesceKey === coalesceKey)
          if (idx !== -1) {
            const existing = waiting[idx]!
            const replaced: QueuedPrompt = {
              ...existing,
              message: envelope ? envelope.text : message,
              queuedAt: new Date().toISOString(),
              ...(envelope ? { envelope } : {}),
              coalesceKey,
              coalescedCount: (existing.coalescedCount ?? 1) + 1,
            }
            const next = [...waiting]
            next[idx] = replaced
            rtPre.desc.promptQueue = next
            if (envelope) emitSessionMessage(envelope)
            schedulePersist()
            return { queued: true, delivery: "queued-mid-turn", pending: true, queueId: existing.id }
          }
        }
        const steerable = opts.steer === true && !envelope && !isChildPromptSource(opts.source)
        const item: QueuedPrompt = {
          id: opts.queueId ?? `q_${randomUUID().slice(0, 8)}`,
          message: envelope ? envelope.text : message,
          queuedAt: new Date().toISOString(),
          ...(opts.source ? { source: opts.source } : {}),
          ...(opts.origin ? { origin: opts.origin } : {}),
          ...(envelope ? { envelope } : {}),
          ...(steerable ? { steer: true } : {}),
          ...(coalesceKey !== undefined ? { coalesceKey } : {}),
          ...(opts.deliverWithinMs !== undefined && opts.deliverWithinMs > 0
            ? {
                deliverBy: new Date(Date.now() + opts.deliverWithinMs).toISOString(),
                deliverVia: opts.deliverVia ?? "auto",
              }
            : {}),
        }
        if (envelope) emitSessionMessage(envelope)
        rtPre.desc.promptQueue = opts.force
          ? [item, ...(rtPre.desc.promptQueue ?? [])]
          : [...(rtPre.desc.promptQueue ?? []), item]
        schedulePersist()
        if (steerable) {
          await flushSteerableQueue(rtPre)
          const steeredAt = rtPre.steeredPromptAt?.get(item.id)
          if (steeredAt) {
            rtPre.steeredPromptAt?.delete(item.id)
            return { queued: false, delivery: "steered", deliveredAt: steeredAt, pending: false, queueId: item.id }
          }
          if (!rtPre.desc.promptQueue?.some(p => p.id === item.id)) {
            // The turn ended while the steer ran and the queue drain took it.
            return { queued: false, delivery: "delivered", deliveredAt: new Date().toISOString(), pending: false, queueId: item.id }
          }
        }
        // The ONLY path that parks the prompt behind a live turn — signal it
        // so the caller can surface the "queued, not delivered yet" hint.
        return { queued: true, delivery: "queued-mid-turn", pending: true, queueId: item.id }
      }
      const movedTo = needsReapedBoxMove(rtPre) ? await moveReapedBoxIfNeeded(rtPre) : undefined
      if (movedTo) return registry.enqueuePrompt(movedTo, message, opts)
      await maybeResumeAgent(rtPre, "daemon-restart", {
        ...(opts?.source ? { source: opts.source } : {}),
        ...(opts?.forceResume ? { force: true } : {}),
      })
      const rt = validateAgentTurn(id, "enqueuePrompt", { compaction: isCompactPrompt(message) })
      if (envelope) {
        void runMessageTurn(rt, [envelope], interrupted ? "interrupt" : "turn", opts?.source).catch(err => {
          appendLine(rtPre, `[error] ${err instanceof Error ? err.message : String(err)}`, "stderr")
        })
        return deliveredNow()
      }
      // A structured-question answer is resolved synchronously (it never
      // starts a turn — it's a flag flip, or a hand-off to a fresh session)
      // so it's awaited here even though the rest of this method is
      // fire-and-forget below. A child's report is never an answer — only
      // the human decides a structured question.
      const structuredAnswer = isChildPromptSource(opts?.source)
        ? undefined
        : matchStructuredQuestionAnswer(rt, message)
      if (structuredAnswer) {
        await answerStructuredQuestion(rt, structuredAnswer)
        return deliveredNow()
      }
      // Execution phase — fire-and-forget from here on. Errors during
      // the turn itself (network drop, child died mid-turn) land in
      // the ring buffer as `[error]` lines so the SSE consumer sees
      // them; admission already succeeded so there's nothing else to
      // report back to the original caller.
      void runAgentTurn(rt, message, opts?.source ? { promptSource: opts.source } : undefined).catch(err => {
        appendLine(
          rtPre,
          `[error] ${err instanceof Error ? err.message : String(err)}`,
          "stderr"
        )
      })
      // Admitted + dispatched now (idle session, or an interrupt that already
      // settled the prior turn) — not parked, so no queued hint.
      return deliveredNow()
    },
    sweepPendingPrompts,
    async sendMessage(msg, opts) {
      if (opts?.decision) assertDecisionAllows(opts.decision, "session.message", msg.to)
      const rt = sessions.get(msg.to)
      if (!rt) throw new Error(`sendMessage: no session "${msg.to}"`)
      expireExternalIfStale(rt)
      if (rt.desc.status !== "running" && rt.desc.status !== "starting") {
        if (isRetired(rt.desc)) {
          throw new SessionRetiredError(msg.to, rt.desc.status, "sendMessage", rt.desc.continuedTo)
        }
        throw new SessionNotAliveError(msg.to, rt.desc.status, "sendMessage")
      }
      // Waiter first — the recipient is parked in `inbox_wait` for exactly
      // this: hand it over as the tool's result, never also as a turn.
      const waiters = inboxWaiters.get(msg.to)
      const waiter = waiters?.find(w => matchesMessageFilter(msg, w.filter))
      if (waiter) {
        inboxWaiters.set(msg.to, waiters!.filter(w => w !== waiter))
        recordSent(msg)
        emitSessionMessage(msg)
        addToInbox(rt, msg)
        const [stamped] = consumeForWait(rt, [msg], waiter.ack)
        waiter.resolve([stamped!])
        return { messageId: msg.id, delivered: { via: "wait" }, queued: false, urgencyApplied: msg.urgency }
      }
      // An external session has no process to start a turn on: every tier
      // lands in its inbox (the hook / `inbox_list` pulls it from there).
      if (msg.urgency === "fyi" || rt.desc.kind === "external") {
        const parked: SessionMessage = { ...msg, delivered: { via: "inbox", at: new Date().toISOString() } }
        recordSent(parked)
        addToInbox(rt, parked)
        emitSessionMessage(parked)
        return { messageId: msg.id, delivered: { via: "inbox" }, queued: false, urgencyApplied: "fyi" }
      }
      // An un-granted interrupt never cuts a turn: the fastest thing short
      // of that is steering it in.
      const requested: MessageUrgency =
        msg.urgency === "interrupt" && opts?.allowInterrupt !== true ? "steer" : msg.urgency
      const busy = rt.busy || rt.desc.busy === true
      if (busy && requested === "steer") {
        const steered = await trySteer(rt, msg)
        if (steered) {
          return { messageId: msg.id, delivered: { via: "steer" }, queued: false, urgencyApplied: "steer" }
        }
      }
      addToInbox(rt, msg)
      const interrupt = busy && requested === "interrupt"
      const { queued } = await registry.enqueuePrompt(msg.to, msg.text, {
        envelope: msg,
        queue: true,
        ...(interrupt ? { interrupt: true } : {}),
        ...(opts?.source ? { source: opts.source } : {}),
        ...(opts?.origin ? { origin: opts.origin } : {}),
        ...(opts?.coalesceKey ? { coalesceKey: opts.coalesceKey } : {}),
      })
      return {
        messageId: msg.id,
        delivered: queued ? null : { via: interrupt ? "interrupt" : "turn" },
        queued,
        // Idle: whatever was asked for, it simply started a turn. Busy: the
        // tier that actually ran (a steer that couldn't inject is next-turn).
        urgencyApplied: !busy ? requested : interrupt ? "interrupt" : "next-turn",
      }
    },
    async waitForMessages(id, filter, opts) {
      const rt = sessions.get(id)
      if (!rt) throw new Error(`waitForMessages: no session "${id}"`)
      const ack = opts.ack !== false
      const pending = (rt.desc.inbox ?? []).filter(m => matchesMessageFilter(m, filter))
      if (pending.length) return { messages: consumeForWait(rt, pending, ack), timedOut: false }
      if (opts.signal?.aborted) return { messages: [], timedOut: false }
      const prevBlocked = rt.desc.blockedOn
      if (!prevBlocked) rt.desc.blockedOn = "inbox"
      return await new Promise<WaitForMessagesResult>(resolveWait => {
        let settled = false
        const waiter: InboxWaiter = {
          filter,
          ack,
          resolve: messages => finish({ messages, timedOut: false }),
        }
        const finish = (result: WaitForMessagesResult): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          opts.signal?.removeEventListener("abort", onAbort)
          const list = inboxWaiters.get(id)
          if (list) inboxWaiters.set(id, list.filter(w => w !== waiter))
          if (rt.desc.blockedOn === "inbox" && !prevBlocked) rt.desc.blockedOn = undefined
          resolveWait(result)
        }
        const timer = setTimeout(() => finish({ messages: [], timedOut: true }), opts.timeoutMs)
        const onAbort = (): void => finish({ messages: [], timedOut: false })
        opts.signal?.addEventListener("abort", onAbort, { once: true })
        inboxWaiters.set(id, [...(inboxWaiters.get(id) ?? []), waiter])
      })
    },
    listInbox(id, filter) {
      const rt = sessions.get(id)
      if (!rt) return null
      const matched = (rt.desc.inbox ?? []).filter(m => !filter || matchesMessageFilter(m, filter))
      return filter?.limit !== undefined ? matched.slice(-filter.limit) : matched
    },
    findReceivedMessage(id, messageId) {
      const rt = sessions.get(id)
      if (!rt) return undefined
      const inInbox = rt.desc.inbox?.find(m => m.id === messageId)
      if (inInbox) return inInbox
      // Consumed this daemon lifetime: its transcript record may still be
      // in the append stream's buffer, not on disk yet.
      const recent = rt.recentlyReceived?.find(m => m.id === messageId)
      if (recent) return recent
      let raw: string
      try {
        raw = readFileSync(sessionEventsPath(id, transcriptBaseDir), "utf8")
      } catch {
        return undefined
      }
      // Cheap pre-filter before parsing: only lines naming the id.
      for (const line of raw.split("\n")) {
        if (!line.includes(messageId) || !line.includes('"session-message"')) continue
        try {
          const rec = JSON.parse(line) as { kind?: string; message?: SessionMessage }
          if (rec.kind === "session-message" && rec.message?.id === messageId) return rec.message
        } catch {
          // torn line — skip
        }
      }
      return undefined
    },
    ackInbox(id, ids) {
      const rt = sessions.get(id)
      if (!rt) return { acked: [] }
      const inbox = rt.desc.inbox ?? []
      const target = new Set(ids === "all" ? inbox.map(m => m.id) : ids)
      const acked = inbox.filter(m => target.has(m.id)).map(m => m.id)
      const ackedSet = new Set(acked)
      removeFromInbox(rt, ackedSet)
      dropQueuedEnvelopes(rt, ackedSet)
      return { acked }
    },
    removeQueuedPrompt(id, queueId) {
      const rt = sessions.get(id)
      if (!rt?.desc.promptQueue?.length) return { removed: false }
      const next = rt.desc.promptQueue.filter(p => p.id !== queueId)
      const removed = next.length !== rt.desc.promptQueue.length
      if (removed) {
        rt.desc.promptQueue = next
        schedulePersist()
      }
      return { removed }
    },
    listQueuedPrompts(id) {
      const rt = sessions.get(id)
      if (!rt) return null
      const queue = rt.desc.promptQueue ?? []
      return queue.map((p, position) => ({
        id: p.id,
        origin: promptOriginLabel(p),
        preview: previewPrompt(p.message),
        queuedAt: p.queuedAt,
        position,
        ...(p.coalescedCount !== undefined ? { coalescedCount: p.coalescedCount } : {}),
      }))
    },
    readBackgroundTaskTail(id, taskId) {
      const rt = sessions.get(id)
      if (!rt) return null
      const task = rt.desc.backgroundTasks?.find(t => t.taskId === taskId)
      if (!task) return null
      return { task, tail: task.outputFile ? (readOutputTail(task.outputFile) ?? null) : null }
    },
    promoteQueuedPrompt(id, queueId) {
      const rt = sessions.get(id)
      const queue = rt?.desc.promptQueue
      if (!rt || !queue?.length) return { promoted: false, position: -1 }
      const idx = queue.findIndex(p => p.id === queueId)
      if (idx < 0) return { promoted: false, position: -1 }
      if (idx === 0) return { promoted: true, position: 0 }
      // Always a NEW array reference (never in-place splice) — the webview
      // diff rules on `!==` per field (see `promptQueue`'s doc).
      const item = queue[idx]!
      const rest = queue.filter(p => p !== item)
      rt.desc.promptQueue = [item, ...rest]
      schedulePersist()
      return { promoted: true, position: 0 }
    },
    async deliverQueuedPrompt(id, queueId) {
      const rt = sessions.get(id)
      const queue = rt?.desc.promptQueue
      if (!rt) return { delivered: false, reason: "no-session" }
      if (!queue?.some(p => p.id === queueId)) {
        return { delivered: false, reason: "not-in-queue" }
      }
      const wasBusy = rt.busy
      // Promote the target to front FIRST (synchronously), so that when a
      // busy turn is cancelled its `dispatchQueuedPrompt` finally drains
      // exactly this item as the new turn. On an idle session nothing is
      // running to drain it, so dispatch the promoted front directly.
      const item = queue.find(p => p.id === queueId)!
      rt.desc.promptQueue = [item, ...queue.filter(p => p.id !== queueId)]
      schedulePersist()
      if (wasBusy) {
        // Await the cancelled turn actually settling — the interruption is
        // real and delivery is imminent (its finally dispatches the target).
        await interruptInFlightTurn(rt, id, "deliverQueuedPrompt", queueId, promptOriginLabel(item))
        return { delivered: true, interrupted: true }
      }
      dispatchQueuedPrompt(rt)
      return { delivered: true, interrupted: false }
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
      if (isRetired(rt.desc)) return { status: "skipped", reason: "retired" }
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
      await maybeResumeAgent(rt, "daemon-restart", { source: "boot" })
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
      // target routes are known AND differ — bare/unparseable ids leave the
      // route unknown and fall through to a normal live switch, so this never
      // blocks a same-endpoint model change. Use the same effective-route
      // resolver as the current descriptor so router-prefixed legacy ids are
      // covered too.
      const targetRoute = resolveEffectiveRoute(modelId, undefined)
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
      // Descriptors persisted before wire-normalization metadata existed can
      // still be revived in place after a daemon restart. Hydrate their
      // adapter strategy lazily so the first subsequent live switch gets the
      // same normalization as a newly spawned session. Resolution is best-
      // effort for backward compatibility: an embedding without a resolver
      // keeps the old suffix-only fallback rather than losing live switching.
      let routeSelection = rt.desc.routeSelection
      let adapterProvider = rt.desc.adapterProvider
      let modelDerivedApiKey = rt.desc.modelDerivedApiKey
      const needsAdapterMetadata =
        routeSelection === undefined ||
        modelDerivedApiKey === undefined ||
        (routeSelection !== "derived-from-model" && adapterProvider === undefined)
      const adapterSlug = rt.desc.adapterSlug ?? rt.adapterSlug
      if (needsAdapterMetadata && resolveAgentAdapter && adapterSlug) {
        try {
          const resolved = await resolveAgentAdapter(adapterSlug)
          let hydrated = false
          if (routeSelection === undefined && resolved?.routeSelection !== undefined) {
            routeSelection = resolved.routeSelection
            rt.desc.routeSelection = routeSelection
            hydrated = true
          }
          if (
            adapterProvider === undefined &&
            resolved?.authDescriptor?.provider !== undefined
          ) {
            adapterProvider = resolved.authDescriptor.provider
            rt.desc.adapterProvider = adapterProvider
            hydrated = true
          }
          if (
            modelDerivedApiKey === undefined &&
            resolved?.authDescriptor?.modelDerivedApiKey !== undefined
          ) {
            modelDerivedApiKey = resolved.authDescriptor.modelDerivedApiKey
            rt.desc.modelDerivedApiKey = modelDerivedApiKey
            hydrated = true
          }
          if (hydrated) schedulePersist()
        } catch {
          // Preserve legacy best-effort behavior when an optional resolver is
          // temporarily unavailable; the driver still receives a suffix-free id.
        }
      }
      // Normalize the catalog model id to the adapter's wire form using the
      // same helper the spawn path uses, so live switches cannot drift.
      // Derived-from-model adapters (hermes, pi, opencode, …) keep the vendor
      // prefix and only lose the `@route` suffix; a `modelDerivedApiKey`
      // adapter among them (opencode/mastracode/jcode/pi/mastra-agent) also
      // gets the router re-added as a literal leading segment when the target
      // route is a gateway — see `ModelWireOptions.modelDerivedApiKey`'s doc.
      // Fixed native adapters get the bare product id their manifest declares.
      const wireModel = isAdvertisedLiveModel(rt, modelId)
        ? modelId
        : normalizeModelForWire(modelId, {
            routeSelection,
            gateway: rt.desc.route?.gateway,
            fixedProvider: adapterProvider,
            modelDerivedApiKey,
          })
      const result = await rt.agentSession.setModel(wireModel)
      if (result.applied) {
        // Record the CATALOG id the caller requested, not the wire form the
        // driver consumed — the descriptor echo and UI picker must stay in
        // canonical model-identity terms.
        rt.desc.model = modelId
        // The switch went through this daemon, so both facts genuinely
        // agree — mirror onto `activeModel` too (SessionDescriptor's doc)
        // rather than leaving it stale from a prior divergence.
        rt.desc.activeModel = modelId
        // The sticky window belonged to the previous model.
        resetContextWindowForModel(rt.desc, modelId)
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
            activeModel: rt.desc.activeModel,
            label: rt.desc.label,
            ts,
          })
        }
      }
      return result.applied ? { ...result, model: modelId } : result
    },
    emitHarnessWarning(sessionId, warnings, label) {
      if (warnings.length === 0) return
      sessionEvents?.emit({
        type: "session:harness-warning",
        sessionId,
        warnings: [...warnings],
        ...(label ? { label } : {}),
        ts: new Date().toISOString(),
      })
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
          enforcement: postureEnforcement(
            posture,
            rt.agentSession.availableModes ?? [],
            rt.agentSession.spawnEnforcedPostures ?? [],
          ),
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
      return {
        applied: true,
        posture,
        modeId: resolution.mode.id,
        resolution: "native",
        enforcement: "native",
      }
    },
    pulseActivity(id) {
      const rt = sessions.get(id)
      if (!rt) return
      rt.desc.lastActivityAt = new Date().toISOString()
      // Any adapter traffic disproves a "the stream died" claim — clear it
      // immediately rather than waiting for the next sweep tick.
      clearStalledFlag(rt)
      schedulePersist()
    },
    list(opts) {
      const includeArchived = opts?.includeArchived ?? false
      const childrenBusy = childrenBusyCounts()
      return Array.from(sessions.values())
        .filter(rt => includeArchived || !rt.desc.archived)
        .sort((a, b) => b.desc.startedAt.localeCompare(a.desc.startedAt))
        .map(rt => {
          const desc = rt.desc
          expireExternalIfStale(rt)
          stampReadLiveness(desc)
          stampInterrupted(desc)
          stampCurrentStatus(rt)
          stampWatchers(desc)
          stampLiveModes(desc, rt)
          stampLiveConfigOptions(desc, rt)
          stampAdapterConnected(desc, rt)
          desc.childrenBusy = childrenBusy.get(desc.id) ?? 0
          desc.queuedPrompts = desc.promptQueue?.length ?? 0
          stampPendingPrompts(desc)
          return desc
        })
    },
    listSummaries(opts) {
      const includeArchived = opts?.includeArchived ?? false
      const lane = opts?.lane
      const limit = Math.max(1, Math.min(200, opts?.limit ?? 50))
      const offset = Math.max(0, opts?.offset ?? 0)
      const childrenBusy = childrenBusyCounts()
      const hasMachineLineage = (rt: SessionRuntime): boolean => {
        const ownMachine = (desc: SessionDescriptor): boolean =>
          desc.origin === "cron" || desc.origin === "gate"
        if (ownMachine(rt.desc)) return true

        const seen = new Set<string>([rt.desc.id])
        let current = rt.desc
        while (current.parentSessionId) {
          const parent = sessions.get(current.parentSessionId)?.desc
          // Unreachable or cyclic ancestry is an Auto task, matching the webview's fallback.
          if (!parent || seen.has(parent.id)) return true
          // Shell roots are not shown in the Sessions panel; their descendants are Auto tasks.
          if (parent.kind === "terminal" || parent.kind === "command") return true
          seen.add(parent.id)
          current = parent
        }
        return ownMachine(current)
      }
      const all = Array.from(sessions.values())
        .filter(rt => includeArchived || !rt.desc.archived)
        // Inbox-only rows are not agents: they never show up in a Sessions lane.
        .filter(rt => rt.desc.kind !== "external")
        .filter(rt => {
          if (!lane) return true
          // Shells and raw commands belong to the Activity panel, not either
          // Sessions lane — but a CONVERSATION terminal (a native provider
          // TUI in a PTY, `isConversationTerminal`) is a trackable session
          // and stays in. One row, two doors: Activity keeps listing it too.
          if (isShellOnlyRow(rt.desc)) return false
          // Match the webview's lineage-aware lane classifier before paginating summary rows.
          const machine = hasMachineLineage(rt)
          return lane === "auto" ? machine : !machine
        })
        .sort((a, b) => b.desc.startedAt.localeCompare(a.desc.startedAt))
      const slice = all.slice(offset, offset + limit)
      const summaries = slice.map(rt => {
        const desc = rt.desc
        stampReadLiveness(desc)
        stampInterrupted(desc)
        stampCurrentStatus(rt)
        stampWatchers(desc)
        desc.childrenBusy = childrenBusy.get(desc.id) ?? 0
        desc.queuedPrompts = desc.promptQueue?.length ?? 0
        const summary = toSessionSummary(desc)
        // Stamp the lane verdict on EVERY summary row (not only when a lane
        // filter is set): it's this walk over the full `sessions` map that a
        // paging client cannot reproduce from its page-local view. Shell
        // rows carry no lane — they live in the Activity panel. A
        // conversation terminal is NOT a shell: it gets a lane like any
        // other session.
        if (!isShellOnlyRow(desc)) {
          summary.lane = hasMachineLineage(rt) ? "auto" : "agents"
        }
        return summary
      })
      return { summaries, total: all.length }
    },
    get(id) {
      const rt = sessions.get(id)
      const desc = rt?.desc
      if (rt && desc) {
        expireExternalIfStale(rt)
        stampReadLiveness(desc)
        stampInterrupted(desc)
        stampCurrentStatus(rt)
        stampWatchers(desc)
        stampLiveModes(desc, rt)
        stampLiveConfigOptions(desc, rt)
        stampAdapterConnected(desc, rt)
        desc.childrenBusy = childrenBusyCounts().get(desc.id) ?? 0
        desc.queuedPrompts = desc.promptQueue?.length ?? 0
        stampPendingPrompts(desc)
      }
      return desc
    },
    incWatchers(id, detail) {
      watchersById.set(id, (watchersById.get(id) ?? 0) + 1)
      if (detail) {
        const list = watcherDetailsById.get(id)
        if (list) list.push(detail)
        else watcherDetailsById.set(id, [detail])
      }
    },
    decWatchers(id, detail) {
      const next = (watchersById.get(id) ?? 0) - 1
      if (next > 0) watchersById.set(id, next)
      else watchersById.delete(id)
      if (detail) {
        const list = watcherDetailsById.get(id)
        if (list) {
          const idx = list.indexOf(detail)
          if (idx >= 0) list.splice(idx, 1)
          if (list.length === 0) watcherDetailsById.delete(id)
        }
      }
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
    recordMcpAppToolCall(sessionId, record) {
      baseTranscriptWriter.recordMcpAppToolCall(sessionId, record)
    },
    async findToolCallName(sessionId, toolCallId) {
      let raw: string
      try {
        raw = await fs.readFile(sessionEventsPath(sessionId, transcriptBaseDir), "utf8")
      } catch {
        return undefined
      }
      let name: string | undefined
      for (const line of raw.split("\n")) {
        // Cheap pre-filter: only parse lines that can be the call's record.
        if (!line.includes(toolCallId)) continue
        try {
          const rec = JSON.parse(line) as { kind?: unknown; toolCallId?: unknown; toolName?: unknown }
          if (rec.kind === "tool-call" && rec.toolCallId === toolCallId && typeof rec.toolName === "string" && rec.toolName) {
            name = rec.toolName
          }
        } catch {
          // torn / partial line
        }
      }
      return name
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
      const resolved = resolveSessionRef(
        {
          get: id => sessions.get(id)?.desc,
          list: () => Array.from(sessions.values(), rt => rt.desc),
        },
        { idOrName: query },
      )
      if (!resolved.ok) return undefined
      const rt = sessions.get(resolved.id)
      if (!rt) return undefined
      stampReadLiveness(rt.desc)
      stampInterrupted(rt.desc)
      stampCurrentStatus(rt)
      return rt.desc
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
    getBracketedPasteMode(id) {
      const rt = sessions.get(id)
      if (!rt || !rt.pty) return "unknown"
      return rt.bracketedPaste?.mode ?? "unknown"
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
    kill(id, signal = "SIGTERM", reason, outcome) {
      const rt = sessions.get(id)
      if (!rt) return false
      if (
        rt.desc.status === "exited" ||
        rt.desc.status === "killed" ||
        rt.desc.status === "error"
      ) {
        // A sandboxed row can end ERROR before its box was torn down (the
        // adapter died inside the box: `runAgentTurn` flips the row to
        // `error` and leaves the binding in place). An operator kill on that
        // row must still release the box instead of only refusing as a
        // label-only no-op. `close()` is idempotent, so a row whose teardown
        // already ran is unaffected.
        let toreDownSandbox = false
        if (isProviderBoxSession(rt.desc) && rt.agentSession) {
          const session = rt.agentSession
          delete rt.agentSession
          toreDownSandbox = true
          void session.close().catch(err => {
            const detail = err instanceof Error ? err.message : String(err)
            console.warn(
              `[sessions] ${id}: sandbox teardown on kill of an ended row failed: ${detail} — ` +
                `sandbox ${rt.desc.sandboxId} may still be running`,
            )
            appendLine(rt, `[warn] box teardown after kill failed: ${detail}`, "stderr")
          })
        }
        // Label-only: an outcome on an ended row with no end reason just
        // (re)labels the recorded outcome — nothing is retired or relabeled.
        if (outcome && reason === undefined) {
          layerDeclaredOutcome(rt, outcome)
          return true
        }
        // "Mark as completed" on an already-ended row (see
        // `markOutcomeCompleted`'s doc) — every other reason (a plain
        // "operator-stopped", or none at all) on a terminal row stays
        // exactly today's no-op refusal.
        if (reason === "operator-completed") {
          markOutcomeCompleted(rt)
          if (outcome) layerDeclaredOutcome(rt, outcome)
          retireRow(rt, "killed")
          return true
        }
        // Any other deliberate reason on a row that already ended (idle-reap,
        // crash, daemon restart) stamps the retirement after the fact instead
        // of silently no-oping — otherwise a stopped brain that had already
        // died could never be marked dead. The original `endedReason` stays
        // when there is one (it is the true cause of death); `retiredAt`
        // carries the retirement.
        if (reason && DELIBERATE_END_REASONS.has(reason)) {
          if (rt.desc.endedReason === undefined) rt.desc.endedReason = reason
          if (outcome) layerDeclaredOutcome(rt, outcome)
          retireRow(rt, "killed")
          return true
        }
        // A kill whose only effect was retrying an ended sandbox row's box
        // teardown is a real success, not a no-op refusal.
        return toreDownSandbox
      }
      // Read BEFORE the flip below — see killedMidTurn's docblock: this is
      // the one moment `busy` is still guaranteed live, not whatever it was
      // last set to by a `finally` that may never run again.
      rt.desc.killedMidTurn = rt.desc.busy === true
      rt.desc.status = "killed"
      rt.desc.endedAt = new Date().toISOString()
      // The descriptor flip is the poller's own stop signal — but clear the
      // timer here rather than letting it expire on the next tick.
      stopUsageRefresh(rt)
      if (reason) rt.desc.endedReason = reason
      // A dead row carries no live parked-with-background-tasks flag. kill()
      // doesn't run clearInFlightFlags (an idle kill has no in-flight turn to
      // unwind), so drop it here — same "no dangling flag on a dead row" rule.
      delete rt.desc.pendingBgTasks
      // Close agent session first (graceful protocol shutdown), then
      // SIGTERM the underlying child/pty if any. Either branch is a
      // best-effort — the descriptor flip is what the UI surfaces.
      if (rt.agentSession) {
        releaseOutOfTurnEvents(rt)
        delete rt.desc.backgroundTasks
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
      killChildIfSpawned(rt.child, signal)
      if (rt.browserStop) {
        void rt.browserStop().catch(() => undefined)
      }
      schedulePersist()
      // Agent-cli sessions have no OS exit event — emit here.
      // Child/PTY sessions emit from their exit handlers; the
      // exitedEmitted guard prevents a duplicate from kill() AND exit.
      emitExited(rt)
      if (outcome) layerDeclaredOutcome(rt, outcome)
      if (reason && DELIBERATE_END_REASONS.has(reason)) retireRow(rt, "killed")
      return true
    },
    closeWithOutcome(id, input) {
      const rt = sessions.get(id)
      if (!rt) return false
      // Same universe as reapIdle: a live agent-cli row only — a PTY/command/
      // terminal/browser session, or one already terminal, is never touched.
      if (rt.desc.kind !== "agent-cli") return false
      if (rt.desc.status !== "running" && rt.desc.status !== "starting") return false
      // Re-check liveness AT THE MOMENT OF THE CALL — the plan that picked
      // this session may be stale by the time this actually lands. A
      // background task (agent-reported or the turn-end heuristic) is the
      // same kind of staleness: something is still in flight, so this
      // REFUSES rather than silently dropping it.
      if (rt.desc.busy === true || rt.desc.awaitingInput === true || rt.desc.awaitingPermission === true) {
        return false
      }
      if ((rt.desc.pendingBgTasks ?? 0) > 0 || (rt.desc.backgroundTasks?.length ?? 0) > 0) return false

      // "blocked" / "needs-input" are NOT completion — the session stays
      // exactly as alive as it was, and the verdict is recorded as a flag
      // instead of a termination. Only "done"/"abandoned" actually close.
      if (input.verdict === "blocked" || input.verdict === "needs-input") {
        rt.desc.wrapupFlag = {
          verdict: input.verdict,
          ...(input.note !== undefined ? { note: input.note } : {}),
          ...(input.judgedBy !== undefined ? { judgedBy: input.judgedBy } : {}),
          ...sanitizeOutcomeDetail(input),
          at: new Date().toISOString(),
        }
        schedulePersist()
        return true
      }

      // "done" closes as finished work; every other terminal verdict
      // ("abandoned"/"partial"/"failed") closes as not-completed — the
      // Level-2 `outcome.verdict` below keeps the nuance either way.
      const reason: SessionEndReason = input.verdict === "done" ? "steward-completed" : "steward-abandoned"

      rt.desc.killedMidTurn = false // guaranteed by the busy guard above
      rt.desc.status = "killed"
      rt.desc.endedAt = new Date().toISOString()
      rt.desc.endedReason = reason
      if (rt.agentSession) {
        releaseOutOfTurnEvents(rt)
        recordExitUsageSnapshot(rt)
        void rt.agentSession.close().catch(() => undefined)
        void transcriptWriter.close(rt.desc.id)
        tracedSessions.delete(rt.desc.id)
        // THE difference from a plain kill(): clear the binding so the row is
        // lazy-resumable in this same daemon lifetime — same as reapIdle.
        rt.agentSession = undefined
      }
      killChildIfSpawned(rt.child, "SIGTERM")
      schedulePersist()
      // Derives + records the Level 1 outcome first (source:"derived") —
      // same one exit funnel every terminal path goes through.
      emitExited(rt)
      retireRow(rt, "killed")

      // Layer the Level 2 fields on top of what emitExited just derived —
      // same shared shape `resolveOutcome` uses on an already-ended row, so
      // the derived summary/artifacts/cost survive under the judged/declared
      // verdict.
      layerStewardOutcome(rt, input)
      return true
    },
    resolveOutcome(id, input) {
      const rt = sessions.get(id)
      if (!rt) return false
      // The terminal twin of closeWithOutcome, and the exact mirror of its
      // liveness guard: agent-cli rows only, and only one that has ALREADY
      // ended. A live row belongs to closeWithOutcome (which owns the
      // busy/awaiting/background-task staleness re-checks) — refusing here
      // keeps the two primitives from racing over the same row.
      if (rt.desc.kind !== "agent-cli") return false
      if (rt.desc.status !== "exited" && rt.desc.status !== "killed" && rt.desc.status !== "error") {
        return false
      }
      // "blocked" / "needs-input" mean "leave it running and wait for a
      // human" — there is no live row left to wait on, so there is nothing
      // honest to record. Same refusal closeWithOutcome would give for the
      // stale half of the contract, returned here as a plain no-op.
      if (input.verdict === "blocked" || input.verdict === "needs-input") return false

      // "done" is the operator's "this was fine": relabel the recorded
      // outcome as completed (the true death mechanism is kept in
      // `termination.previousReason`) and retire the row so no automatic
      // pass revives work an operator has already signed off on. Every other
      // verdict only layers the resolution — the termination axis stays
      // exactly what it was: status, endedReason, endedAt and exitCode are
      // never touched here, so the row still shows HOW it really died.
      if (input.verdict === "done") {
        markOutcomeCompleted(rt)
        retireRow(rt, "killed")
      }
      layerStewardOutcome(rt, input)
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
      // A busy (mid-turn) session is NEVER reapable — the sweep filters for
      // this, and the guard makes the primitive honest for any caller: a
      // turn in flight is work, not idleness, however long `lastActivityAt`
      // claims the silence has lasted (observed 2026-10-18: a sandboxed
      // session 72 tool calls into a busy turn was reaped because its
      // sandbox proxy never pulsed `lastActivityAt`, and the idle span
      // then measured from `startedAt`). Capture before refusing so the
      // `killedMidTurn` mirror below would remain honest if this were ever
      // relaxed.
      const midTurn = rt.desc.busy === true
      if (midTurn) {
        return false
      }
      // Read `busy` before the flip (see killedMidTurn's docblock) — a reap
      // only targets an idle session, so this is false in practice, but capture
      // the honest value rather than assume it.
      rt.desc.killedMidTurn = midTurn
      rt.desc.status = "killed"
      rt.desc.endedAt = new Date().toISOString()
      // The one field that makes this a REAP, not a plain kill: an automatic
      // teardown reason that (a) surfaces "reaped while idle" in the UI and (b)
      // — critically — keeps this row OUT of the eager resume-on-boot pass,
      // which gates on `endedReason === "daemon-restart"`. A reaped row must
      // never join a boot-time resume-storm of dead work.
      rt.desc.endedReason = "idle-reaped"
      if (rt.agentSession) {
        releaseOutOfTurnEvents(rt)
        delete rt.desc.backgroundTasks
        // Durable usage recap on exit — before close() flushes the stream.
        recordExitUsageSnapshot(rt)
        // A sandboxed row's close() is what ends the BOX: the proxy runs a
        // final checkpoint, tears the box down per its lifecycle policy and
        // stamps the ledger. Failure is surfaced, not swallowed: a box that
        // survives its reaped session is exactly the leak this exists to stop.
        const sandboxedBox = isProviderBoxSession(rt.desc)
        const teardown = rt.agentSession
          .close(sandboxedBox ? { idleReap: { idleMs, sessionId: rt.desc.id } } : undefined)
          .catch(err => {
            if (!sandboxedBox) return
            const detail = err instanceof Error ? err.message : String(err)
            console.warn(
              `[idle-reaper] closing the box of reaped session "${rt.desc.id}" ` +
                `(sandbox ${rt.desc.sandboxId}) failed: ${detail} — it may still be running`,
            )
            appendLine(rt, `[warn] box teardown after idle reap failed: ${detail}`, "stderr")
          })
        if (sandboxedBox) rt.reapTeardown = teardown
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
      killChildIfSpawned(rt.child, "SIGTERM")
      schedulePersist()
      const banner = isProviderBoxSession(rt.desc)
        ? "── reaped after being idle past the sandbox threshold; its box was torn " +
          "down (paused instead when its work was not checkpointed). Re-prompt to " +
          "continue on the paused box, or a fresh one restored from the last checkpoint. ──"
        : "── reaped after being idle past the threshold; the adapter process was " +
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
    markCrashed(id, reason = "process-gone") {
      return markCrashedInternal(id, reason)
    },
    markSandboxExpired(id, detail) {
      return markSandboxExpiredInternal(id, detail)
    },
    markStalled(id, stalledSinceMs) {
      const rt = sessions.get(id)
      if (!rt) return false
      // Only a LIVE, mid-turn, unblocked agent-cli row is stall-markable —
      // same defensive shape as reapIdle/markCrashed's guards, kept honest
      // for any caller regardless of what the sweep already filtered for.
      if (rt.desc.kind !== "agent-cli" || rt.desc.status !== "running") return false
      if (rt.desc.busy !== true || rt.desc.blockedOn !== undefined) return false
      // Tool call in flight (e.g. a long `pnpm install` announced by a tool
      // name `classifyBlockedOn` never maps into `blockedOn`) — expected
      // silence, never a stall; same exclusion the sweep makes on the
      // descriptor's stamped `currentPhase` (`tool-call:<name>`, derived
      // from this very map), so the two layers cannot disagree.
      if (rt.activeToolCalls !== undefined && rt.activeToolCalls.size > 0) return false
      if (rt.desc.stalledSinceMs !== undefined) return false
      rt.desc.stalledSinceMs = stalledSinceMs
      // A turn that has produced NOTHING at all since its prompt and gone
      // silent is a provider stuck retrying, not a slow one — give it a
      // readable reason instead of only `stalledSinceMs` (the live incident:
      // opencode swallowing a 429 into an internal retry loop forever). A
      // turn that streamed output/usage first keeps the pre-existing
      // stalled-only behavior.
      if (rt.turnHadOutput !== true) {
        rt.desc.lastTurnErroredAt = new Date().toISOString()
        rt.desc.lastTurnErrorMessage = NO_OUTPUT_STALL_TURN_ERROR
      }
      schedulePersist()
      sessionEvents?.emit({
        type: "session:stalled",
        sessionId: rt.desc.id,
        stalledSinceMs,
        ...(rt.desc.label ? { label: rt.desc.label } : {}),
        ts: new Date().toISOString(),
      })
      return true
    },
    clearStalled(id) {
      const rt = sessions.get(id)
      if (!rt) return false
      const wasFlagged = rt.desc.stalledSinceMs !== undefined
      clearStalledFlag(rt)
      return wasFlagged
    },
    isResuming(id) {
      return !!sessions.get(id)?.resumePromise
    },
    async triggerResume(id, opts) {
      const rt = sessions.get(id)
      if (!rt) return false
      try {
        await maybeResumeAgent(rt, "restarted", {
          source: "restart",
          ...(opts?.force ? { force: true } : {}),
        })
      } catch (err) {
        // Retired rows never revive: drop the landed schedule so the sweep
        // stops re-picking this row every tick.
        if (err instanceof SessionRetiredError && rt.desc.nextRestartAt !== undefined) {
          delete rt.desc.nextRestartAt
          schedulePersist()
        }
        // ResumeDisabledError (MAX_RESUME_ATTEMPTS burned) or an adapter
        // throw — either way this row stays dead; the sweep just moves on to
        // the next candidate rather than aborting the whole tick.
      }
      return !!rt.agentSession
    },
    applyRestartSchedule(id, update) {
      const rt = sessions.get(id)
      if (!rt) return false
      rt.desc.nextRestartAt = update.nextRestartAt
      rt.desc.restartAttempts = update.restartAttempts
      rt.desc.recentRestartAts = update.recentRestartAts
      rt.desc.lastRestartAt = update.lastRestartAt
      if (update.freshBox === true) rt.desc.nextRestartFreshBox = true
      else delete rt.desc.nextRestartFreshBox
      schedulePersist()
      return true
    },
    giveUpRestart(id, message) {
      const rt = sessions.get(id)
      if (!rt) return false
      delete rt.desc.nextRestartAt
      delete rt.desc.nextRestartFreshBox
      appendLine(rt, message, "stderr")
      transcriptWriter.recordEvent(rt.desc.id, { kind: "notice", text: message })
      return true
    },
    async triggerSandboxGoneRestart(id) {
      const rt = sessions.get(id)
      if (!rt) return false
      // Consume the schedule up front: whatever the hook does, this row must
      // never be re-picked for the same `nextRestartAt` on a later sweep tick
      // (on success the row is a retired corpse; on failure retrying is the
      // crash-loop the policy's cap exists to stop).
      const prevRestart = {
        ...(rt.desc.restartAttempts !== undefined
          ? { restartAttempts: rt.desc.restartAttempts }
          : {}),
        ...(rt.desc.recentRestartAts ? { recentRestartAts: rt.desc.recentRestartAts } : {}),
        ...(rt.desc.lastRestartAt ? { lastRestartAt: rt.desc.lastRestartAt } : {}),
      }
      delete rt.desc.nextRestartAt
      delete rt.desc.nextRestartFreshBox
      const blocked = (detail: string): false => {
        appendLine(
          rt,
          `[sandbox-gone] cannot move this session to a fresh box: ${detail} — ` +
            "leaving it dead; fix the cause and `session_restart` it manually.",
          "stderr",
        )
        transcriptWriter.recordEvent(rt.desc.id, {
          kind: "notice",
          text:
            `[sandbox-gone] cannot move this session to a fresh box: ${detail} — ` +
            "leaving it dead; fix the cause and `session_restart` it manually.",
        })
        schedulePersist()
        return false
      }
      if (!restartSandboxGoneHook) {
        return blocked("this daemon has no fresh-box restart wiring (no sandbox provider/adapter resolvers)")
      }
      let outcome: Awaited<ReturnType<NonNullable<typeof restartSandboxGoneHook>>>
      try {
        outcome = await restartSandboxGoneHook({ sessionId: id, prev: rt.desc })
      } catch (err) {
        return blocked(err instanceof Error ? err.message : String(err))
      }
      if (!outcome.ok) return blocked(outcome.blocker)
      // Carry the rolling restart window onto the fresh row so the policy's
      // `maxRetries`/`windowMs` crash-loop cap keeps counting across moves —
      // without this, every successful move would mint a row with a clean
      // window and a dying box could bounce forever.
      const fresh = sessions.get(outcome.newSessionId)
      if (fresh && Object.keys(prevRestart).length > 0) {
        if (prevRestart.restartAttempts !== undefined) {
          fresh.desc.restartAttempts = prevRestart.restartAttempts
        }
        if (prevRestart.recentRestartAts) fresh.desc.recentRestartAts = prevRestart.recentRestartAts
        if (prevRestart.lastRestartAt) fresh.desc.lastRestartAt = prevRestart.lastRestartAt
      }
      schedulePersist()
      return true
    },
    patchTurnRetry(id, patch) {
      const rt = sessions.get(id)
      if (!rt) return false
      for (const key of ["turnRetryAttempts", "turnMigrations", "lastTurnRetryAt", "nextTurnRetryAt"] as const) {
        if (!(key in patch)) continue
        const value = patch[key]
        if (value === null || value === undefined) delete rt.desc[key]
        else (rt.desc as unknown as Record<string, unknown>)[key] = value
      }
      schedulePersist()
      return true
    },
    recordNotice(id, text) {
      const rt = sessions.get(id)
      if (!rt || rt.desc.kind !== "agent-cli") return false
      appendLine(rt, text, "stdout")
      transcriptWriter.recordEvent(rt.desc.id, { kind: "notice", text })
      return true
    },
    recordSandboxDelivery(id, record, notice) {
      const rt = sessions.get(id)
      if (!rt || rt.desc.kind !== "agent-cli") return false
      rt.desc.sandboxDelivery = record
      // The teardown delivery can be the LAST checkpoint of the session (it
      // snapshots the uncommitted work too): the session keeps the link to
      // it, exactly like the periodic checkpoint above.
      const deliveryCheckpoint = checkpointRefFromRecord(record, {
        sessionId: id,
        ...(rt.desc.label ? { label: rt.desc.label } : {}),
        ...(rt.desc.taskId ? { taskId: rt.desc.taskId } : {}),
      })
      if (deliveryCheckpoint) rt.desc.lastCheckpoint = deliveryCheckpoint
      appendLine(rt, notice, "stdout")
      transcriptWriter.recordEvent(rt.desc.id, { kind: "notice", text: notice })
      // Delivery runs during teardown, after kill() already closed the writer,
      // so the record above reopened an append stream nothing else will end.
      void transcriptWriter.close(rt.desc.id)
      // Teardown notice above lands in THIS (now-dead) session's own
      // transcript — nobody's next turn reads that. When uncommitted work
      // stayed in the box, tell the PARENT explicitly, same in-band channel
      // `supervisor-notify.ts` uses for a crash notice.
      const rescue = formatUncommittedRescueNotice(record)
      const parentId = rt.desc.parentSessionId
      if (rescue !== undefined && parentId && parentId !== rt.desc.id && sessions.has(parentId)) {
        void registry
          .sendMessage(
            createSessionMessage({
              to: parentId,
              from: { relation: "system" },
              kind: "notice",
              urgency: "next-turn",
              text: rescue,
              data: { kind: "sandbox-uncommitted-work", sessionId: rt.desc.id, ref: record.checkpoint?.ref },
            }),
            { source: `sandbox:${rt.desc.id}`, origin: `sandbox:${rt.desc.id}` },
          )
          .catch(() => {})
      }
      schedulePersist()
      return true
    },
    recordSandboxCheckpoint(id, record, notice) {
      const rt = sessions.get(id)
      if (!rt || rt.desc.kind !== "agent-cli") return false
      rt.desc.sandboxCheckpoint = record
      // CRASH RESUME - the session remembers the checkpoint it just took:
      // the ref of the snapshot on the remote, so a relaunch (a restart or a
      // new spawn linked to this session) restores THAT snapshot instead of
      // starting from main. Written here, where the checkpoint is created,
      // so the link can never drift from the checkpoint itself.
      const checkpointRef = checkpointRefFromRecord(record, {
        sessionId: id,
        ...(rt.desc.label ? { label: rt.desc.label } : {}),
        ...(rt.desc.taskId ? { taskId: rt.desc.taskId } : {}),
      })
      if (checkpointRef) rt.desc.lastCheckpoint = checkpointRef
      const touchedRemote =
        record.push.status !== "skipped" ||
        record.checkpoint !== undefined ||
        record.bundle.status !== "skipped"
      if (!record.unchanged && touchedRemote) {
        appendLine(rt, notice, "stdout")
        transcriptWriter.recordEvent(rt.desc.id, { kind: "notice", text: notice })
      }
      schedulePersist()
      return true
    },
    setSandboxDeliveryTarget(id, target) {
      const rt = sessions.get(id)
      if (!rt || rt.desc.kind !== "agent-cli") return false
      rt.desc.sandboxDeliveryTarget = target
      schedulePersist()
      return true
    },
    appendDeviceMirrorRecords(id, records) {
      const rt = sessions.get(id)
      if (!rt || rt.desc.kind !== "agent-cli" || !rt.desc.hostSessionId) return 0
      baseTranscriptWriter.recordMirrorEvents(rt.desc.id, records)
      return records.length
    },
    scanDeviceMirrorState(id) {
      // Same per-line scanner `highestSeqOnDisk` (transcript-writer.ts) uses —
      // one read, two projections. The path is derived from THIS registry's
      // own transcript base dir so tests with an injected `transcriptDir`
      // never disagree with the device-mirror module's reads.
      let raw: string
      try {
        raw = readFileSync(sessionEventsPath(id, transcriptBaseDir), "utf8")
      } catch {
        return { cursor: 0, localPromptTexts: [] as string[] }
      }
      let cursor = 0
      const localPromptTexts: string[] = []
      for (const line of raw.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let rec: Record<string, unknown>
        try {
          rec = JSON.parse(trimmed) as Record<string, unknown>
        } catch {
          continue
        }
        if (rec["origin"] === "device") {
          const hostSeq = rec["hostSeq"]
          if (typeof hostSeq === "number" && Number.isFinite(hostSeq) && hostSeq > cursor) cursor = hostSeq
        } else if (rec["kind"] === "user-prompt" && typeof rec["text"] === "string" && rec["text"].length > 0) {
          localPromptTexts.push(rec["text"] as string)
        }
      }
      return { cursor, localPromptTexts }
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
      rt.desc.archivedAt = new Date().toISOString()
      schedulePersist()
      retireRow(rt, "archived")
      stampReadLiveness(rt.desc)
      return rt.desc
    },
    markRetired(id, opts) {
      const rt = sessions.get(id)
      if (!rt) return undefined
      retireRow(rt, opts?.cause ?? "killed", opts?.continuedTo)
      return rt.desc
    },
    onSessionRetired(listener) {
      retiredListeners.add(listener)
      return () => {
        retiredListeners.delete(listener)
      }
    },
    unarchiveSession(id) {
      const rt = sessions.get(id)
      if (!rt) throw new Error(`unarchiveSession: no session "${id}"`)
      rt.desc.archived = false
      delete rt.desc.archivedAt
      schedulePersist()
      stampReadLiveness(rt.desc)
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
        if (opts.forget) {
          retireRow(rt, "forgotten")
          sessions.delete(id)
        } else {
          rt.desc.archived = true
          retireRow(rt, "archived")
        }
        ids.push(id)
      }
      if (ids.length > 0) schedulePersist()
      return { mode: opts.forget ? "forgotten" : "archived", ids, count: ids.length }
    },
    forgetSession(id) {
      const rt = sessions.get(id)
      if (!rt) return "missing"
      const st = rt.desc.status
      if (st === "running" || st === "starting") return "alive"
      retireRow(rt, "forgotten")
      sessions.delete(id)
      schedulePersist()
      return "forgotten"
    },
    pruneSessionDirs(pruneOpts) {
      const defaults = opts?.sessionRetention ?? {}
      const reviewMaxAgeDays =
        pruneOpts?.reviewMaxAgeDays !== undefined ? pruneOpts.reviewMaxAgeDays : defaults.reviewMaxAgeDays
      const maxAgeDays = pruneOpts?.maxAgeDays !== undefined ? pruneOpts.maxAgeDays : defaults.maxAgeDays
      return runSessionRetentionPass({
        baseDir: transcriptBaseDir,
        registry,
        ...(reviewMaxAgeDays !== undefined ? { reviewMaxAgeDays } : {}),
        ...(maxAgeDays !== undefined ? { maxAgeDays } : {}),
        ...(pruneOpts?.dryRun ? { dryRun: true } : {}),
        ...(pruneOpts?.onlyIds ? { onlyIds: pruneOpts.onlyIds } : {}),
      })
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
      // `slug` is the addressable human handle, not a display field — set it
      // through the shared minter so the override stays unique (a collision
      // gets `-2`, never a throw). Clearing reverts to no slug (the legacy
      // `name` alias, if any, still resolves via `getSlug`).
      if (patch.slug !== undefined) {
        const rawSlug = patch.slug === null ? "" : patch.slug.trim()
        rt.desc.slug =
          rawSlug === ""
            ? undefined
            : mintSlug(rawSlug, candidate => isSlugTaken(candidate, rt.desc.id), rt.desc.id)
      }
      // This IS the explicit-user-rename write-path (both callers —
      // `PATCH /sessions/:id` and the `session_rename` MCP verb — are
      // human-driven). Flag it so a user's `label` outranks the derived
      // `title` in `sessionDisplayName`; a spawn `label`, set by `spawnAgent`
      // with `renamedByUser: false`, does not. Only the DISPLAY fields feed
      // that chain, so a slug-only override deliberately leaves the flag (and
      // the displayed name) untouched.
      if (patch.title !== undefined || patch.label !== undefined) rt.desc.renamedByUser = true
      schedulePersist()
      // Announce it so a live UI repaints the name without waiting for its
      // next snapshot poll — same bus every other lifecycle event rides.
      // Fields are included only when set, so a clear reads as "absent" the
      // same way the descriptor now does.
      sessionEvents?.emit({
        type: "session:renamed",
        sessionId: id,
        ...(rt.desc.slug !== undefined ? { slug: rt.desc.slug } : {}),
        ...(rt.desc.title !== undefined ? { title: rt.desc.title } : {}),
        ...(rt.desc.label !== undefined ? { label: rt.desc.label } : {}),
        renamedByUser: rt.desc.renamedByUser === true,
        ts: new Date().toISOString(),
      })
      stampReadLiveness(rt.desc)
      // A rename is a write-path event — refresh the sidecar immediately so
      // `sessions find` by the new label resolves at once.
      writeIndexNow(rt)
      return rt.desc
    },
    setKeepAlive(id, keepAlive) {
      const rt = sessions.get(id)
      if (!rt) throw new Error(`setKeepAlive: no session "${id}"`)
      rt.desc.keepAlive = keepAlive
      schedulePersist()
      stampReadLiveness(rt.desc)
      return rt.desc
    },
    mergeMeta(id, patch) {
      const rt = sessions.get(id)
      if (!rt) throw new Error(`mergeMeta: no session "${id}"`)
      rt.desc.meta = { ...rt.desc.meta, ...patch }
      schedulePersist()
      stampReadLiveness(rt.desc)
      return rt.desc
    },
    async refreshAgentRole(id, opts) {
      const rt = sessions.get(id)
      if (!rt) return { ok: false, code: "no_session", message: `refreshAgentRole: no session "${id}"` }
      const agentManifestPath = rt.desc.meta?.agentManifestPath
      if (!agentManifestPath) {
        return {
          ok: false,
          code: "not_manifest_spawned",
          message:
            `refreshAgentRole: session "${id}" was not spawned from an AGENT.md ` +
            "(no `meta.agentManifestPath`) — nothing to refresh.",
        }
      }
      const diff = await computeAgentRoleRefresh({
        agentManifestPath,
        // Mirrors spawn's OWN resolution (`input.harness ?? input.adapter`,
        // session-spawn.ts) exactly — `harness` is the canonical axis name,
        // falling back to `adapterSlug` for a row that never set it
        // (session-spawn.ts's own doc on `SessionDescriptor.harness`).
        // Re-rendering with a DIFFERENT adapter slug than the one spawn used
        // could project the manifest through a different system-prompt
        // channel / skill-delivery capability and report a spurious change.
        adapter: rt.desc.harness ?? rt.desc.adapterSlug ?? "",
        ...(rt.desc.model !== undefined ? { model: rt.desc.model } : {}),
        ...(rt.desc.meta?.agentRoleHash !== undefined ? { previousRoleHash: rt.desc.meta.agentRoleHash } : {}),
        ...(rt.desc.meta?.agentToolsHash !== undefined ? { previousToolsHash: rt.desc.meta.agentToolsHash } : {}),
        ...(resolveAgentAdapter ? { resolveAgentAdapter } : {}),
      })
      if (!diff.ok) return diff
      if (opts?.dryRun) {
        return {
          ok: true,
          roleChanged: diff.roleChanged,
          toolsChanged: diff.toolsChanged,
          roleHash: diff.roleHash,
          toolsHash: diff.toolsHash,
          warnings: diff.warnings,
        }
      }
      let delivered: { via: MessageDeliveryVia } | undefined
      if (diff.roleChanged && diff.roleText !== undefined) {
        if (rt.desc.status !== "running" && rt.desc.status !== "starting") {
          return {
            ok: false,
            code: "session_not_alive",
            message: `refreshAgentRole: session "${id}" is ${rt.desc.status}, not running — nothing to steer.`,
          }
        }
        const result = await registry.sendMessage(
          createSessionMessage({
            to: id,
            from: { relation: "system" },
            kind: "notice",
            urgency: "steer",
            text: renderRoleUpdateNotice(diff.roleText),
            data: { kind: "agent-role-refresh", roleHash: diff.roleHash },
          }),
          { source: "agent-role-refresh", origin: "agent-role-refresh" },
        )
        if (result.delivered) delivered = result.delivered
        // The role is now live — advance the baseline. `agentToolsHash` is
        // deliberately left at its PRIOR value when toolsChanged: the tools
        // ask has NOT taken effect (stdio MCP servers are fixed at spawn),
        // so a later refresh should keep reporting the drift until an
        // actual restart re-baselines it.
        registry.mergeMeta(id, { agentRoleHash: diff.roleHash })
      }
      return {
        ok: true,
        roleChanged: diff.roleChanged,
        toolsChanged: diff.toolsChanged,
        roleHash: diff.roleHash,
        toolsHash: diff.toolsHash,
        ...(delivered ? { delivered } : {}),
        warnings: diff.warnings,
      }
    },
    setAgentRoleWatch(id, enabled) {
      const rt = sessions.get(id)
      if (!rt) return false
      if (!enabled) return stopAgentRoleWatch(id)
      const agentManifestPath = rt.desc.meta?.agentManifestPath
      if (!agentManifestPath) return false
      // Starting twice replaces the first watcher rather than stacking two.
      stopAgentRoleWatch(id)
      // Watch the PARENT DIRECTORY, not the file itself: most editors
      // (VS Code, vim, emacs) save via write-temp + rename, which replaces
      // the file's inode. A watch on the file's own path dies silently at
      // that rename (no `error` event — it's just detached from an inode
      // nothing points to anymore), so every edit after the FIRST save
      // would otherwise go unnoticed. A directory watch survives the
      // file being replaced underneath it; `filename` filters out every
      // other entry in the directory.
      const dir = dirname(agentManifestPath)
      const base = basename(agentManifestPath)
      const state: AgentRoleWatchState = { watcher: null as unknown as FSWatcher, debounce: null }
      const scheduleRefresh = (): void => {
        if (state.debounce) clearTimeout(state.debounce)
        state.debounce = setTimeout(() => {
          state.debounce = null
          void registry.refreshAgentRole(id).catch(err => {
            console.warn(
              `[sessions] agent-role-watch refresh failed for ${id}: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
          })
        }, AGENT_ROLE_WATCH_DEBOUNCE_MS)
      }
      try {
        // `fs.watch` throws synchronously (ENOENT) when `dir` doesn't exist
        // (e.g. the manifest's directory was removed after spawn) — caught
        // so this returns the documented `false` instead of throwing out of
        // the MCP tool.
        state.watcher = watchFsPath(dir, (_event, filename) => {
          // `filename` is `null` on a platform/fs that can't report it
          // (rare) — treat that as "might be ours" rather than miss it.
          if (filename !== null && String(filename) !== base) return
          scheduleRefresh()
        })
      } catch (err) {
        console.warn(
          `[sessions] agent-role-watch: could not watch "${dir}" for ${id}: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
        return false
      }
      state.watcher.on("error", err => {
        console.warn(
          `[sessions] agent-role-watch error for ${id}: ${err instanceof Error ? err.message : String(err)}`
        )
        stopAgentRoleWatch(id)
      })
      agentRoleWatchers.set(id, state)
      return true
    },
    setPinned(id, pinned) {
      const rt = sessions.get(id)
      if (!rt) throw new Error(`setPinned: no session "${id}"`)
      if (pinned) {
        if (rt.desc.pinned !== true) {
          // Append at the end of the pinned group: one past the max order over
          // the currently pinned. Legacy pins (no order yet) are numbered first,
          // in their startedAt order, so the new pin can't land ahead of them.
          let max = -1
          const legacy: SessionDescriptor[] = []
          for (const other of sessions.values()) {
            if (other.desc.pinned !== true) continue
            if (other.desc.pinnedOrder === undefined) legacy.push(other.desc)
            else if (other.desc.pinnedOrder > max) max = other.desc.pinnedOrder
          }
          legacy
            .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))
            .forEach(d => {
              d.pinnedOrder = ++max
            })
          rt.desc.pinnedOrder = max + 1
        }
        rt.desc.pinned = true
      } else {
        rt.desc.pinned = false
        delete rt.desc.pinnedOrder
      }
      schedulePersist()
      sessionEvents?.emit({
        type: "session:pinned-changed",
        sessionId: id,
        pinned,
        ts: new Date().toISOString(),
      })
      stampReadLiveness(rt.desc)
      return rt.desc
    },
    setPromptPolicy(id, allowPromptFrom) {
      const rt = sessions.get(id)
      if (!rt) throw new Error(`setPromptPolicy: no session "${id}"`)
      if (allowPromptFrom === undefined || allowPromptFrom.length === 0) {
        delete rt.desc.allowPromptFrom
      } else {
        rt.desc.allowPromptFrom = allowPromptFrom
      }
      schedulePersist()
      stampReadLiveness(rt.desc)
      return rt.desc
    },
    setOperatorLabel(id, operatorLabel) {
      const rt = sessions.get(id)
      if (!rt) throw new Error(`setOperatorLabel: no session "${id}"`)
      if (operatorLabel === undefined || operatorLabel === "") {
        delete rt.desc.operatorLabel
      } else {
        rt.desc.operatorLabel = operatorLabel
      }
      schedulePersist()
      stampReadLiveness(rt.desc)
      return rt.desc
    },
    setLineageSuccessor(fromId, toId) {
      const from = sessions.get(fromId)
      if (!from) throw new Error(`setLineageSuccessor: no session "${fromId}"`)
      const to = sessions.get(toId)
      if (!to) throw new Error(`setLineageSuccessor: no session "${toId}"`)
      if (fromId === toId) {
        throw new Error(`setLineageSuccessor: a session cannot succeed itself ("${fromId}")`)
      }
      from.desc.succeededBy = toId
      to.desc.succeeds = fromId
      schedulePersist()
      stampReadLiveness(from.desc)
      stampReadLiveness(to.desc)
      return to.desc
    },
    reassignParent(id, newParentId) {
      const rt = sessions.get(id)
      if (!rt) throw new Error(`reassignParent: no session "${id}"`)
      if (id === newParentId) {
        throw new Error(`reassignParent: a session cannot be its own parent ("${id}")`)
      }
      if (newParentId !== undefined && !sessions.has(newParentId)) {
        throw new Error(`reassignParent: no session "${newParentId}"`)
      }
      // Cycle guard: the new parent must not sit inside the moved row's own
      // subtree (walk its ancestor chain up; reaching `id` means a loop).
      if (newParentId !== undefined) {
        const seen = new Set<string>()
        let cursor: string | undefined = newParentId
        while (cursor !== undefined && !seen.has(cursor)) {
          if (cursor === id) {
            throw new Error(
              `reassignParent: "${newParentId}" is inside the subtree of "${id}", moving it there would create a cycle`,
            )
          }
          seen.add(cursor)
          cursor = sessions.get(cursor)?.desc.parentSessionId
        }
      }
      if (newParentId === undefined) {
        delete rt.desc.parentSessionId
        rt.desc.depth = 0
      } else {
        rt.desc.parentSessionId = newParentId
        const parent = sessions.get(newParentId)
        rt.desc.depth = parent?.desc.depth !== undefined ? parent.desc.depth + 1 : parent ? 1 : 0
      }
      // The whole subtree moved with the row: re-derive its depths.
      const childrenByParent = new Map<string, string[]>()
      for (const [childId, child] of sessions) {
        const pid = child.desc.parentSessionId
        if (pid === undefined) continue
        const list = childrenByParent.get(pid)
        if (list) list.push(childId)
        else childrenByParent.set(pid, [childId])
      }
      const visited = new Set<string>([id])
      const queue: string[] = [id]
      while (queue.length > 0) {
        const parentId = queue.shift()!
        const parentDepth = sessions.get(parentId)?.desc.depth ?? 0
        for (const childId of childrenByParent.get(parentId) ?? []) {
          if (visited.has(childId)) continue
          visited.add(childId)
          const child = sessions.get(childId)
          if (!child) continue
          child.desc.depth = parentDepth + 1
          queue.push(childId)
        }
      }
      schedulePersist()
      stampReadLiveness(rt.desc)
      return rt.desc
    },
    emitLineageHandover(event) {
      sessionEvents?.emit(event)
    },
    noteSessionPrompt(id, caller, queued) {
      sessionEvents?.emit({
        type: "session:prompt",
        sessionId: id,
        caller,
        queued,
        ts: new Date().toISOString(),
      })
    },
    reorderPinned(ids) {
      const seen = new Set<string>()
      for (const id of ids) {
        if (seen.has(id)) throw new Error(`reorderPinned: duplicate session id "${id}"`)
        seen.add(id)
        const rt = sessions.get(id)
        if (!rt) throw new Error(`reorderPinned: no session "${id}"`)
        if (rt.desc.pinned !== true) {
          throw new Error(`reorderPinned: session "${id}" is not pinned`)
        }
      }
      const pinned = registry.list({ includeArchived: true }).filter(s => s.pinned === true)
      const order = computePinnedOrder(pinned, ids)
      for (const s of pinned) {
        const rt = sessions.get(s.id)
        if (rt) rt.desc.pinnedOrder = order.get(s.id)
      }
      schedulePersist()
      sessionEvents?.emit({
        type: "session:pinned-reordered",
        ids: [...ids],
        ts: new Date().toISOString(),
      })
      return pinned
        .slice()
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
        .map(s => sessions.get(s.id)?.desc ?? s)
    },
    addSessionArtifact(id, input) {
      const rt = sessions.get(id)
      if (!rt) throw new Error(`addSessionArtifact: no session "${id}"`)
      const result = addSessionArtifactImpl(id, input, transcriptBaseDir)
      if (result.added) {
        sessionEvents?.emit({
          type: "session:artifact-added",
          sessionId: id,
          key: result.record.key,
          kind: result.record.kind,
          version: result.version.version,
          ...(result.record.label ? { label: result.record.label } : {}),
          ts: new Date().toISOString(),
        })
      }
      return result.record
    },
    listSessionArtifacts(id) {
      if (!sessions.get(id)) throw new Error(`listSessionArtifacts: no session "${id}"`)
      return listSessionArtifactsImpl(id, transcriptBaseDir)
    },
    getSessionArtifact(id, key, opts) {
      if (!sessions.get(id)) throw new Error(`getSessionArtifact: no session "${id}"`)
      return getSessionArtifactImpl(id, key, opts, transcriptBaseDir)
    },
    setArtifactPinned(id, key, pinned) {
      if (!sessions.get(id)) throw new Error(`setArtifactPinned: no session "${id}"`)
      const record = pinSessionArtifactImpl(id, key, pinned, transcriptBaseDir)
      if (record) {
        sessionEvents?.emit({
          type: "session:artifact-pinned-changed",
          sessionId: id,
          key,
          pinned,
          ts: new Date().toISOString(),
        })
      }
      return record
    },
    flagAwaitingInput(id, patch) {
      const rt = sessions.get(id)
      if (!rt) throw new Error(`flagAwaitingInput: no session "${id}"`)
      // Inverse of archiveSession's guard: only a LIVE session has a turn
      // that can meaningfully be "awaiting" anything — a terminal session's
      // classification is stale by definition, and there's nothing
      // downstream (session_monitor, the webhook notifier) left to observe
      // a correction on a row that's already done.
      const isAlive = rt.desc.status === "running" || rt.desc.status === "starting"
      if (!isAlive) {
        throw new Error(
          `flagAwaitingInput: session "${id}" is ${rt.desc.status}, not live — only a ` +
            "running/starting session's awaiting-input classification can be corrected."
        )
      }
      rt.desc.awaitingInput = patch.awaitingInput
      // false ALWAYS clears the question too — a question cannot outlive
      // its awaiting-input flag. `source: "structured"` because an explicit
      // human/orchestrator override is at least as authoritative as a
      // driver-reported prompt (the other "structured" producer).
      rt.desc.awaitingQuestion =
        patch.awaitingInput && patch.question !== undefined
          ? { text: patch.question, source: "structured" }
          : undefined
      schedulePersist()
      sessionEvents?.emit({
        type: "session:awaiting-input-flagged",
        sessionId: id,
        awaitingInput: patch.awaitingInput,
        reason: patch.reason,
        ...(rt.desc.awaitingQuestion ? { question: rt.desc.awaitingQuestion } : {}),
        ...(rt.desc.label ? { label: rt.desc.label } : {}),
        ts: new Date().toISOString(),
      })
      stampReadLiveness(rt.desc)
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
      // A live row gets the full kill() teardown first — close the adapter
      // (whole process tree), SIGTERM any PTY/child, stop an attached
      // browser, and emit session:exited so the exit subscribers (headless
      // browser sweep, webhooks, brain ingest) run. Dropping it from the map
      // alone left the adapter tree — and any headless Chrome — running with
      // nothing left to track it.
      if (rt.desc.status === "running" || rt.desc.status === "starting") {
        registry.kill(id)
      }
      // Don't leak: tear down the emitter so backfill listeners stop.
      rt.emitter.removeAllListeners()
      trackWrite(transcriptWriter.close(id))
      trackWrite(terminalTranscriptWriter.close(id))
      tracedSessions.delete(id)
      // Cleanup listeners read the row (to follow its `continuedTo` chain), so
      // notify BEFORE it leaves the map.
      retireRow(rt, "forgotten")
      sessions.delete(id)
      schedulePersist()
      return true
    },
    async settlePendingWrites() {
      // Drain until empty rather than awaiting a single snapshot: the
      // tracked write is itself a chain (CommandLogEntry → ToolCallRecord),
      // and a caller could enqueue another recordCommand between awaits.
      // Each tracked promise self-removes on settle, so the set shrinks to
      // empty and this terminates. Resolves immediately when nothing's
      // pending.
      while (pendingWrites.size > 0) {
        await Promise.all([...pendingWrites])
      }
    },
    async detachSandboxSessions() {
      const lifetimeRequests: Promise<void>[] = []
      let detached = 0
      for (const rt of sessions.values()) {
        if (!detachRow(rt)) continue
        detached++
        const extend = rt.agentSession?.extendDetachedLifetime
        if (extend) lifetimeRequests.push(extend.call(rt.agentSession).catch(() => undefined))
      }
      // Bounded: a slow provider API must not hold the daemon's stop hostage;
      // the box then simply keeps the lifetime it already had.
      if (lifetimeRequests.length > 0) {
        await Promise.race([
          Promise.all(lifetimeRequests),
          new Promise<void>(resolve => {
            const t = setTimeout(resolve, DETACH_LIFETIME_TIMEOUT_MS)
            t.unref?.()
          }),
        ])
      }
      if (detached > 0) schedulePersist()
      return { detached }
    },
    releaseSandboxSession(id) {
      const session = sessions.get(id)?.agentSession
      if (!session?.detach) return undefined
      return session.detach()?.remoteSessionId
    },
    sandboxReattachCandidates() {
      return Array.from(sessions.values())
        .filter(
          rt =>
            rt.desc.hostDetached === true &&
            rt.desc.sandboxReattach !== undefined &&
            rt.agentSession === undefined,
        )
        .map(rt => rt.desc)
    },
    finishSandboxReattach(id, result) {
      const rt = sessions.get(id)
      if (!rt || rt.desc.hostDetached !== true) {
        if (result.kind === "attach") void result.agentSession.close().catch(() => undefined)
        return { status: "skipped" }
      }
      const detachedAtIso = rt.desc.sandboxReattach?.detachedAt
      const clearMarkers = (): void => {
        delete rt.desc.hostDetached
        delete rt.desc.sandboxReattach
      }
      const announce = (text: string): void => {
        appendLine(rt, text, "stdout")
        transcriptWriter.recordEvent(rt.desc.id, { kind: "notice", text })
      }
      if (result.kind === "attach") {
        clearMarkers()
        bindAgentSession(rt, result.agentSession)
        bindOutOfTurnEvents(rt)
        stampCapabilities(rt)
        rt.readUsage = result.readUsage
        rt.desc.pid = result.agentSession.pid ?? null
        rt.desc.status = "running"
        delete rt.desc.endedAt
        delete rt.desc.endedReason
        delete rt.desc.exitCode
        delete rt.desc.killedMidTurn
        delete rt.desc.interruptedAtBoot
        delete rt.desc.outcome
        rt.exitedEmitted = false
        rt.emitter.emit("status", rt.desc.status)
        armUsageRefresh(rt)
        reattachBoot.reattached++
        const replay = result.probe.state === "busy" || result.probe.state === "backlog"
        announce(
          "── re-attached to sandbox session after daemon restart" +
            (detachedAtIso ? ` (detached ${detachedAtIso})` : "") +
            (replay ? "; replaying events the box produced meanwhile" : "") +
            " ──",
        )
        schedulePersist()
        recordConversationLink(rt)
        sessionEvents?.emit({
          type: "session:resumed",
          sessionId: rt.desc.id,
          interrupted: false,
          resumedFrom: "daemon-restart",
          ...(rt.desc.label ? { label: rt.desc.label } : {}),
          ts: new Date().toISOString(),
        })
        if (replay) {
          void runAgentTurn(rt, null, { reattach: true }).catch(err => {
            appendLine(
              rt,
              `[turn error] ${err instanceof Error ? err.message : String(err)}`,
              "stderr",
            )
          })
        }
        return { status: "reattached", ...(replay ? { resumedTurn: true } : {}) }
      }
      clearMarkers()
      if (result.kind === "gone" || result.kind === "ended") {
        const gone = result.kind === "gone"
        rt.desc.status = gone ? "killed" : "error"
        rt.desc.endedReason = gone ? "sandbox_gone" : "crashed"
        rt.desc.endedAt = new Date().toISOString()
        delete rt.desc.killedMidTurn
        delete rt.desc.interruptedAtBoot
        if (gone) reattachBoot.gone++
        else reattachBoot.failed++
        announce(
          gone
            ? "── sandbox is gone — the box (or its session) no longer exists; nothing to re-attach to" +
                (result.detail ? ` (${result.detail})` : "") +
                " ──"
            : "── sandbox session had already ended while the daemon was down" +
                (result.detail ? ` (${result.detail})` : "") +
                " ──",
        )
      } else {
        // Transient: keep the plain `daemon-restart` ghost so eager resume /
        // continue-interrupted can still pick the row up.
        reattachBoot.failed++
        announce(
          "── could not re-attach to the sandbox after daemon restart" +
            (result.detail ? ` (${result.detail})` : "") +
            " ──",
        )
      }
      rt.exitedEmitted = false
      rt.emitter.emit("status", rt.desc.status)
      schedulePersist()
      emitExited(rt)
      return { status: result.kind }
    },
    noteSandboxReattachUnserved(count) {
      reattachBoot.unserved = Math.max(0, Math.floor(count))
    },
    sandboxSessionStats() {
      let attached = 0
      for (const rt of sessions.values()) {
        if (
          rt.desc.status === "running" &&
          rt.agentSession?.detach !== undefined &&
          rt.desc.hostDetached !== true
        ) {
          attached++
        }
      }
      const resolved = reattachBoot.reattached + reattachBoot.gone + reattachBoot.failed
      return {
        attached,
        reattach: {
          detachedAtBoot: reattachBoot.detachedAtBoot,
          reattached: reattachBoot.reattached,
          gone: reattachBoot.gone,
          failed: reattachBoot.failed,
          unserved: reattachBoot.unserved,
          pending: Math.max(0, reattachBoot.detachedAtBoot - resolved - reattachBoot.unserved),
        },
      }
    },
    shutdown() {
      shutdownImpl()
    },
  }

  return registry

  /**
   * Detach a live provider-box session from this daemon: close its connection
   * only (the box and its remote agent session keep running), and stamp the
   * re-attach record on the row. Returns whether THIS call detached it —
   * false for rows that are not detachable (local, device-paired, ended) or
   * already detached. Sync so the `process.on("exit")` path can use it too.
   */
  function detachRow(rt: SessionRuntime): boolean {
    if (rt.desc.hostDetached === true) return false
    if (rt.desc.status !== "running") return false
    const session = rt.agentSession
    if (!session?.detach) return false
    const record = session.detach()
    if (!record) return false
    rt.desc.hostDetached = true
    rt.desc.sandboxReattach = { ...record, detachedAt: new Date().toISOString() }
    return true
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
    // In-memory-only fs watchers (agent-role-refresh opt-in watch) never
    // outlive their registry.
    for (const id of [...agentRoleWatchers.keys()]) stopAgentRoleWatch(id)
    if (persistTimer) clearTimeout(persistTimer)
    // Land any throttled index-sidecar writes before the final snapshot flush.
    flushDirtyIndexes()
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
      // Any live-usage poller dies with the registry — no strays.
      stopUsageRefresh(rt)
      // A provider-box session is DETACHED, not killed: only this daemon's
      // connection closes; the box and its agent session keep running, and
      // the row persists as `running` + `hostDetached` for the next boot's
      // reattach pass. (The async `detachSandboxSessions` already did this
      // and asked the box to extend its lifetime; this covers a shutdown that
      // reached us without it — the process-exit net.)
      if (rt.desc.hostDetached === true || detachRow(rt)) continue
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
        // Interrupted (again) by THIS shutdown: park the pending marker so the
        // next boot — and only the next boot — claims the row as its own
        // restart's (see `interruptedAtBoot`).
        if (rt.desc.killedMidTurn) rt.desc.interruptedAtBoot = INTERRUPTED_PENDING_BOOT
        clearInFlightFlags(rt.desc)
        if (rt.agentSession) {
          recordExitUsageSnapshot(rt)
          void rt.agentSession.close({ daemonShutdown: true }).catch(() => undefined)
        }
        if (rt.pty) {
          try {
            rt.pty.kill("SIGTERM")
          } catch {
            // already exited
          }
        }
        killChildIfSpawned(rt.child, "SIGTERM")
        emitExited(rt)
      }
    }
    // PARENT RELAY: the exits above already revoked (and persisted) the
    // grants of the sessions that died with this daemon; detached boxes keep
    // theirs for the next boot. Stop writing to the store from here on.
    detachParentRelayStore?.()
    // Tracked so `settlePendingWrites()` after `shutdown()` waits for the
    // streams to finish flushing into `transcriptBaseDir`.
    trackWrite(transcriptWriter.closeAll())
    trackWrite(terminalTranscriptWriter.closeAll())
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
  // A dead row carries no live parked-with-background-tasks flag — the
  // "ended its turn with work pending" heuristic is meaningless once the
  // session is gone. No bus event here: this runs on forced-termination
  // paths (kill/shutdown/boot-reclassify) where session:exited is the
  // signal consumers key on; a bg-tasks-cleared would be noise.
  delete desc.pendingBgTasks
  // Nor any live background task: its process is gone with the session.
  delete desc.backgroundTasks
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
  sessionEvents: SessionEventBus | undefined,
  /** Where the sessions' `events.jsonl` transcripts live — read (tail only)
   *  to recover the last assistant message of a row that died with the
   *  daemon, for its derived outcome. */
  transcriptBaseDir: string,
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
  /** This daemon's `SessionsRegistry.bootId` — stamped onto rows found
   *  interrupted (`interruptedAtBoot`). */
  bootId?: string,
  /** Counts the provider-box sessions found detached (see `hostDetached`) —
   *  these are held for the boot reattach pass instead of being announced
   *  as dead. */
  reattachBoot?: { detachedAtBoot: number },
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
    // QUARANTINE, don't just ignore: this bucket still counts as
    // boot-loaded, so the first persist will overwrite `persistPath`
    // verbatim with the live-only view — if the corrupt bytes (usually a
    // truncated snapshot from a write that died mid-flight) stay at the
    // canonical path, that overwrite is the moment the user's history
    // becomes unrecoverable. Moving them aside costs a rename and keeps
    // the raw material a manual restore needs (2026-08-14 registry wipe).
    const quarantine = `${persistPath}.corrupt-${Date.now()}`
    try {
      renameSync(persistPath, quarantine)
      console.warn(
        `[sessions] history file ${persistPath} is malformed — ` +
          `quarantined to ${quarantine} and starting this bucket empty`,
      )
    } catch {
      console.warn(
        `[sessions] history file ${persistPath} is malformed and could ` +
          `not be quarantined — ignoring`,
      )
    }
    return
  }
  if (!Array.isArray(parsed.sessions)) return
  // Newest first so the FIFO cap drops oldest — but spent per LANE: real
  // sessions first, review-lane / workflow-stage noise last. A store that
  // blew past the cap on review traffic (the ordinary busy-host shape: a
  // handful of real sessions, hundreds of `review:`/`wf:` rows) keeps every
  // real session and drops only the oldest noise, instead of the previous
  // newest-first slice silently evicting real history while noise survived.
  // The rows still on disk are reachable either way via the cold fallback
  // (`session-cold-list.ts`), but what the registry holds should be the
  // history worth holding.
  const byNewestStart = (a: SessionDescriptor, b: SessionDescriptor): number =>
    b.startedAt.localeCompare(a.startedAt)
  const valid = parsed.sessions.filter((s): s is SessionDescriptor => !!s && typeof s.id === "string")
  const sorted = [
    ...valid.filter(s => !isReviewOrWorkflowSession(s)).sort(byNewestStart),
    ...valid.filter(s => isReviewOrWorkflowSession(s)).sort(byNewestStart),
  ].slice(0, HISTORY_CAP)
  const now = new Date().toISOString()
  for (const desc of sorted) {
    if (sessions.has(desc.id)) continue // collision with a live entry — keep live
    const wasAlive = desc.status === "running" || desc.status === "starting"
    // An external row has no process to have died with the daemon: it simply
    // expires (lazily) like any other, and a later sighting revives it.
    const externalAlive = wasAlive && desc.kind === "external"
    // A provider-box session the previous process detached from (graceful
    // shutdown) or died holding (crash: `snapshotRows` keeps the re-attach
    // record fresh) — the box and its agent are presumably still running, so
    // hold the row for the boot reattach pass instead of announcing a death.
    // Until that pass resolves it the row reads as the plain `daemon-restart`
    // ghost, flagged `hostDetached`; every outcome of the pass clears it.
    // A row still pending from the previous boot (pass never finished — a
    // second restart landed first) stays a candidate.
    const detachCandidate =
      (wasAlive ||
        (desc.hostDetached === true &&
          desc.status === "killed" &&
          desc.endedReason === "daemon-restart")) &&
      !externalAlive &&
      desc.kind === "agent-cli" &&
      desc.sandboxId !== undefined &&
      desc.sandboxProvider !== undefined &&
      desc.sandboxReattach !== undefined &&
      typeof desc.sandboxReattach.remoteSessionId === "string"
    const reclassified: SessionDescriptor = externalAlive
      ? { ...desc, status: "exited", endedAt: desc.endedAt ?? desc.lastSeenAt ?? now }
      : wasAlive
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
          ...(detachCandidate ? { hostDetached: true } : {}),
        }
      : desc
    if (!detachCandidate) {
      // A stale flag on a row that is not (or no longer) a candidate.
      delete reclassified.hostDetached
      if (reclassified.status !== "running") delete reclassified.sandboxReattach
    } else {
      reattachBoot && reattachBoot.detachedAtBoot++
    }
    // A row loaded from disk has no live provisioning, whatever it recorded.
    delete reclassified.provisioning
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
    migratePendingChildNotices(reclassified)
    // Which restart interrupted it (see `interruptedAtBoot`). Only two shapes
    // are THIS restart's: a row still alive on disk (the daemon died without
    // a graceful shutdown), and one the graceful shutdown just parked with
    // `INTERRUPTED_PENDING_BOOT`. Any other interrupted row keeps whatever it
    // carries — an older boot's id, or nothing at all for a row persisted by
    // a daemon predating the marker. That absence must NOT be read as "ours":
    // those rows were cut off by an earlier restart (live: rows from the day
    // before were stamped with the current boot and reported eligible).
    if (
      bootId !== undefined &&
      reclassified.killedMidTurn === true &&
      reclassified.endedReason === "daemon-restart" &&
      (wasAlive || reclassified.interruptedAtBoot === INTERRUPTED_PENDING_BOOT)
    ) {
      reclassified.interruptedAtBoot = bootId
    } else if (reclassified.interruptedAtBoot === INTERRUPTED_PENDING_BOOT) {
      // A pending marker on a row no longer interrupted — nothing to claim.
      delete reclassified.interruptedAtBoot
    }
    // Same reasoning as the in-flight flags above, for `contextUsed`: a
    // snapshot written before `plausibleContextUsed` existed can carry an
    // out-of-window value on disk, and a dead/historical ghost never gets
    // a fresh usage_update to self-correct it — so re-validate on the way
    // back into memory instead of resurrecting the stale figure forever.
    reclassified.contextUsed = plausibleContextUsed(
      reclassified.contextSize,
      reclassified.contextUsed,
    )
    // A row that died with the daemon never went through `emitExited`, so
    // derive its outcome here — the live text buffer died with the old
    // process, so the summary comes from its transcript's tail instead.
    if (wasAlive && !detachCandidate && reclassified.kind === "agent-cli" && !reclassified.outcome) {
      reclassified.outcome = deriveSessionOutcome(reclassified, {
        lastAssistantText: readLastAssistantTextSync(sessionEventsPath(reclassified.id, transcriptBaseDir)),
      })
    }
    const rt: SessionRuntime = {
      desc: reclassified,
      recentLines: [],
      recentBytes: [],
      recentBytesSize: 0,
      emitter: new EventEmitter(),
      busy: false,
      textBuf: "",
      thoughtBuf: "",
      exitedEmitted: wasAlive || detachCandidate,
    }
    rt.emitter.setMaxListeners(50)
    sessions.set(desc.id, rt)
    if (bucketSlug !== undefined) {
      sourceBucketOf?.set(desc.id, bucketSlug)
      if (heldIdsByBucket) markHeldId(heldIdsByBucket, bucketSlug, desc.id)
    }
    if (wasAlive && !externalAlive && !detachCandidate) {
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

/** The caller's own ask for the index sidecar: the outgoing message's text
 *  blocks, with a daemon-composed system preamble stripped off the front —
 *  mirrors `transcript-writer.ts`'s `recordPrompt` extraction so `sessions
 *  find`/`recap` show the human's words, not the boilerplate. */
function promptTextForIndex(message: unknown, system: string | undefined): string {
  const text =
    typeof message === "string"
      ? message
      : (Array.isArray(message) ? message : [message])
          .map(b =>
            b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
              ? (b as { text: string }).text
              : "",
          )
          .filter(Boolean)
          .join("\n")
  if (system && text.startsWith(system)) return text.slice(system.length).replace(/^\n\n/, "")
  return text
}

/** Minimal shell-quote — wraps args containing whitespace or quotes
 *  so the rendered `command` field is copy-pasteable. */
function quoteArg(arg: string): string {
  if (arg === "") return '""'
  if (/^[a-zA-Z0-9._/=:@,+-]+$/.test(arg)) return arg
  return `"${arg.replace(/(["\\$`])/g, "\\$1")}"`
}
