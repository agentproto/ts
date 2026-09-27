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
import { listModels } from "@agentproto/model-catalog"

/**
 * Build pi's model menu from the shared provider catalog. Pi routes by the
 * model id's own `<provider>/<id>` prefix, so every entry carries the billing
 * provider.
 *
 * Providers: Anthropic, OpenAI, Google, Moonshot — matching models.env.
 * Moonshot ids use the `moonshotai/` wire prefix pi's model resolver expects,
 * with the canonical `moonshot` billing provider.
 *
 * OpenRouter is added separately below (not in `supported`): pi's own model
 * resolver accepts a literal `openrouter/<vendor>/<product>` id as a THIRD
 * segment (verified live: `--model openrouter/deepseek/deepseek-v4.1-flash`
 * with an OpenRouter access profile resolves and bills correctly —
 * `modelDerivedApiKey: true` below picks `OPENROUTER_API_KEY` off that
 * leading segment). Folding it into the same loop as the fixed vendors would
 * be wrong: that loop collapses `bareId` to its LAST path segment before
 * re-prefixing (`anthropic/claude-…` → `claude-…` → `anthropic/claude-…`),
 * which is correct for a single-vendor provider but would drop OpenRouter's
 * own vendor segment (`z-ai/glm-5.3-flash` → `glm-5.3-flash` →
 * `openrouter/glm-5.3-flash`, losing `z-ai`). Mirrors
 * `adapters/opencode/src/index.ts`'s `buildOpencodeModelMenu`, which hits
 * the exact same shape and special-cases it the same way.
 */
function buildPiModelMenu(): Array<{ id: string; provider: string }> {
  const supported = [
    { provider: "anthropic", prefix: "anthropic", wirePrefix: "anthropic" },
    { provider: "openai", prefix: "openai", wirePrefix: "openai" },
    { provider: "google", prefix: "google", wirePrefix: "google" },
    { provider: "moonshot", prefix: "moonshot", wirePrefix: "moonshotai" },
  ] as const

  const seen = new Set<string>()
  const out: Array<{ id: string; provider: string }> = []

  for (const { provider, prefix, wirePrefix } of supported) {
    for (const model of listModels({ kind: "llm", provider })) {
      const bareId = model.id
      // Strip any existing vendor prefix so we can re-prefix with the wire form.
      const product = bareId.includes("/") ? bareId.split("/").pop()! : bareId
      const id = `${wirePrefix}/${product}`
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ id, provider })
    }
  }

  for (const model of listModels({ kind: "llm", provider: "openrouter" })) {
    const id = `openrouter/${model.id}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, provider: "openrouter" })
  }

  return out.sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider)
    return a.id.localeCompare(b.id)
  })
}

export const pi: AgentCliHandle = defineAgentCli({
  name: "Pi",
  id: "pi",
  description:
    "earendil-works/pi — MIT headless TypeScript coding agent. Driven over pi's " +
    "persistent JSON-over-stdio RPC mode (`pi --mode rpc`) as a spawned child. " +
    "Multi-provider (Anthropic/OpenAI/Google/Moonshot/OpenRouter), streaming, live-duplex " +
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
    // PRESENCE probe — local binary check, not a registry query. Covers BOTH
    // install methods: the npm -g package and the curl installer both put a
    // `pi` executable on PATH, and it runs `--version` fully offline.
    cmd: "pi --version",
    parse: "(\\d+\\.\\d+\\.\\d+)",
    range: ">=0.80.0",
    timeout_ms: 15_000,
  },
  auth: {
    ref: "./SECRETS.md",
    state: {
      env: [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_OAUTH_TOKEN",
        "OPENAI_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
        "MOONSHOT_API_KEY",
        "OPENROUTER_API_KEY",
      ],
    },
  },
  // Pi's model router reads the provider straight off each id's own
  // `<provider>/<id>` prefix and consults the matching provider env var
  // (ANTHROPIC_API_KEY, OPENAI_API_KEY, MOONSHOT_API_KEY, …). Declaring this
  // lets the runtime's billing-auth resolver and catalog eligibility manifest
  // include api-key profiles for the model-derived direct endpoint — without
  // it, no profile is eligible and pi models show "needs a profile".
  modelDerivedApiKey: true,
  // Pi's own bearer door: `ANTHROPIC_OAUTH_TOKEN — Anthropic OAuth token
  // (alternative to API key)` (verified against pi 0.80.x `--help`). A
  // Claude subscription token (`sk-ant-oat…`, minted by `claude
  // setup-token`) is VALID there — pi presents it on the Authorization
  // bearer path — while the same token on ANTHROPIC_API_KEY is rejected
  // upstream as an invalid key. `provider: "anthropic"` scopes the surface:
  // subscription mode (and oauth-bearer profile eligibility) lights up only
  // for pi's anthropic-derived models, never its openai/google/moonshot
  // ones.
  authSubscription: {
    setEnv: "ANTHROPIC_OAUTH_TOKEN",
    provider: "anthropic",
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
    // 0.80.x cli/args.ts + core/model-resolver.ts).
    default: "anthropic/claude-sonnet-4-5",
    // Generated from the shared provider catalog. Moonshot ids use the
    // `moonshotai/` wire prefix pi's model resolver expects, with the
    // canonical `moonshot` billing provider (not the wire-format
    // `moonshotai` — see base.ts:113-121).
    allowed: buildPiModelMenu(),
    env: {
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      google: "GOOGLE_GENERATIVE_AI_API_KEY",
      // Keyed by the canonical provider slug, not the wire-format
      // `moonshotai` prefix.
      moonshot: "MOONSHOT_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
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
  modes: [
    {
      id: "default",
      description: "Default pi RPC session — pi's own built-in file/shell tools.",
    },
    // Opt-in READ-ONLY, context-minimal review session (verified against pi
    // 0.80.x `--help`: `--tools read --no-context-files --no-skills
    // --no-extensions`). `apply: "config"` is the generic escape hatch for a
    // mode with no bin_args/env surface reachable from THIS layer — pi is a
    // `protocol: "proprietary"` arm (client.ts spawns its own child directly,
    // never through the generic bin_args-compose path define-agent-cli.ts
    // uses for ACP/print arms), so `bin_args_prepend`/`env` on a mode entry
    // are silently inert for it. `apply: "config"` is the one path that
    // still reaches proprietary arms: it forwards the mode id as
    // `opts.mode` on `connect()` (define-agent-cli.ts's `configMode`)
    // regardless of arm type, and `client.ts` reads it there to push the
    // extra argv itself.
    //
    // This is layered UNDER the daemon's own required-instructions
    // injection (`agents-md.ts` / `session-spawn.ts`'s AGENTS.md pointer or
    // inline block, composed into the first prompt regardless of mode) —
    // lean mode only suppresses pi's OWN redundant re-discovery of the same
    // files plus pi's bash/edit/write tools and skills/extensions, never the
    // daemon's own contract delivery.
    //
    // Deliberately `--tools read`, NOT `--no-tools`: the daemon's own
    // AGENTS.md injection is "inline" only under `agentsMdInlineMaxKb`
    // (default 8KB, `agents-md.ts`) — a repo whose AGENTS.md is bigger than
    // that gets a POINTER sentence naming the path instead ("read it before
    // your first tool call"), and a genuinely tool-less session has no tool
    // to act on that instruction with. A pointer is a path, not the file's
    // content — do not conflate the two. Keeping pi's own `read` tool
    // enabled (pi's built-in tool ids, verified in the installed package's
    // `core/sdk.js`: `["read","bash","edit","write"]`) means a pointer stays
    // ACTIONABLE regardless of the target repo's AGENTS.md size, so required
    // repository instructions are preserved rather than merely hoped-for.
    // `bash`/`edit`/`write` and any injected MCP servers are still dropped
    // (MCP bridging is skipped outright below) — this is a read-only review
    // pass, not a tool-less one.
    {
      id: "lean",
      kind: "context",
      apply: "config",
      description:
        "Read-only, context-minimal review session: passes pi's own `--tools read " +
        "--no-context-files --no-skills --no-extensions` (keeps only pi's built-in `read` " +
        "tool — so a pointer-mode AGENTS.md instruction stays actionable — while dropping " +
        "bash/edit/write, pi's native AGENTS.md/CLAUDE.md auto-discovery, and skill/extension " +
        "discovery) and skips MCP-bridge injection. The daemon's own required AGENTS.md " +
        "injection is unaffected. Read-only by construction — do not use for a session that " +
        "needs to edit files or run commands.",
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
