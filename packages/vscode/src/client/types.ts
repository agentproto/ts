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
  lastOutputAt?: string
  lastActivityAt?: string
  processAlive?: boolean
  label?: string
  pty?: boolean
  name?: string
  argv?: readonly string[]
  cwd?: string
  adapterSlug?: string
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
  /** Install/readiness state: ready = installed, available = installable. */
  status?: "supported" | "available" | "ready"
  /** Short human hint shown in pickers (e.g. "anthropic · ACP · resumable"). */
  hint?: string
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
