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
 * ## MCP support — bridged via a generated pi extension
 *
 * Pi has no native MCP client, but the proprietary arm's `connect()` receives
 * `mcpServers` and now bridges them: it enumerates each server's tools, writes a
 * per-session config, and spawns pi with `-e <mcp-bridge-extension.mjs>` so the
 * extension registers one pi tool per MCP tool (proxying calls over
 * `@modelcontextprotocol/sdk`). Injected toolsets — including the daemon's
 * `agent_start` orchestration gateway — become callable from pi. When no MCP
 * servers are injected, pi runs only its own built-in file/shell tools. See
 * MCP-BRIDGE.md, README.md, and SANDBOX.md.
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
    "Multi-provider (Anthropic/OpenAI/Google/Moonshot), streaming, live-duplex " +
    "(steer/follow-up/abort mid-turn). No native ACP/MCP, but injected MCP " +
    "servers are BRIDGED into pi tools via a generated pi extension (see " +
    "MCP-BRIDGE.md); otherwise pi runs only its own built-in file/shell tools.",
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
      env: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "MOONSHOT_API_KEY"],
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
  // Pi routes on the model id's own `<provider>/<id>` prefix directly (see
  // models.allowed below), no adapter mode — so the route falls out of the
  // chosen model → derived-from-model.
  routeSelection: "derived-from-model",
  models: {
    // Pi's `--model <pattern>` accepts `provider/id` (verified against pi
    // 0.80.x cli/args.ts + core/model-resolver.ts). `provider` below is
    // read straight off that same prefix — pi routes on it directly, no
    // adapter mode needed.
    default: "anthropic/claude-sonnet-4-5",
    allowed: [
      { id: "anthropic/claude-sonnet-4-5", provider: "anthropic" },
      { id: "openai/gpt-5.1", provider: "openai" },
      { id: "google/gemini-2.5-flash", provider: "google" },
      // Model-id PREFIX stays `moonshotai/` — that's what pi's own `--model`
      // resolver expects (see the comment above). The `provider` field is a
      // BILLING endpoint, not a wire-format echo, and must be the CANONICAL
      // catalog slug `moonshot` (base.ts:48) — `moonshotai` is the upstream/
      // wire slug, already documented to drift from ours (base.ts:113-121).
      // Conflating the two is D3: it made the runtime's model→provider
      // eligibility projection compute an unrecognized "moonshotai" endpoint,
      // which doesn't match any real wallet, so a genuinely-eligible moonshot
      // profile was rejected.
      { id: "moonshotai/kimi-k3", provider: "moonshot" },
      { id: "moonshotai/kimi-k2.7-code", provider: "moonshot" },
    ],
    env: {
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      google: "GOOGLE_GENERATIVE_AI_API_KEY",
      // Keyed by the canonical provider slug (matches `provider` above), not
      // the wire-format `moonshotai` prefix — see the comment on the
      // `allowed` entry.
      moonshot: "MOONSHOT_API_KEY",
    },
  },
  capabilities: {
    streaming: true,
    tool_calls: true,
    // Pi has no NATIVE sub-agent spawn surface, but the MCP bridge (see
    // MCP-BRIDGE.md) makes it a real orchestrator: when the host injects the
    // daemon's orchestration gateway via `mcpServers` (e.g. `sessions start pi
    // --orchestrator`), the bridge exposes `mcp__agentproto__agent_start` as a
    // pi tool. Verified end-to-end — a pi session spawned a depth-1 executor
    // sub-agent and collected its result. Advertised `true` so orchestrators/UIs
    // know pi CAN drive sub-agents; the gateway injection stays opt-in per
    // session, and depth/fan-out are bounded via `--orchestrator-json`
    // ({ maxDepth, maxChildren }). Without an injected gateway pi has no
    // agent_start tool and behaves as a leaf executor.
    sub_agents: true,
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
  tags: ["pi", "earendil", "proprietary", "rpc", "agent-runtime", "coding", "mcp-bridge"],
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
