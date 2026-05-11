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
    allowed: ["claude-sonnet-4-6", "claude-opus-4-7", "claude-haiku-4-5"],
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
      type: "enum",
      enum: ["claude-sonnet-4-6", "claude-opus-4-7", "claude-haiku-4-5"],
      description: "Override the default model for this operator binding.",
      bin_args_template: ["--model", "{value}"],
    },
    {
      id: "max_turns",
      type: "integer",
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
