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

export const claudeCode: AgentCliHandle = defineAgentCli({
  name: "claude-code",
  id: "claude-code",
  description:
    "Anthropic's Claude Code wrapped as an ACP agent via @agentclientprotocol/claude-agent-acp. Spawned via `npx -y @agentclientprotocol/claude-agent-acp` and driven over stdio JSON-RPC.",
  version: "0.1.0",
  bin: "npx",
  bin_args: ["-y", "@agentclientprotocol/claude-agent-acp"],
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
  // newSession). Stale ids that the wrapper no longer offers were removed:
  // `claude-sonnet-4-6` (the old default), `claude-opus-4-7`, `claude-opus-4-6`.
  models: {
    default: "claude-sonnet-5",
    allowed: [
      "claude-sonnet-5",
      "claude-opus-4-8",
      "claude-haiku-4-5",
      "claude-fable-5",
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
  ],
  options: [
    {
      id: "model",
      // string (not enum) so any valid Anthropic model ID is accepted
      // without requiring a code change to expand the list. Applied via
      // ACP session/set_config_option(configId:"model") after newSession
      // — the claude-agent-acp wrapper does not forward its own CLI args
      // to the underlying claude process, so bin_args_template alone
      // cannot select the model.
      type: "string" as const,
      description:
        "Anthropic model ID or wrapper alias (e.g. 'claude-opus-4-8', " +
        "'claude-sonnet-5', 'sonnet', 'opus'). Applied via ACP " +
        "session/set_config_option after the session is created; an id the " +
        "wrapper can't resolve is warned about and ignored (the session keeps " +
        "the claude-code default). Omit to use the claude-code default.",
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
})

export function claudeCodeRuntime(): AgentCliRuntime {
  return createAgentCliRuntime(claudeCode)
}

export type { AgentCliHandle, AgentCliRuntime }
