/**
 * @agentproto/adapter-claude-code — AIP-45 adapter for Anthropic's
 * Claude Code via the @agentclientprotocol/claude-agent-acp wrapper.
 */

import {
  createAgentCliRuntime,
  defineAgentCli,
  type AgentCliHandle,
  type AgentCliRuntime,
} from "@agentproto/driver-agent-cli"
import {
  ANTHROPIC_CORE_SCRUB_ENV,
  ANTHROPIC_GATEWAY_PRESETS,
} from "@agentproto/provider-presets"

// Cloud-provider redirect toggles that must be scrubbed alongside the core
// ANTHROPIC_API_KEY whenever the claude binary is pointed at a non-Anthropic
// gateway — a leftover toggle would override ANTHROPIC_BASE_URL and silently
// route back to Bedrock/Vertex/etc. The core ANTHROPIC_API_KEY scrub itself
// is sourced from @agentproto/provider-presets (the single source of truth for
// gateway facts), so a new native-Anthropic credential env var added there is
// picked up here automatically. Shared by the moonshot/openrouter modes and
// the base_url option.
const CLAUDE_CODE_CLOUD_TOGGLES: string[] = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
]
const CLAUDE_CODE_GATEWAY_ENV_UNSET: string[] = [
  ...ANTHROPIC_CORE_SCRUB_ENV,
  ...CLAUDE_CODE_CLOUD_TOGGLES,
]

export const claudeCode: AgentCliHandle = defineAgentCli({
  name: "claude-code",
  id: "claude-code",
  description:
    "Anthropic's Claude Code wrapped as an ACP agent via @agentclientprotocol/claude-agent-acp. Spawned via `npx -y @agentclientprotocol/claude-agent-acp` and driven over stdio JSON-RPC.",
  version: "0.1.0",
  bin: "npx",
  bin_args: ["-y", "@agentclientprotocol/claude-agent-acp@0.59.0"],
  install: [
    {
      method: "npm",
      package: "@agentclientprotocol/claude-agent-acp",
      global: true,
    },
  ],
  version_check: {
    cmd: "npm view @agentclientprotocol/claude-agent-acp version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=0.30.0",
    timeout_ms: 15_000,
  },
  auth: {
    ref: "./SECRETS.md",
    state: { env: ["ANTHROPIC_API_KEY"] },
  },
  // Deterministic billing-auth (subscription vs api-key), resolved by the
  // runtime (@agentproto/runtime's resolveAuthSpec) and applied MECHANICALLY
  // by the driver. EXPLICIT credential selection, not scrub-by-absence: the
  // resolver SETS exactly one credential env var (from a named config/store
  // ref, never the ambient shell) and SCRUBS the conflicting one(s), so which
  // credential — and thus which billing — a spawn uses is *stated*, never
  // inferred from whatever the daemon's launching shell exported (the outage
  // this surface exists to prevent).
  //
  // provider "anthropic" ⇒ api-key mode SETS providerEnvVar("anthropic") =
  // ANTHROPIC_API_KEY (derived from the catalog, not re-listed here) and
  // scrubs the subscription-family creds (CLAUDE_CODE_OAUTH_TOKEN +
  // ANTHROPIC_AUTH_TOKEN). authEnforce "always" preserves #312: claude-code
  // engages on EVERY spawn and fails fast with no credential.
  //
  // authSubscription: "subscription" SETS CLAUDE_CODE_OAUTH_TOKEN to a bearer
  // token minted via `claude setup-token` (bills Max/Pro, not API credits) —
  // the var Claude Code documents for that token and the ONLY one that yields
  // the clean native claude.ai-login path. (The same token as
  // ANTHROPIC_AUTH_TOKEN authenticates but is treated as a generic override
  // that disables connectors — the degraded path, so it's a `conflictEnv` to
  // scrub, never the setEnv.) `conflictEnv` (ANTHROPIC_AUTH_TOKEN) is scrubbed
  // in BOTH modes; `unsetEnvAdd` (cloud toggles + ANTHROPIC_BASE_URL) only in
  // subscription (native) mode — matching #312's exact byte-for-byte scrub set
  // in each mode (asserted by the regression snapshot test). ANTHROPIC_API_KEY
  // is NOT listed in unsetEnvAdd because it derives from providerEnvVar and is
  // scrubbed as the non-set credential automatically.
  provider: "anthropic",
  authEnforce: "always",
  authSubscription: {
    setEnv: "CLAUDE_CODE_OAUTH_TOKEN",
    conflictEnv: ["ANTHROPIC_AUTH_TOKEN"],
    unsetEnvAdd: [...CLAUDE_CODE_CLOUD_TOGGLES, "ANTHROPIC_BASE_URL"],
  },
  sandbox: "./SANDBOX.md",
  protocol: "acp",
  acp: "./claude-code-acp.ACP.md",
  session: {
    mode: "persistent",
    idle_timeout_ms: 1_800_000,
    context_carryover: true,
  },
  // Every id below is validated against the wrapper's live
  // `session/new` → configOptions[model] selector: the wrapper resolves
  // these (via its own `resolveModelPreference`) and rejects anything it
  // can't — a rejected `session/set_config_option` used to kill the spawn
  // (agentproto#186; the apply is now best-effort, see @agentproto/acp's
  // newSession). Stale native ids that the wrapper no longer offers were
  // removed: `claude-sonnet-4-6` (the old default), `claude-opus-4-7`,
  // `claude-opus-4-6`. The gateway ids mirror claude-sdk's set — the
  // claude binary honors ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN exactly
  // like the SDK does, so the same moonshot/openrouter modes below reach
  // them; they were simply never declared here before.
  models: {
    default: "claude-sonnet-5",
    allowed: [
      // Native Anthropic — no mode switch needed
      { id: "claude-sonnet-5", provider: "anthropic" },
      { id: "claude-opus-4-8", provider: "anthropic" },
      { id: "claude-haiku-4-5", provider: "anthropic" },
      { id: "claude-fable-5", provider: "anthropic" },
      // Moonshot (Kimi) — mode: moonshot
      { id: "kimi-k2.7-code", provider: "moonshot", mode: "moonshot" },
      // OpenRouter — mode: openrouter
      { id: "z-ai/glm-5.2", provider: "openrouter", mode: "openrouter" },
      { id: "deepseek/deepseek-v4-pro", provider: "openrouter", mode: "openrouter" },
      { id: "moonshotai/kimi-k2", provider: "openrouter", mode: "openrouter" },
      // Requesty — mode: requesty
      {
        id: "sference/thinkingcap-qwen3.6-27b",
        provider: "requesty",
        mode: "requesty",
      },
      { id: "sference/glm-5.2", provider: "requesty", mode: "requesty" },
    ],
    env: { anthropic: "ANTHROPIC_API_KEY" },
  },
  capabilities: {
    streaming: true,
    tool_calls: true,
    sub_agents: false,
    file_io: true,
    // ACP wrapper forwards `image` content blocks in user prompts
    // straight to Anthropic Messages API. Hosts SHOULD send images
    // inline (see CLAUDE-CODE.md) instead of passing paths and
    // hoping the model uses Read.
    multimodal: true,
    // The wrapper (@agentclientprotocol/claude-agent-acp >= 0.30)
    // advertises `loadSession: true` and exposes the full session
    // lifecycle (newSession / loadSession / resumeSession / forkSession)
    // over JSON-RPC. Pairs with `continuation.default: native-resume`
    // below — the host persists the sessionId and reattaches to the
    // existing session across cold starts (api restart, sandbox reap,
    // multi-machine).
    resumable: true,
    bidirectional: true,
    // Claude Code's Read tool can ingest any absolute path the host
    // surfaces via the prompt. Pair with the daemon's POST /files/upload
    // route + a host UI drag-drop handler: drop a file → daemon writes
    // to `cwd/.agentproto-attachments/<name>` → host pastes the path
    // into the terminal → Claude reads it natively. No protocol-level
    // multimodal round-trip needed; pure file-path injection.
    file_attach: true,
  },
  // `bin_args_append: ["--permission-mode", ...]` below is a no-op against
  // the @agentclientprotocol/claude-agent-acp wrapper — it never reads
  // `--permission-mode` from argv. The wrapper instead resolves
  // `permissions.defaultMode` exclusively via the SDK's `resolveSettings`,
  // which merges `${CLAUDE_CONFIG_DIR}/settings.json` (user tier),
  // `<cwd>/.claude/settings(.local).json` (project tier), and a managed
  // tier. The driver (`packages/driver/agent-cli/src/define-agent-cli.ts`,
  // `resolveClaudeCodePermissionMode`) makes the mode actually take effect
  // by pointing a per-session `CLAUDE_CONFIG_DIR` at a throwaway temp dir
  // containing `{"permissions":{"defaultMode":"<value>"}}` — reading the
  // same `--permission-mode <value>` pair declared here as its one source
  // of truth for the value vocabulary. `bin_args_append` is kept for a
  // future wrapper version that might start reading argv.
  //
  // Known limitation (empirically confirmed, not just theorized): a target
  // repo that commits its own escalated `.claude/settings.json`
  // `permissions.defaultMode` (e.g. "bypassPermissions") does NOT let the
  // repo's escalation win — the wrapper's `filterEscalatingDefaultMode`
  // strips an escalating project-tier value entirely — but it also means
  // OUR requested mode is defeated in the same merge pass (project tier
  // out-prioritizes the user tier for the raw merge, before the filter
  // ever runs). The net effect for that adversarial case is the session
  // falls back to "default" (normal per-action prompting) rather than the
  // requested mode. This does not reintroduce the original bug (silent,
  // zero-prompt writes) — it just doesn't guarantee plan-only reasoning
  // against a repo actively trying to escalate its own trust level.
  modes: [
    { id: "default", description: "Standard interactive mode." },
    {
      id: "lean",
      description:
        "Drop Claude Code's bundled skills and workflows from context (built-in slash " +
        "commands stay typable but are hidden from the model). Plugins, project " +
        "`.claude/skills/`, and `.claude/commands/` are unaffected. The ACP wrapper has " +
        "no CLI flag for this — the underlying claude binary reads " +
        "CLAUDE_CODE_DISABLE_BUNDLED_SKILLS directly, so this mode is env-only.",
      env: { CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1" },
    },
    {
      id: "plan",
      description:
        "Plan-only mode — Claude Code reasons and proposes a plan, requesting explicit " +
        "approval before writing files or running commands. Applied via a per-session " +
        "CLAUDE_CONFIG_DIR override (see comment above `modes`); can be defeated by a " +
        "target repo's own committed, escalated .claude/settings.json.",
      bin_args_append: ["--permission-mode", "plan"],
    },
    {
      id: "accept-edits",
      description: "Auto-accept file edits; commands still prompt.",
      bin_args_append: ["--permission-mode", "acceptEdits"],
    },
    {
      id: "bypass-permissions",
      description:
        "Skip all permission prompts. Use only in trusted automation contexts.",
      bin_args_append: ["--permission-mode", "bypassPermissions"],
    },
    // ── Gateway modes ───────────────────────────────────────────────
    // The claude binary honors ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN,
    // so it can front any Anthropic-compatible gateway (Moonshot, OpenRouter,
    // LiteLLM, claude-code-router) the same way @agentproto/adapter-claude-sdk
    // does. These modes pre-wire the endpoint and — critically — scrub the
    // ambient ANTHROPIC_API_KEY plus the cloud-provider redirect toggles
    // (CLAUDE_CODE_USE_BEDROCK/_VERTEX/…) via env_unset so the real Anthropic
    // credential can neither leak to nor 401 against a third-party host, and
    // a leftover cloud toggle can't override the gateway base_url. The
    // operator supplies the gateway key via the `auth_token` option (injected
    // as ANTHROPIC_AUTH_TOKEN, sent as `Authorization: Bearer`) and picks a
    // model via `model` (e.g. 'kimi-k2.7-code', 'z-ai/glm-5.2') — the ACP
    // wrapper applies it via session/set_config_option after newSession.
    {
      id: ANTHROPIC_GATEWAY_PRESETS.moonshot.id,
      description:
        "Moonshot (Kimi) gateway. Pre-wires ANTHROPIC_BASE_URL to Moonshot's " +
        "Anthropic-compatible endpoint and scrubs the ambient ANTHROPIC_API_KEY " +
        "so it can't leak to the third-party host. Supply the Moonshot key via " +
        "the `auth_token` option and pick a model via `model` (conventional: " +
        "'kimi-k2.7-code'). Without auth_token the spawn has no credentials and " +
        "fails cleanly — the real Anthropic key is never sent.",
      env: {
        ANTHROPIC_BASE_URL: ANTHROPIC_GATEWAY_PRESETS.moonshot.baseUrl,
      },
      env_unset: CLAUDE_CODE_GATEWAY_ENV_UNSET,
    },
    {
      id: ANTHROPIC_GATEWAY_PRESETS.openrouter.id,
      description:
        "OpenRouter gateway. Pre-wires ANTHROPIC_BASE_URL to OpenRouter's " +
        "Anthropic-compatible endpoint and scrubs the ambient ANTHROPIC_API_KEY " +
        "(same auth-hygiene rationale as `moonshot`). Pick a model via `model` " +
        "(e.g. 'z-ai/glm-5.2', 'deepseek/deepseek-v4-pro', 'moonshotai/kimi-k2') " +
        "and supply the OpenRouter key via `auth_token`.",
      env: {
        ANTHROPIC_BASE_URL: ANTHROPIC_GATEWAY_PRESETS.openrouter.baseUrl,
      },
      env_unset: CLAUDE_CODE_GATEWAY_ENV_UNSET,
    },
    {
      id: ANTHROPIC_GATEWAY_PRESETS.requesty.id,
      description:
        "Requesty gateway. Pre-wires ANTHROPIC_BASE_URL to Requesty's " +
        "Anthropic-compatible endpoint and scrubs the ambient ANTHROPIC_API_KEY " +
        "(same auth-hygiene rationale as `moonshot`/`openrouter`). Pick a model " +
        "via `model` (e.g. 'sference/thinkingcap-qwen3.6-27b', " +
        "'sference/glm-5.2') and supply the Requesty key via `auth_token`.",
      env: {
        ANTHROPIC_BASE_URL: ANTHROPIC_GATEWAY_PRESETS.requesty.baseUrl,
      },
      env_unset: CLAUDE_CODE_GATEWAY_ENV_UNSET,
    },
    {
      id: ANTHROPIC_GATEWAY_PRESETS.deepseek.id,
      description:
        "DeepSeek gateway. Pre-wires ANTHROPIC_BASE_URL to DeepSeek's " +
        "Anthropic-compatible endpoint and scrubs the ambient ANTHROPIC_API_KEY " +
        "(same auth-hygiene rationale as `moonshot`/`openrouter`). Pick a model " +
        "via `model` (conventional: 'deepseek-v4-pro', 'deepseek-v4-flash') and " +
        "supply the DeepSeek key via `auth_token`.",
      env: {
        ANTHROPIC_BASE_URL: ANTHROPIC_GATEWAY_PRESETS.deepseek.baseUrl,
      },
      env_unset: CLAUDE_CODE_GATEWAY_ENV_UNSET,
    },
  ],
  options: [
    {
      id: "model",
      // string (not enum) so any valid Anthropic model ID is accepted
      // without requiring a code change to expand the list. Applied via
      // ANTHROPIC_MODEL env var so the claude binary picks it up directly
      // — the claude-agent-acp wrapper only forwards CLI args when --cli
      // is passed, otherwise it runs in ACP mode and ignores argv.
      type: "string" as const,
      description:
        "Anthropic model ID or wrapper alias (e.g. 'claude-opus-4-8', " +
        "'claude-sonnet-5', 'sonnet', 'opus'). Set via ANTHROPIC_MODEL env " +
        "var so the claude binary uses it directly. Omit to use the claude-code default.",
      env: { ANTHROPIC_MODEL: "{value}" },
    },
    {
      id: "effort",
      type: "enum" as const,
      // Effort is model-dependent: the same label maps to different
      // underlying compute budgets across models, and the model's own
      // default differs (Sonnet 4.6 / Opus 4.8 default to "high";
      // Opus 4.7 defaults to "xhigh"). "max" and "ultracode" are
      // session-only — not valid in persisted settings. Omit to keep
      // the model's own default rather than hardcoding one here.
      enum: ["low", "medium", "high", "xhigh", "max", "ultracode"],
      description:
        "Reasoning effort level. Model-dependent: the same label ≠ the same " +
        "compute budget across models, and defaults differ by model " +
        "(e.g. Sonnet 4.6 / Opus 4.8 default to 'high'; Opus 4.7 to 'xhigh'). " +
        "'max' and 'ultracode' are session-only. Omit to keep the model's own default.",
    },
    {
      id: "max_turns",
      type: "integer" as const,
      min: 1,
      max: 200,
      description:
        "Hard cap on tool-use turns within a single send. Claude Code stops after this many cycles.",
      bin_args_template: ["--max-turns", "{value}"],
    },
    {
      id: "base_url",
      // Injected into the child env as ANTHROPIC_BASE_URL — the claude binary
      // honors it, so this fronts real Anthropic, Bedrock/Vertex/Azure, or an
      // Anthropic-compatible gateway (LiteLLM / claude-code-router / Moonshot
      // / OpenRouter). Auto-scrubs the ambient ANTHROPIC_API_KEY + cloud
      // redirect toggles the moment it's set (symmetric with the moonshot/
      // openrouter modes and with claude-sdk's buildQueryOptions scrub) so the
      // real Anthropic credential can never leak to a third-party host — pair
      // with `auth_token` to supply the gateway key. A base_url pointed at a
      // real-Anthropic mirror that still wants the ambient key is the one
      // shape this breaks; that's an acceptable trade for the default being
      // leak-safe (matches claude-sdk).
      type: "string" as const,
      description:
        "Custom Anthropic base URL. Injected as ANTHROPIC_BASE_URL in the " +
        "child env — front real Anthropic, Bedrock/Vertex/Azure, or an " +
        "Anthropic-compatible gateway. Auto-scrubs the ambient " +
        "ANTHROPIC_API_KEY + cloud redirect toggles when set (so the real " +
        "key can't leak to a third-party host) — pair with `auth_token` to " +
        "supply the gateway credential. For Moonshot/OpenRouter the dedicated " +
        "modes pre-wire the URL too. Omit to use the default endpoint.",
      env: { ANTHROPIC_BASE_URL: "{value}" },
      env_unset: CLAUDE_CODE_GATEWAY_ENV_UNSET,
    },
    {
      id: "auth_token",
      // Injected into the child env as ANTHROPIC_AUTH_TOKEN — the claude
      // binary sends it as `Authorization: Bearer <token>`, which
      // Anthropic-compatible gateways (Moonshot, OpenRouter) accept. Pair
      // with base_url (or a gateway mode) for a per-spawn key instead of the
      // ambient ANTHROPIC_API_KEY.
      type: "string" as const,
      description:
        "Bearer token for the Anthropic API or a compatible gateway. Injected " +
        "as ANTHROPIC_AUTH_TOKEN in the child env (sent as `Authorization: " +
        "Bearer`). Pair with `base_url` (or a `moonshot`/`openrouter` mode) " +
        "to target a gateway with a per-spawn key instead of the ambient " +
        "ANTHROPIC_API_KEY. Omit to use ANTHROPIC_API_KEY from the environment.",
      env: { ANTHROPIC_AUTH_TOKEN: "{value}" },
    },
  ],
  continuation: {
    // native-resume: each turn cold-spawns claude, then ACP `loadSession`
    // reattaches to the saved sessionId. Survives api restarts, sandbox
    // reaps, multi-machine — claude reads its own JSONL session store.
    // Requires the host to register `configureNativeResume({load, save})`
    // hooks; without them the strategy degrades to per-spawn behaviour
    // (no continuity).
    //
    // pinned-session is still supported as a fallback for hosts that
    // haven't wired the resume hooks yet — same warm-process semantics
    // as pre-AIP-45-extension behaviour.
    default: "native-resume",
    supported: ["native-resume", "pinned-session", "transcript", "none"],
    pinned_session: {
      idle_timeout_ms: 1_800_000,
      key_scope: ["conversation", "operator"],
    },
  },
  tags: ["claude-code", "anthropic", "acp", "agent-runtime", "coding"],
  metadata: {
    // Opts claude-code into `agentproto install skill/<slug>` fan-out (no
    // --target given). Claude Code skills install as a whole plugin
    // bundle, not per-skill drops — `unit: "whole-pack"` tells the
    // fan-out dispatcher to emit the pack once, not once per requested
    // skill slug. See
    // packages/cli/src/commands/skill-install/types.ts `AdapterSkillsTarget`.
    skills: {
      format: "claude-plugin",
      unit: "whole-pack",
      outDir: "~/.claude/plugins/agentproto",
    },
  },
})

export function claudeCodeRuntime(): AgentCliRuntime {
  return createAgentCliRuntime(claudeCode)
}

export type { AgentCliHandle, AgentCliRuntime }
