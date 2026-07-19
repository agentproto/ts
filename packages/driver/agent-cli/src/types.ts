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
import type { SessionConfigOption, SessionMode } from "@agentproto/acp/client"

export type {
  AcpMcpServer,
  AcpPermissionResolution,
  StreamEvent,
  SessionConfigOption,
  SessionMode,
}

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
 * The `subscription` (OAuth / bearer) billing mode declaration — the ONE
 * axis of the billing-auth resolver that isn't a shared provider fact, so it
 * lives on the adapter manifest rather than in the model catalog. Its env var
 * is consumer-specific (claude CLI wrapper → `CLAUDE_CODE_OAUTH_TOKEN`;
 * claude-sdk → `ANTHROPIC_AUTH_TOKEN`). Presence of this field is what tells
 * the runtime "this adapter supports `subscription` mode"; an adapter without
 * it that's asked for `subscription` fails with `unsupported_auth_mode`.
 *
 * The api-key axis needs NO such declaration — its env var derives from the
 * catalog's `PROVIDER_KEY_ENV` via `providerEnvVar(provider)`; only the
 * runtime resolver reads it, never this manifest.
 */
export interface AgentCliAuthSubscription {
  /** Env var SET to the resolved subscription credential (the OAuth/bearer
   *  token). */
  setEnv: string
  /**
   * Sibling billing-credential env vars the SAME consumer also honors and
   * that must therefore be scrubbed in EVERY resolved mode except when the
   * var IS the one being set — a leftover of one of these would silently
   * override the credential this spawn stated (the org-credit-leak class).
   * For anthropic: the generic bearer `ANTHROPIC_AUTH_TOKEN`, which the
   * claude binary honors above `ANTHROPIC_API_KEY`. Distinct from
   * {@link unsetEnvAdd} (which is native-mode-only gateway hygiene, not a
   * credential).
   */
  conflictEnv?: string[]
  /**
   * Extra env vars scrubbed ONLY in `subscription` (native) mode — gateway
   * hygiene, not credentials: cloud-provider redirect toggles
   * (`CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`/…) + `ANTHROPIC_BASE_URL`, any of
   * which would reroute or 401 a natively-billed spawn. Left present in
   * api-key mode (a deliberate api-key + Bedrock combination is valid there),
   * which is why this is separate from {@link conflictEnv}.
   */
  unsetEnvAdd?: string[]
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

/**
 * A `models.allowed` entry that states who serves/bills a model and how
 * this adapter reaches it — the structured alternative to a bare id
 * string. `provider` is *who* (a `ProviderPreset` id, or a direct
 * provider like "anthropic"); `mode` is *how this adapter* gets there
 * (its own `modes[].id`), which is NOT redundant with `provider`: an
 * adapter that routes by id prefix (opencode) needs no mode at all,
 * while one that needs `ANTHROPIC_BASE_URL` pre-wired (claude-sdk,
 * claude-code) does. Omit `mode` when the adapter routes on its own.
 */
export interface AgentCliModelEntry {
  /** Model id, unchanged on the wire — this annotates, never renames. */
  id: string
  /** Who serves/bills this model. Omit when unstated — an unstated
   *  provider must never be guessed downstream (a wrong-but-confident
   *  guess would bill the wrong account). */
  provider?: string
  /** This adapter's mode id that routes to `provider`. Omit when the
   *  adapter routes on its own or the model needs no mode switch. */
  mode?: string
}

export interface AgentCliModels {
  default?: string
  /**
   * Model ids the host MAY route to. A bare string keeps meaning exactly
   * what it means today (provider unstated, adapter default) — additive,
   * so no existing manifest breaks. A structured entry additionally
   * states `provider`/`mode` (see {@link AgentCliModelEntry}).
   */
  allowed?: Array<string | AgentCliModelEntry>
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
   *   - "arg" — this CLI takes its model as a CLI argument, not an ACP
   *     session config or control turn (e.g. codex-acp's `-c model="<id>"`).
   *     The requested model is composed into `bin_args` at spawn time via
   *     `bin_args_template` (below) — no post-`newSession` ACP call is
   *     made at all.
   * Omit → "config".
   */
  apply?: "config" | "command" | "arg"
  /**
   * Argv template composed into `bin_args` at spawn time when
   * `apply === "arg"` and a model was requested. The literal token
   * `{model}` is replaced with the requested model id, one-for-one per
   * array element (mirrors `AgentCliOption.bin_args_template`'s
   * `{value}` token). Appended after the manifest's default `bin_args`,
   * same position as an option's own `bin_args_template`. Required when
   * `apply === "arg"`; ignored otherwise.
   */
  bin_args_template?: string[]
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
   * Which orthogonal session-config axis (SPEC-tracked in
   * `@agentproto/runtime`'s `session-config.ts`) this mode expresses. Narrowed
   * to the single value `"context"` (what enters context — e.g. claude-code's
   * `lean` env toggle), the only concern with no ACP-protocol home (SPEC §3.4a).
   *
   * Route and posture are NO LONGER manifest modes: `"route"` (endpoint/billing
   * rail) is derived from the model catalog (`@route` route-identity), and
   * `"posture"` (what the agent may DO — plan/accept-edits/bypass/read-only)
   * comes from the harness's own ACP mode registry
   * (`SessionModeState.availableModes`). The legacy `"posture"`/`"route"`
   * classification survives only inside the daemon's back-compat `decomposeMode`
   * shim (`@agentproto/runtime`'s `DeclaredAdapterMode`), which still maps the
   * old ids during migration — it is not a value the manifest may declare.
   * Omitted ⇒ inferred from the id.
   */
  kind?: "context"
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
  /**
   * FIXED billing provider for a single-provider adapter (`claude-code` /
   * `claude-sdk` → `"anthropic"`, `codex` → `"openai"`, `hermes` →
   * `"openrouter"`). A `CatalogProvider` id (typed as `string` here to keep
   * this generic AIP-45 doctype decoupled from `@agentproto/model-catalog` —
   * the runtime resolver validates it against the catalog and derives the
   * api-key env via `providerEnvVar`). Omitted for by-model routers, whose
   * provider the resolver derives from the requested model
   * (`getModelProvider`). Consumed by the runtime billing-auth resolver, NOT
   * by this driver (which stays mechanical).
   */
  provider?: string
  /**
   * Declares that this adapter supports `subscription` billing mode and how
   * (which env var to set + what to scrub). Presence = supported; absence
   * means a `subscription` request is rejected with `unsupported_auth_mode`.
   * Only the Claude adapters set it. See {@link AgentCliAuthSubscription}.
   */
  authSubscription?: AgentCliAuthSubscription
  /**
   * When the runtime billing-auth resolver ENGAGES credential injection:
   *   - `"when-configured"` (default) — only when an operator explicitly set
   *     `auth` (per-spawn or in `defaults.adapters.<slug>.auth`). Non-breaking:
   *     an adapter with no auth config runs ambient, unchanged.
   *   - `"always"` — every spawn, even with nothing configured (then it
   *     fails fast with `missing_auth_credential`). Only `claude-code` sets
   *     this, preserving its #312 fail-fast contract.
   */
  authEnforce?: "always" | "when-configured"
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
 * Result of a mid-session model-switch attempt — see
 * {@link AgentCliRuntimeSession.setModel}. Mirrors
 * `@agentproto/acp/client`'s `SetConfigOptionResult` (this package stays
 * decoupled from `@agentproto/acp`'s client subpath by not importing its
 * type, hence the structural duplicate) plus the applied model id, so a
 * caller can echo back exactly what took effect.
 */
export interface SetModelResult {
  applied: boolean
  /** The model id that took effect. Present only when `applied` is true. */
  model?: string
  /**
   * Present only when `applied` is false. Canonical values:
   *   - `"requires-restart"` — this adapter's `models.apply` is `"arg"`;
   *     the model is baked into argv at spawn time and cannot change on a
   *     live session.
   *   - `"not-supported"` — the protocol arm has no mid-session config
   *     surface (e.g. the print arm, or an ACP arm with no connected
   *     session yet).
   *   - anything else — the agent's own rejection detail, verbatim from
   *     `configOptionErrorDetail` (ACP `config` strategy) or the `/model`
   *     control-turn failure (`command` strategy).
   */
  reason?: string
}

/**
 * Result of a mid-session `setSessionMode` attempt — see
 * {@link AgentCliRuntimeSession.setSessionMode}. Same shape convention as
 * {@link SetModelResult}: `applied` + the value that took effect on
 * success, or a `reason` on failure. Never thrown — a mode switch the
 * wrapper rejects (unknown/stale mode id, no native mode registry) always
 * resolves structurally.
 */
export interface SetSessionModeResult {
  applied: boolean
  /** The mode id that took effect. Present only when `applied` is true. */
  modeId?: string
  /**
   * Present only when `applied` is false. Canonical values:
   *   - `"not-supported"` — the protocol arm has no `setSessionMode`
   *     surface at all (e.g. the print/proprietary arms, or a non-ACP
   *     wrapper with no native mode registry).
   *   - `"not-connected"` — the ACP arm has no live session yet.
   *   - anything else — the wrapper's own rejection detail (a mode id not
   *     in `availableModes`, or a stale/version-mismatched offer).
   */
  reason?: string
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
   * Apply a session config option (e.g. `configId:"model"`) on the LIVE,
   * already-connected session — only the ACP arm implements this (its
   * connection exposes `session/set_config_option` mid-session); other
   * arms (print, proprietary) omit it, and `define-agent-cli.ts`'s
   * `setModel` treats its absence as `{applied:false,
   * reason:"not-supported"}`. Non-fatal: a server rejection resolves
   * `{applied:false, reason}` rather than throwing.
   */
  setConfigOption?(
    configId: string,
    value: string,
  ): Promise<{ applied: boolean; reason?: string }>
  /**
   * Switch this session's mode on the LIVE, already-connected session via
   * ACP `session/set_mode` — only the ACP arm implements this (its
   * connection exposes `setSessionMode` mid-session); other arms (print,
   * proprietary) omit it, and `define-agent-cli.ts`'s `setSessionMode`
   * treats its absence as `{applied:false, reason:"not-supported"}`.
   * Non-fatal: a rejection resolves `{applied:false, reason}` rather than
   * throwing — mirrors `setConfigOption`'s contract exactly.
   */
  setSessionMode?(
    modeId: string,
  ): Promise<{ applied: boolean; reason?: string }>
  /**
   * The wrapper's advertised session configuration options, captured at
   * connect time (`newSession`/`loadSession` response `configOptions`) —
   * see `@agentproto/acp/client`'s `AcpClientSession.availableConfigOptions`
   * for the full contract. Only the ACP arm populates this; other arms
   * leave it undefined (treated as empty by `define-agent-cli.ts`).
   */
  readonly availableConfigOptions?: SessionConfigOption[]
  /**
   * The wrapper's advertised session modes, captured at connect time
   * (`SessionModeState.availableModes`) — see `@agentproto/acp/client`'s
   * `AcpClientSession.availableModes`. Only the ACP arm populates this;
   * other arms leave it undefined.
   */
  readonly availableModes?: SessionMode[]
  /**
   * The mode id the wrapper reported as active at connect time
   * (`SessionModeState.currentModeId`). Only the ACP arm populates this.
   */
  readonly currentModeId?: string
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
  /**
   * FULLY-RESOLVED billing-auth spec, computed by the runtime resolver
   * (`@agentproto/runtime`'s `spawn-defaults`/`session-spawn`) and applied
   * MECHANICALLY here — this driver does no provider lookup, mode selection,
   * or catalog import of its own. EXPLICIT credential selection, not
   * scrub-by-absence: the resolver already decided the mode (ordered
   * preference — subscription over api-key when a subscription credential is
   * present), the env var to SET (`setEnv`), the conflicting vars to SCRUB
   * (`unsetEnv`), and resolved the `credential` from a NAMED config/store
   * ref (never the ambient shell env).
   *
   * `createAgentCliRuntime(...).start()` ENGAGES this spec when
   * `enforce === "always"` OR `explicit === true`; on engage it deletes every
   * `unsetEnv` key (unless this spawn's own mode/option patch explicitly set
   * it) then SETS `setEnv = credential`. When engaged with no `credential`, it
   * FAILS FAST with `RuntimeConfigError` (`missing_auth_credential`) — never a
   * fallback to another or ambient credential. When absent (the resolver
   * produced no spec — e.g. a by-model adapter whose provider didn't resolve),
   * this driver injects nothing and runs ambient.
   */
  auth?: ResolvedAuthSpec
}

/**
 * The resolved billing-auth spec the runtime hands the driver — see
 * {@link AgentCliStartOptions.auth}. Every field is pre-decided; the driver
 * only applies it.
 */
export interface ResolvedAuthSpec {
  /** The resolved billing mode (already ordered/validated by the runtime). */
  mode: "subscription" | "api-key"
  /** The resolved secret value for `mode`, or absent when nothing resolved
   *  (⇒ fail-fast on engage). Never read ambiently. */
  credential?: string
  /** Env var SET to `credential` on engage. */
  setEnv: string
  /** Conflicting billing-credential (and, in native mode, gateway-hygiene)
   *  env vars DELETED on engage — unless this spawn's own mode/option patch
   *  explicitly set the key. */
  unsetEnv: string[]
  /** True when an operator explicitly configured `auth` (per-spawn or in
   *  `defaults.adapters.<slug>.auth`) — half the engage condition. */
  explicit: boolean
  /** The adapter's enforcement policy — the other half of engage. */
  enforce: "always" | "when-configured"
  /** True when NEITHER subscription nor api-key had any credential
   *  available and `mode` above is an arbitrary fallback pick, not a real
   *  signal. The fail-fast message reads this to enumerate BOTH auth paths
   *  instead of presenting the fallback mode as though it were chosen. */
  neitherConfigured?: boolean
  /** Non-authenticating hint: true when `providers.json` has a key for the
   *  resolved provider that's currently being ignored for want of a
   *  `defaults.adapters.<slug>.auth` block. Never used to authenticate —
   *  only read by the fail-fast message. */
  ignoredApiKeyInStore?: boolean
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
  /**
   * Switch the active model on this LIVE, already-running session,
   * honoring the manifest's `models.apply` strategy:
   *   - `"config"`  — `session/set_config_option(configId:"model")` on the
   *     retained ACP connection (via the arm's `setConfigOption`).
   *   - `"command"` — the same `/model <id>` control turn `models.apply:
   *     "command"` uses at spawn time (`applyModelCommand`), drained and
   *     checked for a switch acknowledgement.
   *   - `"arg"`     — always `{applied:false, reason:"requires-restart"}`:
   *     this CLI takes its model as a spawn-time argv token, so a live
   *     switch is impossible without restarting the session.
   * Always resolves — never throws and never kills the session, even when
   * the underlying agent rejects the request. See {@link SetModelResult}
   * for the full reason vocabulary.
   */
  setModel(modelId: string): Promise<SetModelResult>
  /**
   * Switch the active mode on this LIVE, already-running session via ACP
   * `session/set_mode` (SDK `setSessionMode`) — the native-posture
   * counterpart to `setModel`, a distinct axis (SPEC §3.4a: posture comes
   * from the harness's own mode registry, not a manifest mode list).
   * Always resolves — never throws and never kills the session, even when
   * the wrapper rejects the request (unknown mode id, no native mode
   * registry). Resolves `{applied:false, reason:"not-supported"}` for any
   * arm that doesn't implement `AgentCliClient.setSessionMode` (print,
   * proprietary, or a non-ACP wrapper with no mode surface). See
   * {@link SetSessionModeResult} for the full reason vocabulary.
   */
  setSessionMode(modeId: string): Promise<SetSessionModeResult>
  /**
   * The wrapper's advertised session configuration options, captured once
   * at connect time (SPEC §3.9 capability read-surface) — the per-model
   * value lists a caller can resolve BEFORE attempting to apply a
   * model/effort value, instead of discovering the accepted vocabulary
   * only by catching a `setModel`/`setConfigOption` rejection. Empty
   * (`[]`) for arms that don't populate `AgentCliClient.
   * availableConfigOptions` (print, proprietary). Snapshot at connect
   * time; not live-updated by a later `setModel`/`setSessionMode` call.
   */
  readonly availableConfigOptions: SessionConfigOption[]
  /**
   * The wrapper's advertised session modes (SDK `SessionModeState.
   * availableModes`), captured at connect time. Empty (`[]`) when the
   * wrapper has no native mode registry, or for arms that don't populate
   * `AgentCliClient.availableModes` — the read-surface signal a caller
   * uses to fall back to a portable/prompt-injected posture instead of a
   * native `setSessionMode` switch.
   */
  readonly availableModes: SessionMode[]
  /**
   * The mode id the wrapper reported as active at connect time. Undefined
   * when the wrapper advertised no mode state.
   */
  readonly currentModeId: string | undefined
  close(): Promise<void>
}
