# agentproto/ts

**Open-source runtime that runs and supervises coding agents, locally or in
cloud sandboxes.**

agentproto is a local daemon plus a CLI. It starts coding agents such as Claude
Code, Codex and opencode as background sessions, lists them in one place, and
lets you attach a check (your tests, or a reviewer agent) that runs when an
agent finishes a turn. If you like an operating-system analogy, it works like
an OS layer for agents: session lifecycle, scheduling, permissions and tasks.
It is not an operating system: no kernel, and no isolation unless you ask for
a sandbox.

- **Run agents the same way.** Start, message, watch, and stop agent sessions
  with the same commands. Claude Code, Codex and opencode are the adapters we
  use and test day to day; the other adapters (Hermes, Gemini, Grok CLI and
  more) exist at varying maturity.
- **Checked work, opt-in per session.** Attach a gate (a shell command such as
  your test suite, or a judge agent) with `agentproto policy attach`. If the
  gate fails the policy ends `blocked`, or, if you set `--on-fail-nudge` or
  `--on-fail-max-retries`, the session is re-prompted (2 times by default)
  before it is `blocked`. With `--then commit`, a green gate stages a commit that
  waits for your explicit `policy ack --approve` (`requireHumanAck` defaults to
  on). Nothing is gated unless you attach a policy.
- **Locally or in cloud sandboxes you connect.** The daemon runs on your
  machine, and the agent processes it starts run with your own user rights. If
  the daemon or the machine stops, nothing runs, wakes or is checked. A
  session can instead run in a sandbox box (`sandbox` option of `agent_start`,
  providers such as e2b, with your own account). agentproto is not a hosted
  service.
- **Keep the tools you have.** It drives the agent CLIs you already use,
  nothing to rewrite. Agents can also start and supervise other agents.
- **And a toolbox around them.** Author tools as files and serve them, import
  MCP servers and hand them to the agents it runs, open tunnels, drive
  browsers, schedule workflows and cron runs.

The daemon is the most mature surface of something bigger: **agentproto is an
open set of file formats** (the [AIP specs](https://agentproto.sh/docs)) that
describe agent components (tools, skills, agents, knowledge, workflows,
policies) as plain files with a declared contract, and this repo is the
TypeScript runtime that loads and runs them and projects them into hosts (CLI,
HTTP, MCP, Mastra, Vercel AI SDK). Most of the specs beyond the daemon are
early; see "What's live vs. roadmap" below.

> **Status: 1.x, APIs stabilising.** Expect minor breaking changes between
> releases.

## Quick start

Tested on a clean HOME and npm prefix (macOS arm64, Node 24, `@agentproto/cli`
from npm). You need Node.js and, for the example below, the Claude Code agent
setup described in step 3.

```bash
# 1. install the CLI and the adapter for the agent you want to drive
npm i -g @agentproto/cli
agentproto install claude-code   # installs the adapter package and its ACP bridge

# 2. start the daemon (foreground, http://127.0.0.1:18790 by default)
agentproto serve
```

In a second terminal:

```bash
# 3. give the adapter a credential. A new install has none and the first
#    session fails with `missing_auth_credential` until you do one of:
claude setup-token                          # Claude subscription
agentproto auth provider set anthropic <your-api-key>   # or an API key

# 4. first session
agentproto sessions start claude-code --cwd . --prompt "refactor the payments module"
agentproto sessions --watch
```

Then gate it: attach a policy to the session's turn-end and hold a commit
behind a human ack (`--then commit` requires `--commit-path` and
`--commit-message`; `<id>` is the session id shown by `agentproto sessions`):

```bash
agentproto policy attach --session <id> --then commit \
  --commit-path src --commit-message "refactor payments" \
  -- pnpm test
agentproto policy status <policyId>
agentproto policy ack <policyId> --approve    # or --reject
```

See [docs/cli/guides/gates.md](./docs/cli/guides/gates.md) for gates in depth
and [agentproto.sh](https://agentproto.sh) for the pitch. A one-line bootstrap
script also exists (`scripts/bootstrap/install.sh` on macOS/Linux,
`install.ps1` on Windows).

## What's live vs. roadmap

This repo ships two very different things under one name:

- **Tier 1, live:** the daemon, the CLI, durable policy gates, nested
  orchestration with role gating, fan-in monitoring, workflows/cron, and an MCP
  surface on the daemon itself. Adapters: Claude Code, Codex and opencode are
  the ones used and tested hands-on; the other adapters in `adapters/` are of
  varying maturity.
- **Tier 2 — the wider AIP spec family:** 72 numbered specs live in
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
gaps: Cursor (`agent` CLI, ACP-capable — not verified end to end), aider,
goose, cline, Continue. See `adapters/claude-code`
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
| `message_parent` | Child session reports a result, progress update, or blocker up to its parent supervisor (resolved from the child's recorded `parentSessionId`; no session id argument) |
| `agent_set_model` / `agent_set_effort` / `agent_set_posture` | Best-effort live switches for a session's config axes (return `{applied:false, reason}` when the running adapter can't apply them live) |
| `agent_sessions_list` / `agent_export` | List agent sessions; export a clean transcript |
| `conversation_read` | Read the provider-native conversation behind any session (agent-cli or PTY) |
| `session_list` / `session_tree` / `session_usage` / `session_restart` | Canonical session list, hierarchy, usage, and resume |
| `session_archive` / `session_unarchive` | Hide / restore sessions from the canonical list (VS Code "show archived" toggle) |
| `session_rename` / `session_set_pinned` | Set or clear a session's user-facing `title` / `label`, or toggle its pinned sort flag |
| `session_flag_status` | Manually correct a session's `awaitingInput` / `awaitingQuestion` classification |
| `worktree_gc` | Plan/apply garbage collection of linked git worktrees |
| `terminal_start` / `terminal_input` / `terminal_output` / `terminal_kill` | Drive raw PTY sessions |
| `command_log_tail` | Read the JSONL audit log for `command_execute` |
| `policy_attach` / `policy_cancel` / `policy_status` | Supervisor completion-policy lifecycle |
| `workflow_run_file` / `workflow_start` / `workflow_status` / `workflow_cancel` | Run WORKFLOW.md and stage-barrier workflows |
| `app_install` / `app_run` / `app_list` / `app_status` / `app_stop` | Install and run `@agentproto/app` apps as live agent sessions |
| `app_apply` / `app_unapply` / `app_list_applied` | Mount / unmount apps to scopes with dependency validation |
| `app_data_read` / `app_data_write` / `app_data_list` / `app_data_migrate` | App-scoped durable data plane (read/write/list + legacy migration), anchored at the app's `dataDir` (default `<dir>/data`) |
| `harness_preset_list` / `harness_preset_create` / `harness_preset_delete` / `harness_preset_set_default` | Persisted harness→auth-profile presets |
| `workspace_brain_query` / `workspace_brain_status` / `workspace_brain_ingest` | Per-workspace transcript recall (BM25) |
| `memory_search` / `memory_list` / `memory_read` / `memory_write` / `memory_supersede` / `memory_archive` / `memory_dismiss` | AIP-72 memory store (`memory.root`, default `~/.agentproto/memory`); anyone proposes, the operator or a supervisor commits; memory-bound agents get a spawn digest in their system prompt |
| `conversation_export` | Export a daemon transcript to a target adapter's native store (claude-code today) |
| `llm_endpoint_start` / `llm_endpoint_stop` / `llm_endpoint_status` / `llm_endpoint_set_upstream_link` / `llm_endpoint_list_links` | Local LLM Endpoint proxy sidecar (requires `features.llmEndpoint`) |
| `tunnel_create` / `tunnel_list` / `tunnel_stop` / `tunnel_revoke` / `tunnel_status` | Public URL tunnels for local ports (private signed link by default; `public: true` opts out; `tunnel_revoke` invalidates the link) |
| `list_provider_presets` | Gateway presets (Anthropic, Moonshot, OpenRouter, Requesty, DeepSeek, xAI) |
| `harness_list` / `harness_models` / `harness_install` | List installed harnesses (agent CLIs), page one harness's models, install one by slug (`adapter_list` / `adapter_models` / `adapter_install` are deprecated aliases) |
| `harness_capabilities` | Discover what an installed adapter can do on this host |
| `catalog_models` | Read-only catalog of runnable models + routes (daemon `GET /catalog/models`) |
| `list_sandbox_providers` / `setup_sandbox_provider` | Sandbox provider catalog and credentials |
| `sandbox_exec` | Run one command in a sandbox box (ephemeral, or an existing `sandboxId`) and return exit code + stdout/stderr |
| `list_eval_reporters` / `setup_eval_reporter` | Eval-reporter backends (e.g. Langfuse) |
| `browser_navigate` / `browser_extract_text` / `browser_click` / … / `list_browsers` | Browser page tools, forwarded to the Bureau MCP (`defaults.browser.proxyImport`, default `bureau`); `fetch_page` reads a URL without a browser |
| `mcp_discovered_list` / `mcp_imported_list` / `mcp_import` / `mcp_imported_remove` | Discover and curate imported MCP servers |
| `mcp_imported_status` / `mcp_imported_tool_list` / `mcp_imported_call` | Proxy imported MCP tools |
| `skill_import` / `skill_imported_list` / `skill_imported_remove` / `skill_resync` | Curate imported skills (a `SKILL.md` folder is copied into `~/.agentproto/skills/<id>/`) for per-session delivery |
| `permissions_list` / `permissions_respond` | Held permission requests across permission-hold sessions |
| `cron_create` / `cron_list` / `cron_delete` / `cron_run` | Recurring daemon jobs (opt-in) |
| `role_list` | Enumerate spawn-time roles and delegation privileges |
| `daemon_health` | Cheap in-process liveness probe |
| `agentproto_session_story` / `agentproto_terminal` | Per-session story / live PTY MCP App panels |
| `agentproto_sessions` / `agentproto_bureau_sessions` | MCP App panel views |

### 2 — Adapter families

```
packages/provider-kit/        @agentproto/provider-kit    Shared catalog, creds, setup-ledger, MCP tool primitives
packages/provider-presets/    @agentproto/provider-presets   Shared gateway preset registry (Anthropic, Moonshot, OpenRouter, Requesty, DeepSeek, xAI, xAI-Anthropic, LLM Endpoint)

adapters/claude-code/         @agentproto/adapter-claude-code   AIP-45 adapter for Claude Code
adapters/claude-sdk/          @agentproto/adapter-claude-sdk    AIP-45 adapter for Claude SDK (Anthropic/Moonshot/OpenRouter gateway modes)
adapters/codex/                @agentproto/adapter-codex          AIP-45 adapter for Codex
adapters/gemini/              @agentproto/adapter-gemini        AIP-45 adapter for Gemini
adapters/hermes/              @agentproto/adapter-hermes         AIP-45 adapter for Hermes
adapters/opencode/            @agentproto/adapter-opencode       AIP-45 adapter for OpenCode
adapters/openclaw/            @agentproto/adapter-openclaw       AIP-45 adapter for Openclaw
adapters/antigravity/         @agentproto/adapter-antigravity    AIP-45 adapter for Google Antigravity
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
packages/bridge/        @agentproto/bridge             AIP-42 AGENT.md → Mastra Agent
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
packages/processor/     @agentproto/processor      Dependency-free Redactor port for transcript/log scrubbing
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
| AIP-42 | AGENT.md | `@agentproto/agent`, `@agentproto/bridge` |
| AIP-45 | Agent CLI adapter | `adapters/{claude-code,claude-sdk,hermes,opencode,codex,openclaw,mastra-agent,antigravity,jcode}` |
| AIP-57 | Model resolution primitive | `@agentproto/model-routing` |
| AIP-62 | REVIEW.md | `@agentproto/review` |
| AIP-65 | DECISION.md | `@agentproto/runtime` |
| AIP-66 | Managed cloud agents (`cloud:<vendor>` target) | `@agentproto/runtime`, `adapters/claude-code-cloud` |

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
