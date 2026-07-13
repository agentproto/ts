/**
 * AIP-45 AgentCliDefinition + AgentCliHandle.
 *
 * Mirrors `resources/aip-45/draft/AGENT-CLI.schema.json`. Top-level
 * fields cover the binary's install / version / auth / sandbox /
 * protocol surface; `protocol` discriminates between ACP, MCP, and
 * proprietary adapter arms.
 */

import type {
  AcpMcpServer,
  AcpPermissionResolution,
  StreamEvent,
} from "@agentproto/acp"

export type { AcpMcpServer, AcpPermissionResolution, StreamEvent }

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
  /**
   * Per-turn silence watchdog (ms) — distinct from `idle_timeout_ms`,
   * which bounds time BETWEEN turns. This bounds true silence DURING a
   * single turn: if the adapter goes this long with no activity signal
   * and its `prompt` call still hasn't resolved, the ACP client
   * synthesizes a `turn-end` with `reason: "watchdog-timeout"` instead
   * of hanging forever (see `@agentproto/acp/client`'s
   * `AcpClientOptions.turnIdleTimeoutMs`). Undefined (the default)
   * disables the watchdog — set this only for adapters known to
   * sometimes drop the final `prompt` response (e.g. hermes).
   */
  turn_idle_timeout_ms?: number
  max_turns?: number
  context_carryover?: boolean
}

export interface AgentCliModels {
  default?: string
  allowed?: string[]
  /**
   * Model-id patterns this adapter must NEVER route to, even when a caller
   * passes the id explicitly (the `model` option is free-form, so `allowed`
   * is only a curated menu and can't *prevent* an off-menu id). Each pattern
   * matches case-insensitively against the requested model id and supports a
   * single trailing `*` wildcard (prefix match); otherwise exact. A match is
   * refused at compose time (`RuntimeConfigError`, code `model_denied`).
   * Use to reserve a premium provider for a dedicated adapter — e.g. hermes
   * denies `["anthropic/*", "claude-*"]` so Anthropic models stay exclusive
   * to the claude-code adapter.
   */
  deny?: string[]
  env?: Record<string, string>
  /**
   * How the host selects a model at session start:
   *   - "config"  (default) — apply via ACP `session/set_config_option`
   *     with `configId:"model"` right after `newSession`. Works for ACP
   *     wrappers that expose model as a session config (e.g. claude-code).
   *   - "command" — `set_config_option` is a no-op / silently rejected on
   *     this agent (e.g. hermes), so instead send a `/model <id>` control
   *     turn after `newSession` and drain it. The agent's reply is checked
   *     for a "switched" acknowledgement; a failure is warned, not fatal.
   * Omit → "config".
   */
  apply?: "config" | "command"
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
 * Support status for a declared mode. Absent ⇒ treated as `"active"`.
 *   active  — the mode does what its description claims.
 *   noop    — declared and accepted, but measured to have no effect
 *             (argv/env compose fine, but the observable outcome is
 *             identical to not passing it). Kept declared for honesty
 *             and so a future fix can flip it back to `active`.
 *   planned — declared as an intended surface but not wired yet.
 */
export type AgentCliModeStatus = "active" | "noop" | "planned"

/**
 * AIP-45 mode declaration — a mutually-exclusive operation profile
 * the CLI exposes. The host picks at most ONE mode per turn via
 * `OPERATOR.runtime.config.mode`. Mode patches apply AFTER the
 * manifest's default `bin_args` and BEFORE option patches.
 */
export interface AgentCliMode {
  id: string
  description?: string
  /**
   * Extra argv prepended BEFORE the manifest's default `bin_args` when
   * this mode is active. Needed for CLIs whose global flags must
   * precede a subcommand baked into `bin_args` (e.g. hermes'
   * `--ignore-user-config` must come before `acp`, where
   * `bin_args_append` would land it too late).
   */
  bin_args_prepend?: string[]
  bin_args_append?: string[]
  env?: Record<string, string>
  /**
   * Env keys to DELETE from the spawn env when this mode is active.
   * Applied at the runtime's env-merge point (after the ambient
   * process.env + mode/option env are combined), so a mode can scrub a
   * credential that must never reach a non-native endpoint — e.g. a
   * gateway mode scrubbing `ANTHROPIC_API_KEY` so it can't leak to a
   * third-party Anthropic-compatible host (it would both 401 and expose
   * the real key). Unlike `env`, this can't be expressed as a static
   * set (a key set to "" is still present); deletion is the only safe
   * semantics. Mirrors the in-code scrub `claude-sdk` does in
   * `buildQueryOptions`; surfaced here so CLI-adapter gateway modes
   * get the same auth hygiene without per-adapter code.
   */
  env_unset?: string[]
  /**
   * Honest support status surfaced to clients (e.g. via `adapter_list`).
   * Lets an adapter admit that a declared mode is a measured no-op or
   * not-yet-wired instead of silently accepting it. Absent ⇒ `"active"`.
   */
  status?: AgentCliModeStatus
  /** Human-readable reason backing `status` (e.g. what was measured). */
  status_note?: string
  /**
   * How the host activates this mode at session start:
   *   - "bin_args" (default) — apply via this mode's `bin_args_prepend` /
   *     `bin_args_append` / `env`, composed into argv/env at spawn time.
   *     Preserves every existing adapter's behavior unchanged.
   *   - "config" — this CLI has no argv/env surface for mode selection;
   *     instead the mode id is forwarded to the ACP arm's `connect({mode})`
   *     and applied via `session/set_config_option` with `configId:"mode"`
   *     after `newSession` (e.g. opencode). `bin_args_prepend` /
   *     `bin_args_append` / `env` are ignored for a mode declaring this.
   * Omit → "bin_args".
   */
  apply?: "bin_args" | "config"
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
   * Argv template prepended BEFORE the manifest's default `bin_args`
   * when the option has a non-default value. The literal token
   * `{value}` is replaced with the option's value (stringified). Use
   * for value-bearing global flags that must precede a subcommand
   * (e.g. hermes' `--skills {value}`).
   */
  bin_args_prepend?: string[]
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
  /**
   * Env keys to DELETE from the spawn env when the option has a
   * non-default value. Symmetric with `AgentCliMode.env_unset` and
   * applied at the same runtime env-merge point. Lets a single option
   * carry both the value it sets AND the credential it must displace —
   * e.g. a `base_url` option pointing at a third-party Anthropic-
   * compatible gateway should scrub the ambient `ANTHROPIC_API_KEY`
   * so it can't leak, without forcing the operator to also pick a
   * preset mode. The deletion runs before operator-supplied `opts.env`
   * is merged, so a caller can still re-inject a specific key if they
   * truly intend to.
   */
  env_unset?: string[]
}

/**
 * AIP-45 gateway-preset declaration — a backend an Anthropic/OpenAI-
 * compatible client can front, declared by the adapter that knows how to
 * drive it. The manifest authoring shape; the runtime normalizes it to a
 * `ProviderPreset` (via the catalog's merge seam) so adapter-declared
 * presets appear in `agentproto presets list` / `list_provider_presets`
 * alongside the built-in registry. Data-only — no adapter projection
 * (`env`/`env_unset`/`bin_args`) here; that stays in the adapter's modes
 * and options, same as the built-in presets are projected today.
 */
export interface AgentCliPresetDeclaration {
  /**
   * Stable preset id. SHOULD equal the mode id if the adapter projects
   * this preset as a mode (e.g. `moonshot`, `openrouter`). Catalog
   * dedupes built-in vs adapter-declared by id; an adapter-declared id
   * that collides with a built-in is ignored in favor of the built-in
   * (the registry is the source of truth for canonical providers).
   */
  id: string
  /** Human label for the catalog UI ("Moonshot (Kimi)"). */
  label: string
  /** Short description; surfaced in the catalog. */
  description?: string
  /** API schema flavor — selects which adapter family can consume it. */
  schemaFlavor: "anthropic" | "openai"
  /** Base URL the client hits. */
  baseUrl: string
  /**
   * Conventional env var holding this provider's API key
   * (e.g. MOONSHOT_API_KEY). Catalog status is derived from its presence
   * in the daemon's environment ("ready" vs "available").
   */
  keyEnv: string
  /**
   * Env vars to scrub when this preset is active. Optional at the
   * manifest level — an adapter that scrubs in code (like claude-sdk)
   * may omit it. The catalog does not surface `scrubEnv` to clients.
   */
  scrubEnv?: string[]
  /** Conventional default model id for this provider, if any. */
  defaultModel?: string
  /** Optional homepage/docs URL for the catalog UI. */
  homepage?: string
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

/**
 * AIP-45 § Print protocol configuration.
 *
 * When `protocol: "print"`, this block declares the CLI's one-shot
 * headless surface so the print arm can construct the correct argv and
 * map the CLI's wire events to {@link StreamEvent}. Omit to use
 * Claude Code defaults (backward-compatible).
 */
export interface AgentCliPrintConfig {
  /**
   * How the prompt text is passed to the binary.
   * - absent / `"positional"` — appended as the last positional arg
   *   (Claude: `claude --print ... <prompt>`).
   * - a string — passed as `--<prompt_flag> <text>` before any trailing
   *   positional args (Mastra Code: `--prompt`).
   */
  prompt_flag?: string
  /**
   * Output format flags appended before the prompt. Defaults to
   * `["--output-format", "stream-json"]` (Claude Code).
   *
   * Mastra Code uses `["--output", "jsonl"]`.
   */
  output_format?: string[]
  /**
   * Extra flags inserted between `output_format` and the prompt.
   * Claude Code uses `["--no-interactive"]`; Mastra Code omits this.
   */
  pre_prompt?: string[]
  /**
   * Resume / continue flag for reattaching to a prior session.
   *
   * Claude:  `{ flag: "--resume", kind: "value" }`
   * Mastra:  `{ flag: "--continue", kind: "boolean" }` — OR
   *          `{ flag: "--thread", kind: "value" }` for explicit thread id
   */
  resume?: {
    flag: string
    /** "value" = `--flag <sessionId>`, "boolean" = `--flag` (bare). */
    kind: "value" | "boolean"
  }
  /**
   * Which event taxonomy the CLI emits on stdout (JSONL / stream-json).
   * The print arm picks the matching event mapper.
   *
   * - `"claude-stream-json"` (default) — Claude Code's
   *   `--output-format stream-json` taxonomy.
   * - `"mastra-jsonl"` — Mastra Code's `--output jsonl` taxonomy
   *   (`AgentControllerEvent` shapes).
   */
  event_schema?: "claude-stream-json" | "mastra-jsonl"
}

export interface AgentCliDefinition {
  name: string
  id: string
  description: string
  version: string
  bin: string
  bin_args?: string[]
  /**
   * Static environment variables always merged into the spawn env,
   * before any mode/option env patch (so those can still override).
   * The always-on counterpart to `modes[].env` / `options[].env`, which
   * only apply when the corresponding mode/option is selected. Primary
   * user is a generic ACP agent (`acpHandleFromSpec`) whose whole config
   * surface is bin + args + env; a native adapter can use it too for env
   * that should apply on every spawn regardless of mode.
   */
  env?: Record<string, string>
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
  /** OPTIONAL when protocol=print. Declares the one-shot CLI surface. */
  print?: AgentCliPrintConfig
  session?: AgentCliSession
  models?: AgentCliModels
  capabilities?: AgentCliCapabilities
  /** AIP-45 modes (mutually-exclusive operation profiles). */
  modes?: AgentCliMode[]
  /** AIP-45 options (independent typed knobs). */
  options?: AgentCliOption[]
  /**
   * AIP-45 gateway presets this adapter can drive. Adapter-declared
   * presets are merged into the provider-preset catalog
   * (`agentproto presets list` / `list_provider_presets`) alongside the
   * built-in registry, deduped by id (built-in wins on collision). Lets
   * an external adapter surface a gateway the built-in registry doesn't
   * know about without patching `@agentproto/provider-presets`.
   */
  presets?: AgentCliPresetDeclaration[]
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
  /**
   * MCP servers to mount into the agent's session at spawn time. For
   * the ACP arm these are forwarded verbatim into
   * `session/new.mcpServers` (and `session/load.mcpServers` on resume),
   * giving the child agent a scoped toolset the host chose — e.g. the
   * daemon's own orchestration gateway so a spawned agent can itself
   * spawn + supervise sub-agents. Arms that don't model MCP mounting
   * ignore this field.
   */
  mcpServers?: AcpMcpServer[]
  /**
   * Model to activate at session start. For the ACP arm this is
   * applied via `session/set_config_option` with `configId:"model"`
   * immediately after `newSession` — the ACP wrapper (claude-agent-acp)
   * does not forward CLI flags to the underlying claude process so
   * bin_args_template alone cannot change the model.
   */
  model?: string
  /**
   * Effort level to apply at session start. Effort is model-dependent:
   * the same label ("high", "xhigh", …) maps to different underlying
   * computation budgets per model, and the default differs by model
   * (e.g. Sonnet 4.6 / Opus 4.8 default to "high"; Opus 4.7 to
   * "xhigh"). Omit to keep the model's own default. Applied via
   * `session/set_config_option` with `configId:"effort"` on ACP arms.
   */
  effort?: string
  /**
   * Mode to activate at session start, for ACP arms whose CLI models
   * mode selection as a session config option rather than an argv/env
   * surface (`AgentCliMode.apply === "config"`, e.g. opencode). Applied
   * via `session/set_config_option` with `configId:"mode"` immediately
   * after `newSession`, best-effort like `model`/`effort`. Adapters that
   * apply mode via `bin_args`/`env` instead (claude-code) leave this
   * unset and are unaffected.
   */
  mode?: string
  /**
   * Called on ANY adapter-process activity observed by the protocol
   * arm — incoming ACP `session/update` notifications (even ones that
   * don't translate into a `StreamEvent`) and outbound RPC calls
   * (`newSession`/`loadSession`/`prompt`/`cancel`/`setSessionConfigOption`).
   * Distinct from ring-buffer output: fires during long internal
   * tool-call chains where no `StreamEvent` reaches the host, so a
   * supervisor can tell "still working" apart from "gone quiet."
   * Arms that don't model a stdio JSON-RPC channel (proprietary
   * one-shots) MAY ignore this field.
   */
  onActivity?: () => void
  /**
   * When true, the ACP arm surfaces each `session/request_permission` as an
   * `agent-prompt` StreamEvent and HOLDS the RPC until the host calls
   * `respondPermission` — forwarded to the arm's
   * `createAcpProtocolArm({ permissionHold })`. Arms with no permission
   * surface (non-ACP) ignore it. Default false (auto-answer, unchanged).
   */
  permissionHold?: boolean
  /**
   * Turn-idle watchdog, forwarded verbatim to the ACP arm's
   * `createAcpClient({ turnIdleTimeoutMs })` (see
   * `@agentproto/acp/client`'s `AcpClientOptions.turnIdleTimeoutMs` for
   * the full contract). If a turn goes this many ms with no activity
   * signal and the underlying adapter call still hasn't resolved, the
   * arm synthesizes a `turn-end` event with `reason: "watchdog-timeout"`
   * instead of hanging forever. Undefined disables the watchdog. Arms
   * that don't model a stdio JSON-RPC channel MAY ignore this field.
   */
  turnIdleTimeoutMs?: number
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
  /**
   * Resolve a permission request parked by permission-hold mode — `requestId`
   * is the `toolCallId` carried on the `agent-prompt` StreamEvent that
   * surfaced it. Returns true when a matching parked request was found and
   * resolved. Only the ACP arm implements this; other arms omit it.
   */
  respondPermission?(
    requestId: string,
    resolution: AcpPermissionResolution,
  ): boolean
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
  /**
   * MCP servers to mount into the spawned agent's session. Threaded
   * through to `protocolArm.connect({ mcpServers })` → the ACP arm's
   * `session/new.mcpServers`. Lets the host inject a scoped toolset
   * (e.g. the daemon's orchestration gateway) at spawn time.
   */
  mcpServers?: AcpMcpServer[]
  /**
   * Called on any adapter-process activity (ACP JSON-RPC traffic in
   * either direction). Forwarded verbatim to
   * `protocolArm.connect({ onActivity })` — see
   * {@link AgentCliConnectOptions.onActivity} for the full contract.
   * Lets a host track session liveness independent of ring-buffer
   * output, e.g. during a long internal tool-call chain.
   */
  onActivity?: () => void
  /**
   * Turn-idle watchdog timeout in ms, forwarded to
   * `protocolArm.connect({ turnIdleTimeoutMs })` — see
   * {@link AgentCliConnectOptions.turnIdleTimeoutMs}. When omitted here,
   * `createAgentCliRuntime(...).start()` falls back to the manifest's
   * `session.turn_idle_timeout_ms` (if the adapter declares one), so a
   * host doesn't have to opt in per-call for an adapter that always
   * wants this protection.
   */
  turnIdleTimeoutMs?: number
  /**
   * When true, the spawned session runs in permission-hold mode: the ACP arm
   * surfaces each permission request as an `agent-prompt` StreamEvent and
   * HOLDS the RPC until the host calls `respondPermission`. Forwarded to
   * `protocolArm.connect({ permissionHold })`. Default false (unchanged
   * auto-answer behaviour for every existing caller).
   */
  permissionHold?: boolean
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
  /**
   * OS-level process id of the spawned child, when the runtime owns a
   * real subprocess (every current arm — ACP, print — does). Lets a
   * host compute a cheap `processAlive` liveness check
   * (`process.kill(pid, 0)`) without adapter-specific forensics.
   * Undefined for a future arm with no owned process (e.g. a
   * WebSocket transport).
   */
  readonly pid?: number
  send(message: unknown): AsyncIterable<StreamEvent>
  cancel(): Promise<void>
  /**
   * Resolve a permission request parked by permission-hold mode (see
   * `AgentCliStartOptions.permissionHold`). Delegates to the protocol arm's
   * `respondPermission`; returns true when a matching parked request was
   * resolved. Absent for arms that don't model held permissions.
   */
  respondPermission?(
    requestId: string,
    resolution: AcpPermissionResolution,
  ): boolean
  close(): Promise<void>
}
