/**
 * @agentproto/adapter-mastracode — AIP-45 adapter for Mastra Code.
 *
 * Mastra Code does not currently expose a discoverable ACP subcommand
 * (`mastracode acp --help` prints the top-level CLI help). We spawn
 * its documented headless CLI via `npx -y mastracode` and mark this
 * adapter as a print/headless protocol arm rather than claiming ACP.
 *
 *   import { mastracode, mastracodeRuntime } from "@agentproto/adapter-mastracode"
 *   const session = await mastracodeRuntime().start()
 *   for await (const evt of session.send({ role: "user", content: "..." })) {
 *     console.log(evt)
 *   }
 *   await session.close()
 */

import {
  createAgentCliRuntime,
  defineAgentCli,
  type AgentCliHandle,
  type AgentCliRuntime,
} from "@agentproto/driver-agent-cli"

export const mastracode: AgentCliHandle = defineAgentCli({
  name: "mastracode",
  id: "mastracode",
  description:
    "Mastra Code — terminal-based AI coding agent with persistent threads, tools, modes, and multi-provider model support. Current CLI exposes TUI/headless operation, not ACP; spawned via `npx -y mastracode`.",
  version: "0.1.0",
  bin: "npx",
  bin_args: ["-y", "mastracode"],
  install: [{ method: "npm", package: "mastracode", global: true }],
  version_check: {
    cmd: "npm view mastracode version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=0.26.0",
    timeout_ms: 15_000,
  },
  auth: {
    ref: "./SECRETS.md",
    state: {
      env: [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
      ],
    },
  },
  sandbox: "./SANDBOX.md",
  protocol: "print",
  print: {
    prompt_flag: "--prompt",
    output_format: ["--output", "jsonl"],
    pre_prompt: [],
    resume: { flag: "--thread", kind: "value" },
    event_schema: "mastra-jsonl",
  },
  session: {
    mode: "ephemeral",
    idle_timeout_ms: 1_800_000,
    context_carryover: false,
  },
  models: {
    default: "anthropic/claude-sonnet-4-5",
    allowed: [
      "anthropic/claude-sonnet-4-5",
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5.1",
      "openai/gpt-5.1-mini",
      "google/gemini-2.5-flash",
      "openrouter/anthropic/claude-sonnet-4-6",
    ],
    env: {
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
      google: "GOOGLE_GENERATIVE_AI_API_KEY",
    },
  },
  capabilities: {
    streaming: true,
    tool_calls: true,
    sub_agents: true,
    file_io: true,
    multimodal: false,
    // `mastracode --thread <id>` reattaches to a prior thread with real
    // persisted memory (confirmed cross-process: separate spawn, same
    // thread id, correct continuity). `print.resume` below drives this.
    resumable: true,
    bidirectional: false,
  },
  modes: [
    {
      id: "default",
      description:
        "Default headless mode. Mastra Code defaults to build mode when omitted.",
    },
    {
      id: "plan",
      description:
        "Plan-only mode — analyze architecture and propose implementation plans before writing code.",
      bin_args_append: ["--mode", "plan"],
    },
    {
      id: "build",
      description:
        "Build mode — file edits and shell commands use Mastra Code's configured permissions.",
      bin_args_append: ["--mode", "build"],
    },
    {
      id: "fast",
      description: "Fast mode — lower-latency answers and small edits.",
      bin_args_append: ["--mode", "fast"],
    },
  ],
  options: [
    {
      id: "model",
      type: "string",
      description:
        "Provider/model override for this operator binding (e.g. `anthropic/claude-sonnet-4-5`).",
      bin_args_template: ["--model", "{value}"],
    },
    {
      id: "thinking_level",
      type: "enum",
      enum: ["off", "low", "medium", "high", "xhigh"],
      description: "Thinking level passed to Mastra Code.",
      bin_args_template: ["--thinking-level", "{value}"],
    },
    {
      id: "timeout",
      type: "integer",
      min: 1,
      max: 86_400,
      description: "Maximum headless run duration in seconds.",
      bin_args_template: ["--timeout", "{value}"],
    },
  ],
  continuation: {
    default: "none",
    supported: ["none", "transcript", "native-resume"],
  },
  metadata: {
    acp: {
      checked: "2026-06-30",
      result:
        "`mastracode acp --help` prints top-level Mastra Code help; no ACP subcommand is currently discoverable.",
    },
    lean: {
      checked: "2026-07-03",
      result:
        "No `lean` mode declared. The headless entrypoint this adapter spawns " +
        "(runMCCli, driven by `--prompt`) has no flag to drop skill/subagent/OM " +
        "scaffolding, and does not read the MASTRACODE_DISABLE_MCP / " +
        "MASTRACODE_DISABLE_HOOKS / MASTRACODE_DISABLE_MEMORY env vars — those " +
        "are wired only into the interactive TUI entrypoint (tuiMain), so declaring " +
        "them here would silently do nothing. `--settings <path>` could point at a " +
        "leaner packaged settings.json, but that means shipping and maintaining an " +
        "actual settings file, not just a manifest patch — revisit if worth doing.",
    },
  },
  tags: ["mastracode", "mastra", "print", "agent-runtime", "coding"],
})

export function mastracodeRuntime(): AgentCliRuntime {
  return createAgentCliRuntime(mastracode)
}

export type { AgentCliHandle, AgentCliRuntime }
