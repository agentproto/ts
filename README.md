# agentproto/ts

**Let your coding agents work without you watching.**

agentproto runs Claude Code, Codex, Hermes, opencode, Mastra, and any other
coding agent in the background, shows them all in one place, and checks each
one's work — with your tests or a reviewer model — before anything is
committed. No more babysitting terminal windows.

- **Run them all the same way.** Start, message, watch, and stop any agent
  with the same commands. Nine adapters today.
- **Work checked before it lands.** Attach a check — your tests, or a stronger
  model reviewing the change — and it runs each time the agent finishes.
  Commits wait for the check and your OK, even after you close your laptop.
- **Keep the tools you have.** It drives the agent CLIs you already use —
  nothing to rewrite. Agents can even run and check other agents.
- **And a full toolbox around them.** Author tools as files and serve them,
  import any MCP server and hand it to any agent, open tunnels, drive
  browsers, schedule workflows and cron runs.

The daemon is the flagship surface of something bigger: **agentproto is an
open agentic framework** — the [AIP specs](https://agentproto.sh/docs) define
every agent component (tools, skills, agents, knowledge, workflows, policies)
as a plain file with a declared contract, and this repo is the TypeScript
runtime that loads, runs, and projects them into any host (CLI, HTTP, MCP,
Mastra, Vercel AI SDK). Files with contracts is what lets any runtime load
them — and lets agents read, write, and improve their own components.

> **Status: 0.9.0-alpha.** APIs are stabilising; expect minor breaking changes
> between alpha releases.

## Quick start

```bash
npm i -g @agentproto/cli
agentproto install claude-code   # auto-installs the adapter package too
agentproto serve                 # start the daemon (foreground)
agentproto sessions start claude-code --cwd . --prompt "refactor the payments module"
agentproto sessions --watch
```

Then gate it: attach a policy to any session's turn-end and stage the commit
behind a human ack. See [agentproto.sh](https://agentproto.sh) for the full
pitch, or jump straight to [agentproto.sh/features](https://agentproto.sh/features)
for the honest split below.

## What's live vs. roadmap

This repo ships two very different things under one name:

- **Tier 1 — live, verified hands-on:** the daemon, the CLI, nine agent
  adapters (Claude Code, Claude SDK, Codex, Hermes, opencode, Mastra Code +
  in-process, Mastra Agent, OpenClaw, browser-as-agent), durable policy gates,
  nested orchestration with role gating, fan-in monitoring, workflows/cron,
  and an MCP surface (~90 tools) on the daemon itself.
- **Tier 2 — the wider AIP spec family:** ~52 numbered specs live in
  [agentproto/agentproto](https://github.com/agentproto/agentproto). Most
  reference-implementation packages beyond Tier 1 are `0.1.0-alpha`
  scaffolding — real schemas, real intent, not yet operational software.

Full breakdown: <https://agentproto.sh/features>. If you find a Tier 2 claim
anywhere that reads as shipped, please file an issue — that split is the
contract.

## Contributing an adapter

The adapter contract is small: declare `models[]` and `modes[]` via an
AIP-45 manifest, implement the lifecycle verbs, and reuse the shared
`provider-kit` primitives (creds, catalog entry, setup/status tools). Obvious
gaps: gemini-cli, aider, goose, cline, Continue. See `adapters/claude-code`
for a complete reference implementation, and look for `good first issue`
labels in the tracker.

## VS Code extension

`packages/vscode` contains the private `agentproto-vscode` extension: local
operational views for daemon sessions and permissions, plus commands to manage
agents from the editor. Every [Releases](https://github.com/agentproto/ts/releases)
asset is built in CI, never committed to the repo:

- **Dev builds** — every push to `main` touching `packages/vscode` publishes
  a prerelease VSIX tagged `vscode-dev-<sha>`, for grabbing the bleeding
  edge.
- **Official releases** — a "Version Packages" PR merge that included
  vscode changes publishes a versioned VSIX tagged `vscode-v<version>`,
  same cadence as every other package's release.

Install either through VS Code's **Extensions: Install from VSIX...**
command.

To build one yourself instead:

```bash
cd packages/vscode
pnpm package
unzip -t agentproto-vscode-*.vsix
```

See [`packages/vscode/README.md`](./packages/vscode/README.md) for
development and verification commands.

## Packages

The repo is organised into five layers, each a sibling subtree under
`packages/` or `adapters/`.

### 1 — Runtime & daemon

`@agentproto/runtime` is the long-running gateway that turns a workspace into
a live AIP runtime: session management, an MCP server, an HTTP transport, the
HEARTBEAT autonomy loop, and append-only conversation persistence.

```
packages/runtime/    @agentproto/runtime     Session lifecycle, MCP tools, HTTP API, supervisor / orchestrator
packages/cli/        @agentproto/cli         `agentproto` binary — install adapters, run/serve sessions, daemon
packages/mcp-server/ @agentproto/mcp-server  Per-doctype CRUD MCP tools (create/load/list/update/resolve/delete)
```

**Key MCP tools exposed by the runtime:**

| Tool | Purpose |
|---|---|
| `agent_start` / `agent_prompt` / `agent_output` / `agent_kill` / `agent_interrupt` | Spawn, drive, interrupt, and stop long-lived agent-CLI sessions |
| `agent_set_model` / `agent_set_effort` / `agent_set_posture` | Best-effort live switches for a session's config axes (return `{applied:false, reason}` when the running adapter can't apply them live) |
| `agent_sessions_list` / `agent_export` | List agent sessions; export a clean transcript |
| `conversation_read` | Read the provider-native conversation behind any session (agent-cli or PTY) |
| `session_list` / `session_tree` / `session_usage` / `session_restart` | Canonical session list, hierarchy, usage, and resume |
| `session_archive` / `session_unarchive` | Hide / restore sessions from the canonical list (VS Code "show archived" toggle) |
| `terminal_start` / `terminal_input` / `terminal_output` / `terminal_kill` | Drive raw PTY sessions |
| `command_log_tail` | Read the JSONL audit log for `command_execute` |
| `policy_attach` / `policy_cancel` / `policy_status` | Supervisor completion-policy lifecycle |
| `workflow_run_file` / `workflow_start` / `workflow_status` / `workflow_cancel` | Run WORKFLOW.md and stage-barrier workflows |
| `tunnel_create` / `tunnel_list` / `tunnel_stop` / `tunnel_status` | Public URL tunnels for local ports |
| `list_provider_presets` | Gateway presets (Anthropic, Moonshot, OpenRouter, Requesty, DeepSeek, xAI) |
| `catalog_models` | Read-only catalog of runnable models + routes (daemon `GET /catalog/models`) |
| `list_sandbox_providers` / `setup_sandbox_provider` | Sandbox provider catalog and credentials |
| `list_eval_reporters` / `setup_eval_reporter` | Eval-reporter backends (e.g. Langfuse) |
| `start_browser` / `stop_browser` / `browser_status` | Manage browser sessions |
| `mcp_discovered_list` / `mcp_imported_list` / `mcp_import` / `mcp_imported_remove` | Discover and curate imported MCP servers |
| `mcp_imported_status` / `mcp_imported_tool_list` / `mcp_imported_call` | Proxy imported MCP tools |
| `permissions_list` / `permissions_respond` | Held permission requests across permission-hold sessions |
| `cron_create` / `cron_list` / `cron_delete` / `cron_run` | Recurring daemon jobs (opt-in) |
| `role_list` | Enumerate spawn-time roles and delegation privileges |
| `daemon_health` | Cheap in-process liveness probe |
| `agentproto_session_story` / `agentproto_terminal` | Per-session story / live PTY MCP App panels |
| `agentproto_sessions` / `agentproto_bureau_sessions` | MCP App panel views |

### 2 — Adapter families

```
packages/provider-kit/        @agentproto/provider-kit    Shared catalog, creds, setup-ledger, MCP tool primitives
packages/provider-presets/    @agentproto/provider-presets   Shared gateway preset registry (Anthropic, Moonshot, OpenRouter, Requesty, DeepSeek, xAI)

adapters/claude-code/         @agentproto/adapter-claude-code   AIP-45 adapter for Claude Code
adapters/claude-sdk/          @agentproto/adapter-claude-sdk    AIP-45 adapter for Claude SDK (Anthropic/Moonshot/OpenRouter gateway modes)
adapters/hermes/              @agentproto/adapter-hermes         AIP-45 adapter for Hermes
adapters/opencode/            @agentproto/adapter-opencode       AIP-45 adapter for OpenCode
adapters/codex/                @agentproto/adapter-codex          AIP-45 adapter for Codex
adapters/openclaw/            @agentproto/adapter-openclaw       AIP-45 adapter for Openclaw
adapters/mastra-agent/        @agentproto/adapter-mastra-agent   First-party agent — AIP-42 AGENT.md run as a live Mastra agent behind ACP
adapters/browser/             @agentproto/adapter-browser        Browser / CDP session adapter
```

All agent-CLI adapters share the `provider-kit` primitives: `makeSetupTool`
(single-field or multi-field creds), `computeStatus`, `AdapterCatalogEntry`, and
`makeCredsStore`. `mastra-agent` is the odd one out: every other adapter wraps
an *external* agent CLI, whereas `mastra-agent` is ours end to end — an
`AGENT.md` run as a live Mastra agent (our loop, our models), spawned by the
daemon like any arm or standalone via `agentproto-mastra acp`.

### 3 — Tool authoring

The original three-layer model for tools consumed inside the runtime or
projected into a host framework: contract → implementation → bundle.

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

Re-express any `ToolImplementation` in a host framework's tool shape:

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

### 4 — Knowledge & workflow

```
packages/corpus/          @agentproto/corpus         AIP-10/12/18 knowledge composition (pure, no I/O)
packages/corpus-cli/      @agentproto/corpus-cli     `corpus` binary — validate, lint, operate a corpus workspace
packages/workflow-runtime/ @agentproto/workflow-runtime  AIP-15 typed step-walker (tool/map/branch/loop/transform)
packages/agent-runtime/   @agentproto/agent-runtime  MultiAgentRuntime kernel with swappable ports
```

`@agentproto/corpus` composes AIP-10 KNOWLEDGE, AIP-12 PLAYBOOK, AIP-18
COLLECTION, AIP-9 OPERATOR, AIP-15 WORKFLOW, and AIP-41 ROUTINE into an
autonomous knowledge-improvement system. Pure: zero runtime, zero filesystem,
zero HTTP — all I/O via injected ports.

### 5 — Platform: auth, sandbox, secrets, telemetry

```
packages/auth/          @agentproto/auth           Pluggable CredentialStore + device-code (RFC 8628) auth flow
packages/sandbox/       @agentproto/sandbox        agent_start.sandbox: boot/reconnect/pause an isolated box
packages/secrets/       @agentproto/secrets        Broker-resolved provision auth headers, mcp-header exposure
packages/redaction/     @agentproto/redaction      Dependency-free Redactor port for transcript/log scrubbing
packages/telemetry/     @agentproto/telemetry      Telemetry port + OTel adapter
packages/eval/          @agentproto/eval           Scorers + runEval, including an LLM-judge scorer
```

## Specifications

The AIP markdown specs live in
[agentproto/agentproto](https://github.com/agentproto/agentproto). Browse
rendered versions at <https://agentproto.sh/docs>.

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
| AIP-36 | SANDBOX.md | `@agentproto/sandbox` |
| AIP-40 | EXTENSION.md | `@agentproto/extension` |
| AIP-41 | ROUTINE.md | `@agentproto/routine` |
| AIP-42 | AGENT.md | `@agentproto/agent`, `@agentproto/mastra` |
| AIP-45 | Agent CLI adapter | `adapters/{claude-code,claude-sdk,hermes,opencode,codex,openclaw,mastra-agent}` |

## Building from source

```bash
pnpm install
pnpm -r build
pnpm -r test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE). Copyright 2026 Jeremy André and agentproto contributors.

## Contributing

Spec evolution happens at
[agentproto/agentproto](https://github.com/agentproto/agentproto). This repo
tracks AIP progression — implementations follow as AIPs reach Review/Final
status. PRs welcome for runtime bugfixes, perf, and adapter coverage — see
"Contributing an adapter" above.
