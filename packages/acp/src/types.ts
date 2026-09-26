/**
 * AIP-44 AcpDefinition + AcpHandle.
 *
 * Mirrors `resources/aip-44/draft/ACP.schema.json`. AIP-44 is an
 * agentproto profile of the Agent Client Protocol — top-level fields
 * declare role/transport/version, and AIP-44 extensions live under
 * `metadata.aip44.*`.
 *
 * `AcpHandle` is the readonly view of the same shape; tighten it by
 * hand for fields that get defaults applied in build().
 */

/**
 * How a host resolves a `session/request_permission` request that was parked
 * by permission-hold mode. `{ optionId }` selects one of the offered options
 * (the allow- or reject-flavored one, chosen by the host); `{ cancelled: true }`
 * maps to ACP's `cancelled` outcome (used when the request offers no matching
 * option or the session is being torn down). Consumed by
 * `AcpClient.respondPermission` and the daemon's permission inbox.
 */
export type AcpPermissionResolution =
  | { optionId: string; feedback?: string }
  | { cancelled: true }

/**
 * `_meta` key the daemon's respond path uses to carry the caller's free-text
 * feedback (e.g. "reject, but do X instead") on the `selected` outcome of a
 * held `session/request_permission` RPC. Defined once here so the acp client
 * and adapters agree on the convention.
 */
export const ACP_META_FEEDBACK = "agentproto/feedback"

export type AcpRole = "client" | "server" | "bridge"
export type AcpTransport = "stdio" | "websocket"
export type AcpTier = "basic" | "governance-aware" | "sandboxed"

/** Mirror of upstream ACP `initialize` capabilities. */
export interface AcpCapabilities {
  client?: {
    fs?: {
      readTextFile?: boolean
      writeTextFile?: boolean
    }
    terminal?: boolean
  }
  agent?: {
    loadSession?: boolean
    promptCapabilities?: {
      image?: boolean
      audio?: boolean
      embeddedContext?: boolean
    }
    mcpCapabilities?: {
      http?: boolean
      sse?: boolean
    }
  }
}

export interface AcpAuditConfig {
  ref?: string
  kind?: "governance" | "external" | "off"
}

export interface AcpMcpServer {
  name: string
  transport: "stdio" | "http" | "sse"
  ref?: string
  /** Static HTTP headers sent with every request to an `http` or `sse`
   *  MCP server. Useful for fixed auth tokens or content-negotiation
   *  headers that are safe to embed in config. */
  headers?: Record<string, string>
  /** Brokered credential path resolved at spawn time into additional
   *  `headers` (typically an `Authorization` header). The path is passed
   *  to the daemon's credential broker, so the actual secret never lives
   *  in env or config. Mutually usable with `headers`; brokered headers
   *  win on collision. */
  credentialRef?: string
  /** Extra argv for a `stdio` server (the command itself is `ref`).
   *  Ignored for `http` / `sse`. */
  args?: string[]
  /** Extra environment for a `stdio` server, merged over the agent's own
   *  env by the ACP agent when it launches the process. Ignored for
   *  `http` / `sse`. */
  env?: Record<string, string>
}

/** AIP-44 extensions on the agentskills.io baseline. Lives under `metadata.aip44`. */
export interface Aip44Extensions {
  /** Commit SHA of upstream ACP repository this manifest validates against. */
  acp_rev: string
  /** Capability tier shorthand. */
  tier: AcpTier
  /** Optional explicit capability map; overrides tier defaults when present. */
  capabilities?: AcpCapabilities
  /** AIP-9 OPERATOR.md ref. REQUIRED when kind=server. */
  operator?: string
  /** AIP-7 GOVERNANCE.md ref. */
  governance?: string
  /** AIP-36 SANDBOX.md ref. REQUIRED when tier=sandboxed. */
  sandbox?: string
  /** Audit log target override. */
  audit?: AcpAuditConfig
  /** MCP servers to mount via session/new.mcpServers. */
  mcp_servers?: AcpMcpServer[]
  /** AIP-44 extensions stay open; vendors MAY add namespaced sub-keys. */
  [extension: string]: unknown
}

/**
 * AIP-44 ACP.md frontmatter. Top-level fields are stable across upstream
 * ACP rev bumps; the AIP-44-specific binding layer lives in
 * `metadata.aip44`.
 */
export interface AcpDefinition {
  /** Kebab id; MUST equal the parent directory name. */
  name: string
  /** Stable runtime id. */
  id: string
  /** One-paragraph purpose. */
  description: string
  /** Semver of this manifest. */
  version: string
  /** client = drives a subprocess; server = exposes an operator; bridge = both. */
  kind: AcpRole
  /** Transport(s) supported. stdio is REQUIRED; websocket is OPTIONAL. */
  transport: AcpTransport | AcpTransport[]
  /** Free-form metadata. AIP-44 extensions live under `metadata.aip44`. */
  metadata: {
    aip44: Aip44Extensions
    [vendor: string]: unknown
  }
  /** Optional tags for catalog ergonomics. */
  tags?: string[]
  /** Top-level extension surface preserved for forward compatibility. */
  [extension: string]: unknown
}

export type AcpHandle = Readonly<AcpDefinition>

/**
 * One background task as reported by the agent — see the `background-task`
 * {@link StreamEvent}. Only `taskId` is guaranteed; a `"settled"` edge carries
 * the terminal `status` and usually a `summary`.
 */
export interface BackgroundTaskInfo {
  taskId: string
  /** Friendly task type (`"shell"`, `"monitor"`, `"workflow"`, ...). */
  taskKind?: string
  description?: string
  /** Where the task writes its output, when the agent says. */
  outputFile?: string
  status?: "running" | "paused" | "completed" | "failed" | "stopped"
  summary?: string
  /** The tool call that started the task, when the agent says. */
  toolCallId?: string
}

/**
 * Canonical stream-event taxonomy emitted from `createAcpClient`. The
 * client maps upstream ACP `session/update` notifications and
 * `requestPermission` callbacks into this closed set so consumers
 * never see protocol-specific shapes.
 */
export type StreamEvent =
  | { kind: "text-delta"; sessionId: string; text: string }
  | {
      kind: "tool-call"
      sessionId: string
      toolCallId: string
      toolName: string
      arguments: unknown
      /**
       * True when this event ENRICHES a call already announced under the same
       * `toolCallId` rather than announcing a new one.
       *
       * ACP lets an agent announce a call before it knows the details and fill
       * them in afterwards. The claude-code bridge does exactly that: its
       * `tool_call` carries `title: "Read File"` with `rawInput: {}`, and the
       * FOLLOWING `tool_call_update` carries `rawInput: {file_path: …}` plus a
       * real title. Consumers must merge an update onto the existing call
       * (keyed by `toolCallId`) rather than rendering a second card, and must
       * not count it as a fresh call for logging or blocked-on purposes.
       *
       * `toolName` is `""` when the update carried no title — merge only
       * non-empty names so an untitled enrichment can't erase a good one.
       */
      isUpdate?: boolean
    }
  | { kind: "tool-result"; sessionId: string; toolCallId: string; result: unknown; isError?: boolean }
  | { kind: "thought"; sessionId: string; text: string }
  | {
      kind: "agent-prompt"
      sessionId: string
      /**
       * Correlation id for this prompt. In permission-hold mode this is the
       * stable request id the host passes back to `respondPermission` to
       * resolve the parked `session/request_permission` RPC — derived from the
       * ACP `toolCall.toolCallId` plus a per-client counter so it stays unique
       * even when an agent re-requests permission for the same tool call.
       */
      toolCallId: string
      options: unknown
      /** Human-readable "Allow X?" line, when derivable from the request. */
      text?: string
      /** Tool title/kind the agent is asking permission for, when present. */
      toolName?: string
      /**
       * The tool call's raw input (ACP `ToolCallUpdate.rawInput`) — e.g. a
       * Bash tool's command string — carried through unmodified so a host can
       * see WHAT the agent is asking permission to run. Harness-shaped and
       * untyped: normalize defensively per-adapter rather than assuming a
       * stable schema.
       */
      rawInput?: unknown
      /**
       * The tool call's `_meta` (e.g. mastra-agent's
       * `mastra-agent/suspendPayload` carrying a submit_plan's plan text),
       * carried through unmodified. Harness-shaped and untyped — normalize
       * defensively per-adapter rather than assuming a stable schema.
       */
      _meta?: unknown
    }
  | {
      kind: "turn-end"
      sessionId: string
      /**
       * `"watchdog-timeout"` is synthesized client-side (never sent by the
       * agent) when `AcpClientOptions.turnIdleTimeoutMs` elapses with no
       * activity signal during a turn and the underlying `prompt()` call
       * still hasn't resolved — distinguishes an inferred completion from
       * a real one so callers that care can tell the difference.
       */
      reason: "completed" | "cancelled" | "max_turns" | "error" | "watchdog-timeout"
    }
  | { kind: "error"; sessionId?: string; error: { code?: number; message: string; data?: unknown } }
  | {
      kind: "plan"
      sessionId: string
      title?: string
      entries: Array<{
        content: string
        priority: "high" | "medium" | "low"
        status: "pending" | "in_progress" | "completed"
      }>
    }
  | {
      kind: "usage_update"
      sessionId: string
      size: number
      used: number
      cost?: { amount: number; currency: string }
      /** Cumulative input/output token counts, when the agent reports them
       *  (some ACP agents send per-token usage alongside the context-window
       *  `size`/`used`). Lets the daemon price a session that has tokens but
       *  no adapter-reported `cost`. */
      tokensIn?: number
      tokensOut?: number
      /** The model this usage belongs to, when the agent reports it
       *  (claude-agent-acp: `_meta["_claude/model"]`). */
      model?: string
      /** True when the agent's `size` is a guess it corrects later (the
       *  claude-agent-acp wrapper's in-turn frames), not a known window. */
      sizeInferred?: boolean
      /** The context-window size the agent itself reported, kept by the
       *  daemon when it corrects `size` (see runtime `context-window.ts`). */
      reportedSize?: number
      /**
       * Who started the cycle this usage closes, when the agent says
       * (claude-agent-acp: `_meta["_claude/origin"].kind`). `"task-notification"`
       * marks the end of an AUTONOMOUS cycle — the model woke on its own
       * because a background task settled, with no `session/prompt` in flight.
       */
      origin?: string
    }
  | {
      kind: "background-task"
      sessionId: string
      /**
       * Lifecycle edge of a non-agent background task (a backgrounded Bash
       * command, a monitor, ...), published over the AIR `asyncTasks`
       * extension (`async_task_spawned` / `async_task_progress` /
       * `async_task_state_update`). `"started"` announces the task,
       * `"updated"` carries progress/metadata, `"settled"` is terminal.
       */
      phase: "started" | "updated" | "settled"
      task: BackgroundTaskInfo
    }
  | {
      kind: "available-commands"
      sessionId: string
      /**
       * The full, current set of slash-commands/skills the agent supports —
       * an `available_commands_update` REPLACES any previously reported list
       * wholesale, it is not a delta.
       */
      commands: Array<{
        name: string
        description?: string
        input?: { hint?: string } | null
        _meta?: { scope?: string; path?: string; bareName?: string; qualifiedName?: string }
      }>
    }
