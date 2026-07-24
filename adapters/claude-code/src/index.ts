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
import { ANTHROPIC_CORE_SCRUB_ENV } from "@agentproto/provider-presets"

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
  // A model's route is an independent choice here: the gateway modes
  // (moonshot/openrouter/…) re-point ANTHROPIC_BASE_URL, so the same model
  // can go direct-Anthropic or via any gateway → free route selection.
  routeSelection: "free",
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
  // `claude-opus-4-6`.
  //
  // The gateway (Moonshot/OpenRouter/Requesty) models keep their `provider`
  // annotation but NO LONGER carry a `mode:` binding: the route to a gateway
  // is derived from the model catalog's `@route` route-identity, not an
  // adapter mode (SPEC §3.4a) — the gateway `modes[]` entries were deleted.
  // The claude binary still reaches those endpoints via the per-spawn
  // `base_url` / `auth_token` options (below) until the catalog route
  // apply-path lands.
  models: {
    default: "claude-sonnet-5",
    allowed: [
      // Native Anthropic
      { id: "claude-sonnet-5", provider: "anthropic" },
      { id: "claude-opus-4-8", provider: "anthropic" },
      { id: "claude-haiku-4-5", provider: "anthropic" },
      { id: "claude-fable-5", provider: "anthropic" },
      // Moonshot (Kimi) — route resolved from the catalog `@route`
      { id: "kimi-k2.7-code", provider: "moonshot" },
      // OpenRouter — route resolved from the catalog `@route` route-identity
      // suffix (a bare 2-segment id resolves to the direct vendor route, which
      // is dead here; `@openrouter` pins the catalog join to the OpenRouter
      // gateway, reachable via ANTHROPIC_BASE_URL like moonshot).
      { id: "z-ai/glm-5.2@openrouter", provider: "openrouter" },
      { id: "deepseek/deepseek-v4-pro@openrouter", provider: "openrouter" },
      { id: "moonshotai/kimi-k2@openrouter", provider: "openrouter" },
      { id: "x-ai/grok-4.5@openrouter", provider: "openrouter" },
      { id: "x-ai/grok-4.20@openrouter", provider: "openrouter" },
      { id: "x-ai/grok-4.3@openrouter", provider: "openrouter" },
      { id: "google/gemini-3.1-pro-preview@openrouter", provider: "openrouter" },
      { id: "google/gemini-3.5-flash@openrouter", provider: "openrouter" },
      { id: "google/gemini-2.5-flash@openrouter", provider: "openrouter" },
      { id: "google/gemini-2.5-pro@openrouter", provider: "openrouter" },
      { id: "moonshotai/kimi-k2.7-code@openrouter", provider: "openrouter" },
      // Requesty — route resolved from the catalog `@route`
      { id: "sference/thinkingcap-qwen3.6-27b@requesty", provider: "requesty" },
      { id: "sference/glm-5.2@requesty", provider: "requesty" },
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
  // Only the `lean` context mode remains a manifest `modes[]` entry (SPEC
  // §3.4a). Posture (plan / accept-edits / bypass-permissions) and the gateway
  // routes (moonshot / openrouter / requesty / deepseek) were BOTH removed from
  // here:
  //   - posture now comes from the harness's own ACP mode registry
  //     (`SessionModeState.availableModes`) plus the daemon's canonical-posture
  //     layer (step 2c). The `CLAUDE_CONFIG_DIR` ENFORCEMENT MECHANISM in the
  //     driver (`resolveClaudeCodePermissionMode` in define-agent-cli.ts) is
  //     unchanged — it still points a per-session `CLAUDE_CONFIG_DIR` at a
  //     throwaway `settings.json` with `{"permissions":{"defaultMode":
  //     "<value>"}}` (the ACP wrapper ignores `--permission-mode` on argv). But
  //     its INPUT changed: it looks the value up in `modes[]` by `config.mode`,
  //     and with the posture modes removed here that lookup no longer matches
  //     for `plan`/`accept-edits`/`bypass-permissions` — so the `config.mode`-
  //     driven path is now DORMANT (returns undefined) until step 2c re-sources
  //     the requested posture from the canonical layer and feeds it in. The
  //     known limitation still holds once it does: a target repo that commits
  //     its own escalated `.claude/settings.json` `permissions.defaultMode`
  //     defeats OUR requested mode in the same merge pass and the session falls
  //     back to "default" (never the original silent-write bug).
  //   - route now comes from the model catalog's `@route` route-identity; the
  //     gateway endpoint is still reachable per-spawn via the `base_url` /
  //     `auth_token` options (below), which carry the same ANTHROPIC_API_KEY +
  //     cloud-toggle scrub via `env_unset`.
  modes: [
    {
      id: "lean",
      description:
        "Drop Claude Code's bundled skills and workflows from context (built-in slash " +
        "commands stay typable but are hidden from the model). Plugins, project " +
        "`.claude/skills/`, and `.claude/commands/` are unaffected. The ACP wrapper has " +
        "no CLI flag for this — the underlying claude binary reads " +
        "CLAUDE_CODE_DISABLE_BUNDLED_SKILLS directly, so this mode is env-only.",
      env: { CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1" },
      kind: "context",
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
