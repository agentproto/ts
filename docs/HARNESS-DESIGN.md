# `@agentproto/harness` — design

> Status: **design + scaffold** (phase 1). Harness bodies are stubs; implementation
> is broken into WP1–WP6 below for execution by `deepseek-v4-pro` via `hermes`.

A thin, typed library that lets a caller spin up a **pre-configured agent
session** — `coder`, `researcher`, `supervisor` — with one function call, the
way Mastra ships typed agent harnesses. Each harness is a recipe over the
agentproto daemon's existing session tools; the library adds **no new daemon
surface**, only ergonomic presets + a turn-aware wrapper.

---

## 1. Current-state inventory

### 1.1 The session tools (the substrate we wrap)

Registered in `packages/runtime/src/session-tools.ts` (and orchestration extras
in `packages/runtime/src/orchestration-tools.ts`), exposed as MCP tools on the
daemon's `/mcp` endpoint:

| Tool | Purpose | Key params (verified) |
| --- | --- | --- |
| `agent_start` | spawn a long-running agent CLI | `adapter` (req), `cwd?` / `workspaceSlug?`, `prompt?`, `label?`, `model?`, `effort?`, `mcpServers?`, `orchestrator?` (`true` \| `{tools?, maxDepth?, maxChildren?}`), `notifyUrl?`; returns the session as `{ id }` — `agent-tools.ts` |
| `agent_prompt` | follow-up turn, no respawn | `sessionId` \| `id` (req, aliases), `prompt` (req); returns immediately `{ ok, sessionId, queued:true }` — `agent-tools.ts` |
| `agent_output` | tail ring buffer | `sessionId` \| `id` (req, aliases), `lastN?` (default 80, max 500) — `agent-tools.ts` |
| `agent_kill` | SIGTERM the session | `sessionId` \| `id` (aliases) — `agent-tools.ts` |
| `session_list` / `agent_sessions_list` | enumerate (scoped on sub-gateway) | `kind?`, `onlyAlive?`, `status?` — `session-tools.ts` / `agent-tools.ts` |
| `session_monitor` | multiplexed long-poll, block until ANY session fires a lifecycle event | `sessionIds` (array or single id, 1–20) \| `sessionId` \| `id`, `timeoutMs?` (default 25 000, max 49 000), `event?` (`turn-end`\|`awaiting-input`\|`exited`\|`any`) — `orchestration-tools.ts` |
| `session_events_poll` | cheap cursor pull of events since last call | `orchestration-tools.ts` |
| `session_tree` | nested subtree view | `session-tools.ts:1164-` |

**Turn semantics (important):** `agent_prompt` is **fire-and-forget** —
it kicks `registry.sendPrompt(...)` without awaiting and returns
`{ queued: true }`. Completion is detected out-of-band: a session sets
`awaitingInput=true` and the daemon emits `session:turn-end` /
`session:awaiting-input` on its event bus. So a harness's `waitForTurn()` is a
**`session_monitor` long-poll** (or `/events` SSE), not a return value.

### 1.2 Adapter slugs + model routing

Adapters live in top-level `adapters/`. The `adapter` field of
`agent_start` is the adapter **slug**:

| Slug | Package | Kind | Default model | `model` handling |
| --- | --- | --- | --- | --- |
| `claude-code` | `@agentproto/adapter-claude-code` | ACP | `claude-sonnet-4-6` | applied via ACP `session/set_config_option` after `newSession` (NOT a CLI flag). Allowed: `claude-sonnet-4-6`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-haiku-4-5` |
| `hermes` | `@agentproto/adapter-hermes` | ACP | `anthropic/claude-sonnet-4-6` | provider-prefixed string; routed via OpenRouter/Anthropic/OpenAI per `models.env`. Allowed list in-manifest: `anthropic/claude-sonnet-4-6`, `anthropic/claude-opus-4-7`, `openai/gpt-4`, `meta-llama/llama-3.3-70b` (`adapters/hermes/src/index.ts:64-79`) |
| `opencode` | `@agentproto/adapter-opencode` | ACP | — | `--model {value}` (CLI), supports `openrouter/<provider>/<model>` |
| `codex` | `@agentproto/adapter-codex` | ACP | `gpt-5-codex` | `--model {value}`, enum |
| `openclaw` | `@agentproto/adapter-openclaw` | ACP | gateway-managed | n/a in manifest |

> ⚠️ **Grounding note on the requested models.** The harness brief names
> `hermes + deepseek-v4-pro` (coder) and `hermes + GLM-5.2` (researcher). Those
> ids are **not** in hermes's in-manifest `allowed` list today — hermes routes
> through OpenRouter, so they would be passed as provider-prefixed strings
> (e.g. `openrouter/deepseek/deepseek-v4-pro`, `openrouter/z-ai/glm-5.2`) with
> `OPENROUTER_API_KEY` set. The harness therefore treats `model` as an **opaque
> string** and exposes overridable preset defaults rather than a hard enum.
> Confirm the exact OpenRouter slugs against a live `hermes` before relying on
> them — see WP6. (Reference: `.skills/agentproto-plugin-v0.3.0/skills/light-coder-orchestration/SKILL.md`.)

### 1.3 Existing harness-like code

- **`packages/runtime/src/supervisor.ts`** — `CompletionPolicySupervisor`: a
  server-side state machine that watches `session:turn-end`, gates on a shell
  command or judge-agent, then acts (emit / git auto-commit), with fan-in across
  N sessions and DAG chaining. This is a **post-spawn workflow engine**, not a
  spawn ergonomics layer — our `supervisor` harness is a *client-side* recipe and
  is complementary, not a replacement.
- **`orchestrator` param + scoped sub-gateway** (`orchestrator-gateway.ts`) —
  lets a spawned session itself become a depth/quota-bounded orchestrator that
  can spawn its own children. The `supervisor` harness sets `orchestrator: true`.
- No existing client-side "create a typed session in one call" wrapper exists —
  that's the gap this package fills.

### 1.4 How a client calls the daemon (chosen transport)

Three options exist: (a) in-process `SessionsRegistry` (only if colocated in the
daemon process), (b) raw HTTP `/sessions` + `/events` SSE, (c) **MCP client over
`StreamableHTTPClientTransport` to `/mcp`**.

**We choose (c).** It's the proven, daemon-agnostic path already used by
`packages/cli/src/commands/mcp-bridge.ts:30-58`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const client = new Client({ name: "harness", version: "0.1.0" }, { capabilities: {} })
await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:18790/mcp")))
const res = await client.callTool({ name: "agent_start", arguments: { adapter: "claude-code", cwd, prompt } })
```

Default daemon endpoint: `http://127.0.0.1:18790/mcp` (port 18790, overridable
via `AGENTPROTO_MCP_URL` / `~/.agentproto/config.json → daemon.port`;
`serve.ts:186,865`). Tool results come back as `content: [{ type:"text", text: JSON }]`
— the wrapper parses the text payload back to typed objects.

---

## 2. Proposed package: `@agentproto/harness`

### 2.1 Public shape

```ts
// one transport, shared by all harnesses
const dx = await connectHarness({ url?: string })   // wraps an MCP Client over /mcp

// typed presets — each returns the SAME AgentHandle contract
const coder = await createCoderHarness(dx, opts)
const researcher = await createResearcherHarness(dx, opts)
const supervisor = await createSupervisorHarness(dx, opts)
```

Every harness resolves to the uniform **`AgentHandle`**:

```ts
interface AgentHandle {
  readonly sessionId: string
  readonly adapter: string
  readonly model?: string
  /** Send a follow-up turn (fire-and-forget at the daemon). */
  send(prompt: string): Promise<void>
  /** Block until this session ends its current turn (session_monitor). */
  waitForTurn(opts?: { timeoutMs?: number }): Promise<TurnResult>
  /** Convenience: send + waitForTurn + return the new tail. */
  ask(prompt: string, opts?: { timeoutMs?: number }): Promise<string>
  /** Tail the ring buffer (agent_output). */
  output(opts?: { lastN?: number }): Promise<string>
  /** SIGTERM the session (agent_kill). */
  kill(): Promise<void>
}
```

`TurnResult = { sessionId, event: "turn-end"|"awaiting-input"|"exited"|"timeout", status, awaitingInput }`.

### 2.2 The three harnesses (presets over `agent_start`)

Each `createXxxHarness` = compose a preset → call `agent_start` →
return an `AgentHandle`. Defaults are overridable per call.

**`createCoderHarness(dx, opts)`**
- adapter: `claude-code` (default) — or `hermes` with
  `model: "openrouter/deepseek/deepseek-v4-pro"` when `opts.engine === "hermes"`.
- `cwd`: `opts.workspace` (absolute) or `workspaceSlug`.
- `model`: default `claude-opus-4-8` for claude-code; `effort` default `high`.
- Injects an initial **coding context** system-ish prompt: stack, conventions,
  gate commands (from `opts.context` — e.g. `pnpm check-types`, `pnpm build`,
  `pnpm test`). Sent as the spawn `prompt` or first turn.
- `opts`: `{ workspace?, workspaceSlug?, engine?: "claude-code"|"hermes", model?, effort?, context?: CoderContext, label?, mcpServers? }`.

**`createResearcherHarness(dx, opts)`**
- adapter: `hermes`, `model` default `openrouter/z-ai/glm-5.2` (big context) —
  overridable.
- Mounts web-search MCP server(s) via `mcpServers` (e.g. a `bureau`/search MCP);
  the preset accepts `opts.searchMcp` or a sane default ref.
- Injects a **structured-output** instruction (the preset ships a default schema
  hint: `{ findings[], sources[], confidence }`) so replies are parseable.
- `opts`: `{ model?, searchMcp?, outputSchema?, cwd?, workspaceSlug?, label?, mcpServers? }`.

**`createSupervisorHarness(dx, opts)`**
- adapter: `claude-code`, `model` default `claude-opus-4-8`.
- `orchestrator: true` (or `{ maxDepth, maxChildren, tools }`) so the session can
  spawn + supervise its OWN sub-agents via the scoped sub-gateway.
- Accepts a **WP list** (`opts.workPackages: WorkPackage[]`) and renders it into
  the spawn prompt as an orchestration brief (assign each WP to a sub-agent,
  gate, report).
- Adds helpers: `handle.subtree()` (→ `session_tree`) and
  `handle.waitForAnyChild()` (→ `session_monitor` over child ids) for fan-in.
- `opts`: `{ workspace?, workspaceSlug?, model?, effort?, orchestrator?, workPackages?: WorkPackage[], label? }`.

### 2.3 Internal layering

```
createCoderHarness / createResearcherHarness / createSupervisorHarness   (presets)
        ↓ build args
HarnessClient  (client.ts)   ── start() · prompt() · output() · waitForTurn() · kill()
        ↓ callTool over
MCP Client + StreamableHTTPClientTransport → daemon /mcp
```

`HarnessClient` is the only place that touches the MCP SDK + JSON-payload
parsing; presets stay pure data → args.

---

## 3. Work-package breakdown (for `deepseek-v4-pro` via `hermes`)

Each WP is scoped to a few files with an explicit gate. Order is dependency-frozen.

| WP | Scope | Files | Gate |
| --- | --- | --- | --- |
| **WP1 — transport client** | Implement `HarnessClient`: connect over `StreamableHTTPClientTransport`, `callTool` helper that unwraps `content[0].text` → JSON, typed `start/prompt/output/kill/waitForAny`. Mirror `mcp-bridge.ts:30-58`. | `src/client.ts`, `src/types.ts` | `pnpm --filter @agentproto/harness check-types` |
| **WP2 — AgentHandle + connect** | `connectHarness()` factory; `makeHandle(client, sessionId, meta)` implementing `send/waitForTurn/ask/output/kill` over WP1. `waitForTurn` = `session_monitor` with timeout→`{event:"timeout"}`. | `src/handle.ts`, `src/index.ts` | `pnpm --filter @agentproto/harness check-types` |
| **WP3 — coder harness** | `createCoderHarness`: claude-code/hermes branch, model/effort defaults, render `CoderContext` (stack/conventions/gate cmds) into spawn prompt. | `src/harnesses/coder.ts`, `src/context.ts` | unit test: args snapshot for both engines (`vitest run`) |
| **WP4 — researcher harness** | `createResearcherHarness`: hermes + GLM default, attach `searchMcp` to `mcpServers`, inject structured-output instruction + default schema. | `src/harnesses/researcher.ts` | unit test: `mcpServers` + schema present in args |
| **WP5 — supervisor harness** | `createSupervisorHarness`: `orchestrator` wiring, render `WorkPackage[]` brief, `subtree()` + `waitForAnyChild()` helpers. | `src/harnesses/supervisor.ts`, `src/wp.ts` | unit test: `orchestrator` set + WP brief rendered |
| **WP6 — model-routing verify + README** | Verify the real OpenRouter slugs for deepseek-v4-pro / glm-5.2 against a live hermes; lock preset defaults; write `README.md` with the three quick-starts. | `src/harnesses/*.ts` (defaults), `README.md` | `pnpm --filter @agentproto/harness build` green + README quick-starts run |

> Tests use `vitest` with a **mocked `HarnessClient`** (assert the args handed to
> `agent_start`) — no live daemon required for WP3–WP5. WP6 is the only
> one needing a running daemon/hermes.

---

## 4. Package scaffolding (created in this phase)

Mirrors the canonical leaf-package conventions (`@agentproto/ref`,
`@agentproto/adapter-kit`): ESM-only, `tsup` build via the shared factory,
tsconfig extends `@agentproto/tooling/typescript/node-library.json`, exports map
of `dist/*.mjs` + `dist/*.d.ts`.

```
packages/harness/
  package.json          # @agentproto/harness, peer: @modelcontextprotocol/sdk, zod
  tsconfig.json         # extends @agentproto/tooling/typescript/node-library.json
  tsup.config.ts        # createTsupConfig, esm, dts
  src/
    index.ts            # barrel: connectHarness + create*Harness + types
    types.ts            # AgentHandle, TurnResult, StartArgs, *Opts, WorkPackage
    client.ts           # HarnessClient stub (WP1)
    handle.ts           # makeHandle stub (WP2)
    harnesses/
      coder.ts          # createCoderHarness stub (WP3)
      researcher.ts     # createResearcherHarness stub (WP4)
      supervisor.ts     # createSupervisorHarness stub (WP5)
```

Dependency direction respected: `@agentproto/harness` depends only on
`@modelcontextprotocol/sdk` + `zod` (peer) — it talks to the daemon over the
wire and imports **no** `@agentproto/runtime` internals, so it stays a clean leaf
with no upward coupling.
