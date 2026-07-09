/**
 * @agentproto/adapter-pi — AIP-45 adapter for **earendil-works/pi**
 * (`@earendil-works/pi-coding-agent`), an MIT TypeScript headless coding
 * agent.
 *
 * Pi ships **no ACP and no MCP** — but it does ship a persistent
 * JSON-over-stdio RPC mode (`pi --mode rpc`). So this is a
 * `protocol: "proprietary"` manifest: `createAgentCliRuntime` skips the
 * built-in ACP/print subprocess plumbing and instead dynamic-imports this
 * package's `createAgentCliClient(definition)` factory (see
 * `createProprietaryProtocolArm` in `@agentproto/driver-agent-cli`). Unlike
 * the in-process mastracode arm, THIS arm spawns a real child (`pi --mode
 * rpc`) and translates pi's RPC event stream — see `./client.ts`.
 *
 *   import { pi, piRuntime } from "@agentproto/adapter-pi"
 *   const session = await piRuntime().start()
 *   for await (const evt of session.send({ role: "user", content: "..." })) {
 *     console.log(evt)
 *   }
 *   await session.close()
 *
 * ## KEY LIMITATION — pi has no MCP support
 *
 * The proprietary arm's `connect()` receives `mcpServers`, but pi cannot
 * mount them. `client.ts` logs a one-time warning rather than silently
 * dropping them: the agentproto substrate toolset is unavailable and pi runs
 * only its own built-in file/shell tools. This is the single most important
 * caveat for anyone choosing this adapter — see README.md and SANDBOX.md.
 */

import {
  createAgentCliRuntime,
  defineAgentCli,
  type AgentCliHandle,
  type AgentCliRuntime,
} from "@agentproto/driver-agent-cli"

export const pi: AgentCliHandle = defineAgentCli({
  name: "Pi",
  id: "pi",
  description:
    "earendil-works/pi — MIT headless TypeScript coding agent. Driven over pi's " +
    "persistent JSON-over-stdio RPC mode (`pi --mode rpc`) as a spawned child. " +
    "Multi-provider (Anthropic/OpenAI/Google), streaming, live-duplex " +
    "(steer/follow-up/abort mid-turn). No ACP, NO MCP — pi runs only its own " +
    "built-in file/shell tools; injected MCP servers are ignored (see SANDBOX.md).",
  version: "0.1.0",
  // Real binary. The proprietary arm never spawns it for you (that's
  // client.ts's job) but the AIP-45 schema requires the field, and client.ts
  // reads `definition.bin` (overridable via AGENTPROTO_PI_BIN) to spawn
  // `pi --mode rpc`.
  bin: "pi",
  install: [
    { method: "npm", package: "@earendil-works/pi-coding-agent", global: true },
    { method: "curl", url: "https://pi.dev/install.sh" },
  ],
  version_check: {
    cmd: "npm view @earendil-works/pi-coding-agent version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=0.80.0",
    timeout_ms: 15_000,
  },
  auth: {
    ref: "./SECRETS.md",
    state: {
      env: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    },
  },
  sandbox: "./SANDBOX.md",
  protocol: "proprietary",
  adapter: "@agentproto/adapter-pi",
  session: {
    mode: "persistent",
    idle_timeout_ms: 1_800_000,
    // Pi's RPC loop can sit silent inside a long tool chain. Bound true
    // in-turn silence so a dropped final response can't hang the host — the
    // client surfaces activity via connect({ onActivity }).
    turn_idle_timeout_ms: 300_000,
    context_carryover: true,
  },
  models: {
    // Pi's `--model <pattern>` accepts `provider/id` (verified against pi
    // 0.80.x cli/args.ts + core/model-resolver.ts).
    default: "anthropic/claude-sonnet-4-5",
    allowed: [
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5.1",
      "google/gemini-2.5-flash",
    ],
    env: {
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      google: "GOOGLE_GENERATIVE_AI_API_KEY",
    },
  },
  capabilities: {
    streaming: true,
    tool_calls: true,
    // Pi has no sub-agent spawn surface, and (critically) no MCP — the
    // orchestration gateway can't be mounted into a pi session.
    sub_agents: false,
    file_io: true,
    // Pi accepts image content on a prompt; the current client extracts text
    // only (image passthrough is a documented gap in PI-RPC.md).
    multimodal: true,
    // Pi persists sessions and can reattach via `--session <id>`; the client
    // captures pi's session id from `get_state` for native-resume.
    resumable: true,
    // Pi's RPC mode is a live duplex — steer / follow_up / abort mid-turn.
    bidirectional: true,
  },
  // Pi's RPC surface has no plan/build/read-only mode switch to expose — a
  // single default mode keeps the manifest honest (no invented modes).
  modes: [
    {
      id: "default",
      description: "Default pi RPC session — pi's own built-in file/shell tools.",
    },
  ],
  // `model` + `effort` are the two ids `createAgentCliRuntime` reads off
  // `config.options` and forwards to `connect()`. `client.ts` threads `model`
  // into the `--model` spawn flag and `effort` into a `set_thinking_level`
  // RPC command (both 1:1 with pi's own vocabulary).
  options: [
    {
      id: "model",
      type: "string",
      description:
        "Provider/model pattern passed to pi's `--model` (e.g. `anthropic/claude-sonnet-4-5`).",
    },
    {
      id: "effort",
      type: "enum",
      // Pi's ThinkingLevel (packages/coding-agent/src/cli/args.ts).
      enum: ["off", "minimal", "low", "medium", "high", "xhigh"],
      description:
        "Thinking level, mapped 1:1 to pi's `set_thinking_level` RPC command.",
    },
  ],
  continuation: {
    default: "native-resume",
    supported: ["native-resume", "pinned-session", "transcript", "none"],
  },
  metadata: {
    proprietary: {
      checked: "2026-07-09",
      result:
        "Verified live against pi 0.80.3: `pi --mode rpc` spawn → get_state " +
        "session-id capture → a prompt turn streams thought + text-delta " +
        "content and closes with turn-end{completed} + usage_update. Wire " +
        "protocol reverse-engineered from packages/coding-agent/src/modes/rpc/* " +
        "+ core/agent-session.ts; mapper unit-tested. Terminator is `agent_end` " +
        "(pi does not stream `agent_settled`). See PI-RPC.md.",
    },
  },
  tags: ["pi", "earendil", "proprietary", "rpc", "agent-runtime", "coding", "no-mcp"],
})

export function piRuntime(): AgentCliRuntime {
  return createAgentCliRuntime(pi)
}

export { createAgentCliClient } from "./client.js"
export {
  classifyPiLine,
  createPiMapperState,
  mapPiEvent,
  mapStopReason,
  resetPiMapperState,
} from "./pi-events.js"
export type {
  PiAssistantMessageEvent,
  PiMapperState,
  PiOutbound,
  PiResponse,
  PiSessionEvent,
  PiStopReason,
  PiTurnMessage,
  PiUsage,
} from "./pi-events.js"
export type { AgentCliHandle, AgentCliRuntime }
