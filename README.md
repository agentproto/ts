# agentproto/ts

**Write a tool once. Run it as a builtin, CLI subprocess, HTTP service, or MCP server — and project it into Mastra or the Vercel AI SDK without rewriting.**

TypeScript reference implementations of the [agentproto](https://agentproto.sh) open standards. See [`agentproto/agentproto`](https://github.com/agentproto/agentproto) for the specs; site renderer at [`agentproto/site`](https://github.com/agentproto/site).

> **Status: 0.1.0-alpha.** APIs are stabilising; expect minor breaking changes between alpha releases.

## Quick start

```bash
pnpm install
pnpm -r build
pnpm -r test
```

## Packages

The repo is organised into five layers, each a sibling subtree under `packages/` or `adapters/`.

### 1 — Tool authoring

The original three-layer model: contract → implementation → bundle.

```
packages/tool/         @agentproto/tool       AIP-14  defineTool, ToolHandle, validators
packages/driver/       @agentproto/driver      AIP-30  implementTool, defineDriver, runTool, resolver
packages/driver/cli/   @agentproto/driver-cli  AIP-29  CLI/subprocess transport
packages/driver/http/  @agentproto/driver-http         HTTP transport
packages/driver/mcp/   @agentproto/driver-mcp          MCP server transport
packages/driver/sdk/   @agentproto/driver-sdk          SDK / dynamic-import transport
```

```ts
import { defineTool } from "@agentproto/tool"
import { implementTool, defineDriver } from "@agentproto/driver"
import { z } from "zod"

const greetTool = defineTool({
  id: "greet",
  description: "Greets a name in the bound locale.",
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.object({ greeting: z.string() }),
  contextSchema: z.object({ locale: z.enum(["en", "fr"]) }),
})

const greetBuiltin = implementTool(greetTool, async ({ input, context }) => ({
  greeting: context.locale === "fr" ? `Bonjour ${input.name}` : `Hello ${input.name}`,
}))

const greetDriver = defineDriver({
  id: "greet-builtin",
  name: "Greet (builtin)",
  description: "In-process greeter.",
  kind: "builtin",
  implements: [{ tool: "greet", version: "0.1.0" }],
  implementations: [greetBuiltin],
})
```

### 2 — Framework adapters

Re-express any `ToolImplementation` in a host framework's tool shape.

```
adapters/ai-sdk/        @agentproto/adapter-ai-sdk    Vercel AI SDK Tool projection
adapters/mastra/        @agentproto/adapter-mastra     Mastra createTool projection
packages/mastra/        @agentproto/mastra             AIP-42 AGENT.md → Mastra Agent
```

```ts
import { toAiSdkTool } from "@agentproto/adapter-ai-sdk"
import { toMastraTool } from "@agentproto/adapter-mastra"

const aiSdkTool  = toAiSdkTool(greetBuiltin, { context: { locale: "en" } })
const mastraTool = toMastraTool(greetBuiltin, { source: { context: { locale: "en" } } })
```

### 3 — Runtime & daemon

`@agentproto/runtime` is the long-running gateway that turns a workspace into a live AIP runtime. It composes session management, an MCP server, an HTTP transport, the HEARTBEAT autonomy loop, and append-only conversation persistence.

```
packages/runtime/   @agentproto/runtime     Session lifecycle, MCP tools, HTTP API, supervisor / orchestrator
packages/cli/       @agentproto/cli         `agentproto` binary — install adapters, run/serve sessions, daemon
packages/mcp-server/ @agentproto/mcp-server  Per-doctype CRUD MCP tools (create/load/list/update/resolve/delete)
```

**Key MCP tools exposed by the runtime:**

| Tool | Purpose |
|---|---|
| `start_agent_session` | Launch an agent-CLI session (claude-code, hermes, opencode, …) |
| `prompt_agent_session` | Send a turn to a running agent session |
| `list_agent_sessions` | List active sessions with status |
| `get_agent_session_output` | Read session output |
| `kill_agent_session` | Terminate a session |
| `export_agent_session` | Export a clean transcript (JSONL / SQLite) |
| `summarize_session` | LLM-summarise a session transcript |
| `start_browser` / `stop_browser` / `browser_status` | Manage browser sessions |
| `attach_policy` / `cancel_policy` / `get_policy_status` | Supervisor policy lifecycle |
| `create_tunnel` / `stop_tunnel` / `tunnel_status` | Tunnel management |
| `setup_tunnel_provider` | Configure a tunnel provider (cloudflare-named, ngrok) |
| `session_tree` | Inspect the full supervisor/orchestrator tree |
| `agentproto_sessions` / `agentproto_bureau_sessions` | MCP App panel views |

### 4 — Adapter families

```
packages/adapter-kit/         @agentproto/adapter-kit     Shared catalog, creds, setup-ledger, MCP tool primitives

adapters/claude-code/         @agentproto/adapter-claude-code   AIP-45 adapter for Claude Code
adapters/hermes/              @agentproto/adapter-hermes         AIP-45 adapter for Hermes
adapters/opencode/            @agentproto/adapter-opencode       AIP-45 adapter for OpenCode
adapters/codex/               @agentproto/adapter-codex          AIP-45 adapter for Codex
adapters/openclaw/            @agentproto/adapter-openclaw       AIP-45 adapter for Openclaw
adapters/mastra-agent/        @agentproto/adapter-mastra-agent   First-party agent — AIP-42 AGENT.md run as a live Mastra agent behind ACP
adapters/browser/             @agentproto/adapter-browser        Browser / CDP session adapter
```

All agent-CLI adapters share the `adapter-kit` primitives: `makeSetupTool` (single-field or multi-field creds), `makeStatusTool`, `makeCatalogEntry`, and the creds store. `mastra-agent` is the odd one out: every other adapter wraps an *external* agent CLI, whereas `mastra-agent` is ours end to end — an `AGENT.md` run as a live Mastra agent (our loop, our models), spawned by the daemon like any arm or standalone via `agentproto-mastra acp`.

### 5 — Knowledge & workflow

```
packages/corpus/          @agentproto/corpus         AIP-10/12/18 knowledge composition (pure, no I/O)
packages/corpus-cli/      @agentproto/corpus-cli     `corpus` binary — validate, lint, operate a corpus workspace
packages/workflow-runtime/ @agentproto/workflow-runtime  AIP-15 typed step-walker (tool/map/branch/loop/transform)
packages/agent-runtime/   @agentproto/agent-runtime  MultiAgentRuntime kernel with swappable ports
```

`@agentproto/corpus` composes AIP-10 KNOWLEDGE, AIP-12 PLAYBOOK, AIP-18 COLLECTION, AIP-9 OPERATOR, AIP-15 WORKFLOW, and AIP-41 ROUTINE into an autonomous knowledge-improvement system. Pure: zero runtime, zero filesystem, zero HTTP — all I/O via injected ports.

## Specifications

The AIP markdown specs live in [agentproto/agentproto](https://github.com/agentproto/agentproto). Browse rendered versions at <https://agentproto.sh/docs>.

Key specs implemented here:

| AIP | Spec | Package |
|---|---|---|
| AIP-9 | OPERATOR.md | `@agentproto/operator` |
| AIP-10 | KNOWLEDGE.md | `@agentproto/corpus` |
| AIP-12 | PLAYBOOK.md | `@agentproto/corpus` |
| AIP-14 | TOOL.md | `@agentproto/tool` |
| AIP-15 | WORKFLOW.md | `@agentproto/workflow`, `@agentproto/workflow-runtime` |
| AIP-17 | RUNNER.md | `@agentproto/runner` |
| AIP-18 | COLLECTION.md | `@agentproto/corpus` |
| AIP-29 | CLI.md | `@agentproto/driver-cli` |
| AIP-30 | DRIVER.md | `@agentproto/driver` |
| AIP-40 | EXTENSION.md | `@agentproto/extension` |
| AIP-41 | ROUTINE.md | `@agentproto/routine` |
| AIP-42 | AGENT.md | `@agentproto/agent`, `@agentproto/mastra` |
| AIP-45 | Agent CLI adapter | `adapters/{claude-code,hermes,opencode,codex,openclaw,mastra-agent}` |

## License

MIT — see [LICENSE](./LICENSE).

## Contributing

Spec evolution happens at [agentproto/agentproto](https://github.com/agentproto/agentproto). This repo tracks AIP progression — implementations follow as AIPs reach Review/Final status. PRs welcome for runtime bugfixes, perf, and adapter coverage.
