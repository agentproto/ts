/**
 * Frozen client type contract — copied field-for-field from the daemon's
 * SessionDescriptor (recon §Session descriptor) plus the permission +
 * adapter + event shapes WP1–4 code against. Do NOT reshape these without
 * a coordinated change across all WPs.
 */

/** Mirrors @agentproto/runtime AcpMcpServer (packages/acp/src/types.ts). */
export interface AcpMcpServer {
  name: string
  transport: "stdio" | "http" | "sse"
  ref?: string
  headers?: Record<string, string>
  credentialRef?: string
}

/** Mirrors @agentproto/runtime SessionAwaitingQuestion. */
export interface SessionAwaitingQuestion {
  text: string
  options?: string[]
  source: "structured" | "heuristic"
}

export type SessionKind = "terminal" | "agent-cli" | "command" | "browser"
export type SessionStatus =
  | "starting"
  | "running"
  | "exited"
  | "killed"
  | "error"

/**
 * SessionDescriptor — the daemon's canonical session row. Field-for-field
 * copy of the recon §Session descriptor contract (packages/runtime
 * sessions.ts SessionDescriptor). Optional fields stay optional here so
 * partial daemon responses type-check.
 */
export interface SessionDescriptor {
  id: string
  kind: SessionKind
  workspaceSlug: string
  command: string
  pid: number | null
  status: SessionStatus
  startedAt: string
  endedAt?: string
  exitCode?: number
  /** Mirrors `@agentproto/runtime` SessionDescriptor.killedMidTurn: whether a
   *  turn was actually in flight the instant `status` flipped to "killed" —
   *  captured by the daemon at kill time, before `busy` can go stale (a
   *  killed session's `busy` is never cleared by the turn's own `finally`
   *  if that turn's generator is never resumed). `true` means interrupted;
   *  `false`/absent alongside `turnsCompleted > 0` means the session had
   *  already finished its work before something tore it down — see
   *  activityFor in sessionsTree.logic.ts for the read. */
  killedMidTurn?: boolean
  lastOutputAt?: string
  lastActivityAt?: string
  processAlive?: boolean
  label?: string
  /** Derived from the session's FIRST prompt — see the runtime's
   *  SessionDescriptor.title doc for the derivation + overwrite rules. */
  title?: string
  /** Mirrors `@agentproto/runtime` SessionDescriptor.archived — housekeeping
   *  flag hiding the row from the daemon's default `list()` view (and so
   *  from `listSessions()` here too, unless `includeArchived` is passed).
   *  Set/cleared via `session_archive`/`session_unarchive`. */
  archived?: boolean
  pty?: boolean
  name?: string
  argv?: readonly string[]
  cwd?: string
  adapterSlug?: string
  /** AIP-45 mode the session was spawned with (e.g. claude-code's `plan`, a
   *  gateway preset mode like `moonshot`). Undefined for the adapter's own
   *  default mode. Mirrors `@agentproto/runtime` SessionDescriptor.mode —
   *  the mid-session model-switch picker (changeModel.logic.ts) compares
   *  this against a candidate model's bound `mode` to decide whether
   *  picking it is a live switch or needs a restart. */
  mode?: string
  model?: string
  auth?: {
    mode: "subscription" | "api-key"
    fingerprint: string
  }
  costUsd?: number
  tokensIn?: number
  tokensOut?: number
  contextSize?: number
  contextUsed?: number
  usageSource?: "adapter" | "computed" | "no-pricing" | "none"
  adapterSessionId?: string
  mcpServers?: AcpMcpServer[]
  resumeMetadata?: Record<string, string>
  awaitingInput?: boolean
  awaitingQuestion?: SessionAwaitingQuestion
  awaitingPermission?: boolean
  turnsCompleted?: number
  busy?: boolean
  blockedOn?: "subagent" | "command"
  pendingToolCallId?: string
  parentSessionId?: string
  depth?: number
  priorCommandSessionId?: string
  /** Id of the prior session this one continues from — set when this session
   *  was spawned by a restart (`session_restart` / `agentproto.restartSession`),
   *  even when the resume itself couldn't establish continuity (a fresh
   *  fallback spawn is still "restarted from" the prior session). See the
   *  runtime's SessionDescriptor.resumedFrom doc. Powers the transcript
   *  panel's resume-chain stitch (transcriptPanelController.ts). */
  resumedFrom?: string
  /** Human-readable resume path for `resumedFrom` — e.g. "resumed via claude
   *  --resume", "resumed via ACP", or "" when no continuity was established.
   *  Only meaningful alongside `resumedFrom`. */
  resumeVia?: string
  browserAdapterId?: string
  browserPort?: number
  browserBaseUrl?: string
  browserLocation?: "local" | "cloud"
  remote?: boolean
  sandboxId?: string
  sandboxTeardown?: "kill" | "pause"
}

/** A pending ACP permission request held in the cross-session inbox. */
export interface PendingPermission {
  id: string
  sessionId: string
  toolCallId: string
  toolName?: string
  text: string
  options: Array<{ optionId: string; name?: string; kind?: string }>
  requestedAt: string
}

/**
 * One entry of `models`, carrying the provider/mode a manifest's structured
 * `models.allowed` entry states (AIP-45 — see the daemon's
 * `packages/cli/src/registry/resolve.ts` `AdapterModelInfo`). `provider`/
 * `mode` are undefined for a bare-string entry — an unstated provider is
 * never guessed here, only projected as-is.
 */
export interface AdapterModelInfo {
  id: string
  /** Who serves/bills this model (a ProviderPreset id, or a direct
   *  provider like "anthropic"). Undefined when unstated. */
  provider?: string
  /** The adapter's own mode id that routes to `provider`. Undefined when
   *  the adapter routes on its own or needs no mode switch. */
  mode?: string
}

/** One entry in the daemon's adapter registry (MCP-only: mcpCall("adapter_list"), no HTTP route). */
export interface AdapterInfo {
  slug: string
  /** Display name. */
  name?: string
  /** Transport the CLI speaks (acp / proprietary / print). */
  protocol?: string
  /** Adapter version, when reported. */
  version?: string
  /** Declared spawn modes (e.g. subscription / api-key for claude-code). */
  modes?: Array<{
    id: string
    status?: "active" | "noop"
    status_note?: string
  }>
  /** Conventional model ids the adapter advertises. */
  models?: string[]
  /** Same models as `models`, in the same order, each carrying the
   *  provider/mode a structured `models.allowed` entry states. Absent on
   *  an older daemon that predates this projection. */
  modelDetails?: AdapterModelInfo[]
  /** Install/readiness state: ready = installed, available = installable. */
  status?: "supported" | "available" | "ready"
  /** Short human hint shown in pickers (e.g. "anthropic · ACP · resumable"). */
  hint?: string
  /**
   * How this adapter selects a model (AIP-45 `models.apply`; the daemon
   * defaults an omitted manifest field to `"config"` before projecting it
   * here). `"arg"` bakes the model into spawn-time argv, so EVERY
   * mid-session switch attempt is `requires-restart` regardless of target
   * — changeModel.logic.ts marks every row that way for such an adapter.
   * Absent on an older daemon that predates this projection; treat as
   * `"config"`.
   */
  modelApply?: "config" | "command" | "arg"
}

/** /health probe result. */
export interface DaemonHealth {
  status: string
  workspace: string
  registered: readonly string[]
  uptimeMs?: number
}

/** A session lifecycle event from session_events_poll (MCP). */
export interface SessionLifecycleEvent {
  type: string
  sessionId?: string
  ts?: string
  [k: string]: unknown
}

/** session_events_poll MCP tool result (parsed from the tools/call text content). */
export interface SessionEventsPollResult {
  events: SessionLifecycleEvent[]
  nextCursor: number
}

/** One line from /sessions/:id/stream SSE. */
export interface SessionStreamLine {
  line: string
  stream?: "stdout" | "stderr" | string
}

/**
 * One record from GET /sessions/:id/events — the daemon's durable
 * per-session events.jsonl capture (packages/runtime transcript-writer.ts).
 *
 * This is the NORMALIZED semantic-event boundary: provider/model differences
 * (Claude-wire, Kimi-behind-Claude-transport, hermes, mastracode, …) are
 * already resolved by the adapter/protocol layer BEFORE a record is written,
 * so a frontend renders structured components without ever parsing a raw
 * provider payload. Records never contain credentials. Optional fields
 * default to undefined; an unknown `kind` is ignored by the reducer.
 *
 * Field-for-field superset of the daemon's TranscriptRecord
 * (transcript-export.ts) plus the writer's own "user-prompt" /
 * "usage_snapshot" records. Do NOT reshape without a coordinated daemon change.
 */
export interface SessionEventRecord {
  /** Monotonic per-session sequence — the cursor unit for `since` polling. */
  seq: number
  /** ISO-8601 timestamp the daemon stamped when the record was written. */
  ts: string
  kind: string
  sessionId?: string
  text?: string
  partial?: boolean
  toolCallId?: string
  toolName?: string
  arguments?: unknown
  /** True when a "tool-call" record ENRICHES a call already announced under
   *  the same toolCallId (an agent that announced before it knew the input),
   *  rather than announcing a new one. reduceConversation merges by
   *  toolCallId regardless, so this is descriptive rather than load-bearing. */
  isUpdate?: boolean
  result?: unknown
  isError?: boolean
  reason?: string
  error?: { message: string; code?: number; data?: unknown }
  options?: unknown
  entries?: Array<{ content: string; priority: string; status: string }>
  size?: number
  used?: number
  cost?: { amount: number; currency: string }
  tokensIn?: number
  tokensOut?: number
  // usage_snapshot-only fields (turn-boundary durable recap)
  model?: string
  costUsd?: number
  contextSize?: number
  contextUsed?: number
  source?: string
}

/** GET /sessions/:id/events response envelope (http-server.ts). */
export interface SessionEventsPage {
  sessionId: string
  events: SessionEventRecord[]
  /** Cursor to pass as `since` on the next poll — never regresses. */
  nextSeq: number
  /** false when the page was capped by `limit` and more records remain. */
  complete: boolean
}

/**
 * Global RuntimeEvent from GET /events SSE. NOTE: the daemon's /events
 * stream carries ONLY runtime events (boot, heartbeat-*, conv-turn-appended,
 * remote-log) — it does NOT surface session:* lifecycle events. Those are
 * read via session_events_poll (MCP). Kept here so an /events subscriber
 * can still type the frames it receives.
 */
export type RuntimeEvent =
  | { type: "boot"; at: string; workspace: string; registered: readonly string[] }
  | {
      type: "heartbeat-fired"
      at: string
      agent: string
      conversationId: string
      prompt: string
      reply: string
      durationMs: number
    }
  | { type: "heartbeat-error"; at: string; agent?: string; error: string }
  | {
      type: "conv-turn-appended"
      at: string
      conversationId: string
      role: "user" | "assistant"
      contentPreview: string
    }
  | { type: "remote-log"; at: string; line: string }

/**
 * A registered workspace from the daemon's ~/.agentproto/workspaces.json
 * control plane (GET /workspaces). Mirrors the daemon's `WorkspaceEntry`
 * (runtime/src/workspaces-config.ts).
 *
 * NOTE the asymmetry this exists to paper over: a SessionDescriptor carries
 * only `workspaceSlug`, and that slug silently defaults to "default" on the
 * terminal/raw spawn paths (only POST /sessions/agent reverse-maps cwd →
 * slug daemon-side). So a client that wants reliable workspace attribution
 * resolves `descriptor.cwd` against this list itself.
 */
export interface WorkspaceEntry {
  /** Stable handle: /^[a-z0-9][a-z0-9-]{0,63}$/. */
  slug: string
  /** Absolute path to the workspace root. */
  path: string
  addedAt: string
  updatedAt: string
  /** Free-text display name; falls back to `slug` when absent. */
  label?: string
}

export interface WorkspacesConfig {
  version: 1
  /** Slug of the daemon's active workspace, when one is set. */
  active?: string
  workspaces: WorkspaceEntry[]
}
