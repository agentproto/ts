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
  models: {
    default: "claude-sonnet-4-6",
    allowed: [
      "claude-sonnet-4-6",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-haiku-4-5",
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
  modes: [
    { id: "default", description: "Standard interactive mode." },
    {
      id: "plan",
      description:
        "Plan-only mode — Claude Code reasons and proposes but does not edit or run commands.",
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
        "Anthropic model ID (e.g. 'claude-opus-4-8', 'claude-sonnet-4-6'). " +
        "Applied via ACP session/set_config_option after the session is created. " +
        "Omit to use the claude-code default.",
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
