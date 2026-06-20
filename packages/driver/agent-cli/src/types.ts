/**
 * AIP-45 AgentCliDefinition + AgentCliHandle.
 *
 * Mirrors `resources/aip-45/draft/AGENT-CLI.schema.json`. Top-level
 * fields cover the binary's install / version / auth / sandbox /
 * protocol surface; `protocol` discriminates between ACP, MCP, and
 * proprietary adapter arms.
 */

import type { StreamEvent } from "@agentproto/acp"

export type { StreamEvent }

export type AgentCliProtocol = "acp" | "mcp" | "proprietary" | "print"
export type AgentCliSessionMode = "ephemeral" | "persistent" | "resumable"

export interface AgentCliInstallMethod {
  method:
    | "brew"
    | "apt"
    | "dnf"
    | "pacman"
    | "choco"
    | "scoop"
    | "npm"
    | "pip"
    | "cargo"
    | "go"
    | "curl"
    | "download"
    | "vendored"
  package?: string
  url?: string
  path?: string
  extract_bin?: string
  verify_sha256?: string
  global?: boolean
  user?: boolean
  experimental?: boolean
}

export interface AgentCliVersionCheck {
  cmd: string
  parse: string
  range: string
  timeout_ms?: number
}

export interface AgentCliAuth {
  ref?: string
  state?: { paths?: string[]; env?: string[] }
  login?: { cmd: string; interactive?: boolean; requires_callback_url?: boolean }
  refresh?: { cmd: string; interval_s?: number }
  expiry?: { parse?: string; grace_s?: number }
}

/**
 * Re-runnable health check that, when matching, skips the enclosing
 * setup step. Lets `agentproto setup <slug>` re-runs be idempotent
 * without storing extra completion-ledger state — when the cmd's
 * exit code matches `exit_code` (default 0), the step is treated as
 * already satisfied and the host moves on.
 */
export interface AgentCliSetupSkipIf {
  cmd: string
  exit_code?: number
  timeout_ms?: number
}

/**
 * Where a setup step's captured value lands so the runner can reuse
 * it on every spawn. Exactly one of the three forms — env / secret /
 * cmd — applies.
 */
export type AgentCliSetupPersist =
  | {
      /** Env var the runner injects on every spawn (lifted from the
       *  workspace secrets store, never logged). */
      env: string
      secret_slug?: never
      cmd?: never
    }
  | {
      env?: never
      /** AIP-19 secret slug to write the value into. */
      secret_slug: string
      cmd?: never
    }
  | {
      env?: never
      secret_slug?: never
      /** Run this command with `${value}` substituted by the captured
       *  value. Use for CLIs that expect their own config command
       *  (e.g. `openclaw config set gateway.remote.token ${value}`). */
      cmd: string
    }

/**
 * AIP-29 § Setup — one step in the post-install configuration
 * pipeline. Discriminated by `kind`; the host runs steps in declared
 * order and persists completion per (bundle.id, workspace.id, user.id).
 */
export type AgentCliSetupStep =
  | {
      id: string
      kind: "cmd"
      cmd: string
      description?: string
      skip_if?: AgentCliSetupSkipIf
      timeout_ms?: number
      interactive?: boolean
      persist?: AgentCliSetupPersist
    }
  | {
      id: string
      kind: "prompt"
      prompt: string
      description?: string
      type?: "text" | "select" | "boolean" | "secret"
      default?: string
      options?: string[] | { cmd: string; timeout_ms?: number }
      skip_if?: AgentCliSetupSkipIf
      persist?: AgentCliSetupPersist
    }
  | {
      id: string
      kind: "oauth"
      secret_slug: string
      description?: string
      skip_if?: AgentCliSetupSkipIf
    }
  | {
      id: string
      kind: "external"
      url: string
      description?: string
      callback?: { param?: string; timeout_ms?: number }
      skip_if?: AgentCliSetupSkipIf
      persist?: AgentCliSetupPersist
    }

export interface AgentCliSession {
  mode?: AgentCliSessionMode
  idle_timeout_ms?: number
  max_turns?: number
  context_carryover?: boolean
}

export interface AgentCliModels {
  default?: string
  allowed?: string[]
  env?: Record<string, string>
}

export interface AgentCliCapabilities {
  streaming?: boolean
  tool_calls?: boolean
  sub_agents?: boolean
  file_io?: boolean
  multimodal?: boolean
  resumable?: boolean
  bidirectional?: boolean
  /**
   * Adapter can ingest a filesystem path that the host UI just placed
   * on disk (host-side drag-drop into a terminal pastes the path
   * here). Implies the adapter has a Read-file tool wired. Hosts gate
   * drag-drop UI on this flag — defaults to false (conservative).
   * Paired with the daemon's POST /files/upload route.
   */
  file_attach?: boolean
}

/**
 * AIP-45 mode declaration — a mutually-exclusive operation profile
 * the CLI exposes. The host picks at most ONE mode per turn via
 * `OPERATOR.runtime.config.mode`. Mode patches apply AFTER the
 * manifest's default `bin_args` and BEFORE option patches.
 */
export interface AgentCliMode {
  id: string
  description?: string
  bin_args_append?: string[]
  env?: Record<string, string>
}

export type AgentCliOptionType = "boolean" | "integer" | "string" | "enum"

/**
 * AIP-45 option declaration — an independent typed knob. Multiple
 * options may be active per turn; each option's patch is independent
 * and applied in declaration order, AFTER mode patches.
 */
export interface AgentCliOption {
  id: string
  type: AgentCliOptionType
  description?: string
  /** Required when type === "enum". */
  enum?: string[]
  default?: boolean | number | string
  /** Inclusive lower bound when type === "integer". */
  min?: number
  /** Inclusive upper bound when type === "integer". */
  max?: number
  /**
   * Argv template appended when the option has a non-default value.
   * The literal token `{value}` is replaced with the option's value
   * (stringified). Use for value-bearing flags like `--model {value}`.
   */
  bin_args_template?: string[]
  /**
   * Argv appended when type === "boolean" AND value === true. Use for
   * bare flags like `--auto`.
   */
  bin_args_append_when_true?: string[]
  /**
   * Env vars to merge when the option has a non-default value. Values
   * may contain `{value}` for templating.
   */
  env?: Record<string, string>
}

/**
 * Built-in continuation strategy ids. Future custom strategies require
 * a follow-up AIP that opens this enum. Keep this in lockstep with
 * `continuationStrategyId` in `AGENT-CLI.schema.json`.
 */
export type ContinuationStrategyId =
  | "none"
  | "pinned-session"
  | "transcript"
  | "native-resume"

/**
 * AIP-45 continuation declaration — declares HOW prior turns reach the
 * CLI on subsequent invocations. Hosts MUST refuse to dispatch with a
 * strategy outside `supported`; the operator MAY override `default` via
 * `OPERATOR.runtime.config.continuation` provided the chosen id is in
 * `supported`.
 */
export interface AgentCliContinuation {
  default: ContinuationStrategyId
  supported: ContinuationStrategyId[]
  pinned_session?: AgentCliPinnedSessionTuning
}

/** Tuning for the `pinned-session` strategy. Ignored by other strategies. */
export interface AgentCliPinnedSessionTuning {
  /** How long an idle pinned session is kept alive before the driver
   *  closes it. Applies in addition to the CLI's own
   *  `session.idle_timeout_ms`. Default 1_800_000 (30 min). */
  idle_timeout_ms?: number
  /**
   * Composite key that uniquely identifies a pinned session. Default
   * `["conversation", "operator"]` — different conversations get
   * different child processes; one operator per conversation reuses
   * one process across turns.
   */
  key_scope?: ContinuationKeyScope[]
}

export type ContinuationKeyScope =
  | "conversation"
  | "operator"
  | "user"
  | "guild"
  | "workspace"

export interface AgentCliMcpBlock {
  command?: string
  args?: string[]
  transport: "stdio" | "http" | "sse"
  url?: string
}

export interface AgentCliRequires {
  os?: ("darwin" | "linux" | "windows")[]
  arch?: ("x64" | "arm64" | "x86" | "arm")[]
  min_disk_mb?: number
  min_memory_mb?: number
}

export interface AgentCliExample {
  goal: string
  prompt: string
  note?: string
}

export interface AgentCliDefinition {
  name: string
  id: string
  description: string
  version: string
  bin: string
  bin_args?: string[]
  install: AgentCliInstallMethod[]
  version_check: AgentCliVersionCheck
  /** AIP-29 § Setup — post-install configuration pipeline. Optional. */
  setup?: AgentCliSetupStep[]
  auth?: AgentCliAuth
  sandbox: string | Record<string, unknown>
  runner?: string | Record<string, unknown>
  protocol: AgentCliProtocol
  /** REQUIRED when protocol=acp. Workspace-relative ref to AIP-44 ACP.md. */
  acp?: string
  /** REQUIRED when protocol=mcp. */
  mcp?: AgentCliMcpBlock
  /** REQUIRED when protocol=proprietary. NPM package implementing AgentCliClient. */
  adapter?: string
  session?: AgentCliSession
  models?: AgentCliModels
  capabilities?: AgentCliCapabilities
  /** AIP-45 modes (mutually-exclusive operation profiles). */
  modes?: AgentCliMode[]
  /** AIP-45 options (independent typed knobs). */
  options?: AgentCliOption[]
  /** AIP-45 continuation policy (how prior turns reach the CLI). */
  continuation?: AgentCliContinuation
  requires?: AgentCliRequires
  examples?: AgentCliExample[]
  tags?: string[]
  metadata?: Record<string, unknown>
}

export type AgentCliHandle = Readonly<AgentCliDefinition>

/**
 * Connection options handed to a protocol arm by the runner. Sandbox
 * resolution + secrets injection happen *before* this point — the arm
 * receives a flat env map and a working dir.
 */
export interface AgentCliConnectOptions {
  cwd: string
  env: Record<string, string>
  abortSignal: AbortSignal
  /**
   * When set, the protocol arm reattaches to the agent's existing
   * session with this id (ACP `loadSession`, MCP equivalent, or argv
   * `--resume`) instead of starting a fresh one. The agent decides
   * the wire mechanics; the host is responsible for having stored the
   * id from a prior `connect → newSession`.
   *
   * Drives the `native-resume` continuation strategy. Arms that don't
   * support resume MAY ignore this field; the runner won't reject it
   * because per-protocol semantics aren't visible at this layer.
   */
  resumeSessionId?: string
}

/**
 * Per-turn dispatch shape. Implemented by every protocol arm
 * (ACP, MCP, proprietary). The runner is the only call site for
 * these methods; consumers see {@link AgentCliSession} instead.
 */
export interface AgentCliClient {
  connect(opts: AgentCliConnectOptions): Promise<void>
  send(turnId: string, message: unknown): Promise<void>
  events(): AsyncIterable<StreamEvent>
  cancel(turnId: string): Promise<void>
  close(): Promise<void>
  /**
   * The session id the protocol arm holds. Populated after `connect()`
   * resolves — for `newSession` calls it's whatever the agent assigned;
   * for `loadSession` (resume) calls it's the same id the host passed
   * in. Hosts persist this so a future cold start can resume.
   *
   * Empty string before connect or for protocols that don't have a
   * session concept (proprietary one-shots).
   */
  readonly sessionId?: string
  /**
   * Diagnostic hook — returns the last N lines of the child's stderr,
   * joined with newlines. Set by the runner after spawn; read by
   * `promptTurn` to enrich error events with process-level context.
   * Not part of the protocol; internal to the runner.
   */
  _stderrTail?: () => string
}

/**
 * The runtime handle returned by `defineAgentCli` — call `.start()`
 * to spawn the binary and obtain a {@link AgentCliRuntimeSession}.
 */
export interface AgentCliRuntime {
  readonly definition: AgentCliHandle
  start(opts?: AgentCliStartOptions): Promise<AgentCliRuntimeSession>
}

export interface AgentCliStartOptions {
  cwd?: string
  env?: Record<string, string>
  signal?: AbortSignal
  /**
   * Per-turn runtime configuration — selects a manifest mode, sets
   * options, and picks the continuation strategy. Validated against
   * the manifest's declarations before spawn; unknown ids reject.
   */
  config?: RuntimeConfig
  /**
   * Identity context the host hands to the continuation strategy.
   * The pinned-session strategy uses this to derive its session-pin
   * key (per `manifest.continuation.pinned_session.key_scope`); other
   * strategies may ignore. Hosts SHOULD always pass this when in a
   * conversation context — without it, pinning can't be keyed and
   * the strategy falls back to per-spawn behaviour.
   */
  turnCtx?: TurnContext
  /**
   * Reattach to an existing protocol session (ACP `loadSession`, MCP
   * equivalent, argv `--resume`) instead of spawning fresh. The
   * `native-resume` strategy populates this from the host's persisted
   * (turnCtx → sessionId) lookup. Other strategies leave undefined.
   * Forwarded verbatim to `protocolArm.connect({ resumeSessionId })`.
   */
  resumeSessionId?: string
}

/**
 * Operator-side runtime configuration. Mirrors the `runtime.config`
 * block in AIP-9 OPERATOR.md. Every field is optional; omitted fields
 * fall back to the manifest's declared defaults.
 */
export interface RuntimeConfig {
  /** Manifest-declared mode id. Unknown ids reject at validation time. */
  mode?: string
  /** Manifest-declared option ids → values. Type / enum / bound checked. */
  options?: Record<string, boolean | number | string>
  /** Continuation strategy id. Must be in `manifest.continuation.supported`. */
  continuation?: ContinuationStrategyId
}

/**
 * Identity scope for continuation key derivation. The host populates
 * the fields it knows; the pinned-session strategy's `key_scope` array
 * picks which to actually combine. Missing fields the scope asked for
 * downgrade the strategy to per-spawn behaviour with a console warning
 * (rather than silently colliding pins across operators / conversations).
 */
export interface TurnContext {
  conversation?: string
  operator?: string
  user?: string
  guild?: string
  workspace?: string
}

export interface AgentCliRuntimeSession {
  readonly sessionId: string
  send(message: unknown): AsyncIterable<StreamEvent>
  cancel(): Promise<void>
  close(): Promise<void>
}
