# @agentproto/runtime

The long-running gateway that turns an agentproto workspace into a live runtime. Composes the MCP server (CRUD verbs), HTTP transport, HEARTBEAT.md autonomy loop, conversation persistence, and the **sessions registry** (agent CLIs, raw spawns, and real PTY-backed terminals).

Used directly by [`@agentproto/cli`](../cli/README.md)'s `agentproto serve` verb. Also embeddable when you want to host the same surface inside another Node process (the playground gateway, app-specific deployments, etc.).

```bash
npm install @agentproto/runtime
```

## Quick start

If you just want a daemon, use the CLI — `agentproto serve` wires this package end-to-end with adapter resolution, PTY support, and tunnel reconnect logic. The docs below cover the **embedding** path.

```ts
import { createGateway } from "@agentproto/runtime"
import { loadNodePtyFactory } from "@agentproto/cli/util/pty-factory" // optional

const gateway = await createGateway({
  workspace: "/abs/path/to/workspace",
  specs: [],                                  // AIP doctype specs (optional)
  port: 18790,
  // Optional: enable POST /sessions/terminal + WS /sessions/:id/pty
  spawnPty: await loadNodePtyFactory() ?? undefined,
  // Optional: enable POST /sessions/agent + agent_start MCP tool
  resolveAgentAdapter: async slug => { /* return AgentAdapter or null */ },
  listAgentAdapters: async () => [ /* AdapterInfo[] */ ],
})
console.log("gateway up at", gateway.url)
// ... later
await gateway.stop()
```

A per-boot bearer token is generated automatically and written into `<workspace>/.agentproto/runtime.json` (mode `0600`). Override with `createGateway({ token })` if you have your own.

## What the gateway exposes

| Surface           | URL                                      | Notes                                                  |
|-------------------|------------------------------------------|--------------------------------------------------------|
| Health            | `GET /health`                            | Daemon status: workspace, uptime, `startedAt`, version, build identity (`sha`, `builtAt`, `source`), pid, node path, entry point — always public                     |
| Events (SSE)      | `GET /events`                            | RuntimeEvents stream                                   |
| MCP               | `POST /mcp` (Streamable HTTP)            | Stateless mode; per-request transport                  |
| Conversations     | `GET /conversations` / `GET /conversations/<id>` | Markdown bodies                                |
| Adapter discovery | `GET /adapters` / `POST /adapters/:slug/install` | When `listAgentAdapters` / `installAgentAdapter` is wired |
| App scope mounts   | `POST /apps/:appId/apply` / `DELETE /apps/:appId/apply` / `GET /scopes/:scopeId/apps` | Mirrors MCP `app_apply` / `app_unapply` / `app_list_applied`; needs `appRegistry` |
| Sessions list     | `GET /sessions` / `GET /sessions/:id` / `GET /sessions/summaries` | id-or-name in `:id`; summaries are lightweight + paginated |
| Agent spawn       | `POST /sessions/agent`                   | Long-lived ACP agent (needs `resolveAgentAdapter`)    |
| Interrupt turn    | `POST /sessions/:id/interrupt`           | Cancel the in-flight turn; session stays alive        |
| Terminal input    | `POST /sessions/:id/terminal/input`      | Write raw input into a live PTY session               |
| Rename session    | `PATCH /sessions/:id`                    | Set or clear the session's user-facing `title`/`label`|
| **PTY spawn**     | **`POST /sessions/terminal`**            | Needs `spawnPty` factory                              |
| **PTY attach**    | **`WS /sessions/:id/pty`**               | JSON frames `{kind:data|input|resize|exit|ping|pong}`; multi-subscriber, min-size resize, ring-buffer replay |
| SSE attach        | `GET /sessions/:id/stream`               | Line-by-line text events                              |
| **Chat stream**   | `POST /sessions/:id/chat`                | Send a follow-up prompt + fan RAW transcript into the `ai` v6 UI message stream |
| **Chat (create)** | `POST /sessions/chat`                    | Spawn a session + stream its first turn as chat (needs `resolveAgentAdapter`) |
| Kill / forget / gc | `POST /sessions/:id/kill`, `DELETE /sessions/:id`, `POST /sessions/gc` | SIGTERM, drop from registry, bulk archive terminal sessions |

### MCP tool surface

The `/mcp` endpoint exposes the core toolset plus several opt-in / feature-gated families:

| Tool family | Notes |
|-------------|-------|
| `agent_start` / `agent_prompt` / `agent_output` / `agent_kill` / `agent_interrupt` | Long-lived ACP agent lifecycle |
| `terminal_start` / `terminal_input` / `terminal_output` / `terminal_kill` | Raw PTY sessions |
| `session_list` / `session_tree` / `session_usage` / `session_restart` / `session_rename` | Session management |
| `app_install` / `app_run` / `app_list` / `app_status` / `app_stop` / `app_apply` / `app_unapply` / `app_list_applied` | App-kit apps |
| `app_data_read` / `app_data_write` / `app_data_list` / `app_data_migrate` | App-scoped durable data plane, anchored at the app's `dataDir` (default `<dir>/data`; `app_install {dataDir}`) |
| `harness_preset_list` / `harness_preset_create` / `harness_preset_delete` / `harness_preset_set_default` | Persisted harness→auth-profile presets (new) |
| `workspace_brain_query` / `workspace_brain_status` / `workspace_brain_ingest` | Per-workspace transcript recall (new) |
| `conversation_export` | Export a daemon transcript to a target adapter's native store, e.g. `claude-code` (new) |
| `llm_endpoint_*` (`start`, `stop`, `status`, `set_upstream_link`, `list_links`) | Local LLM Endpoint proxy sidecar — only when `features.llmEndpoint` is enabled (new) |

### Auth model

- `Authorization: Bearer <token>` required on **mutating** `/sessions/*` routes (POST/PATCH/DELETE) and the PTY WS upgrade.
- **No loopback bypass** for those routes — the threat being defended against is a browser fetch from a localhost-loaded page, which IS loopback. A browser can't read `runtime.json` (mode 0600); a same-user process can.
- Read routes (`GET /sessions`, SSE `/stream`) stay open for read-only telemetry compatibility.
- The optional `auth?: AuthOptions` field on `createGateway` is for the *tunnel* bearer (Cloudflare-fronted public surface), independent of the per-boot token. It gates `/mcp`, `/events`, `/conversations*`, and the heartbeat tick route, with a loopback bypass for requests that never crossed a tunnel (127.0.0.1/::1 with no `X-Forwarded-For`).
- `agentproto serve` wires this from `daemon.authToken` in `~/.agentproto/config.json` (or `--auth-token`) when set, so the gateway can boot already gated with a stable token — no `remote_enable` call, and it survives restarts since it isn't held in memory. `RemoteController`'s `remote_enable` MCP tool is a separate, complementary mechanism: it always mints a fresh in-memory token and opens a Cloudflare quick tunnel, and takes precedence over `daemon.authToken` while active.

## Worktree isolation policy

`agent_start.worktree` isolation is decided by `worktrees.isolation` in
`~/.agentproto/config.json` (or the `AGENTPROTO_WORKTREES_ISOLATION` env,
which wins). Three modes — see `WorktreeIsolationMode` in
[`config.ts`](./src/config.ts) and the decision matrix in
[`worktree-isolation.ts`](./src/worktree-isolation.ts):

- `"on-request"` (default) — isolates only when the caller explicitly passes
  `worktree`.
- `"always"` — every **root** (depth-0) spawn is provisioned into a fresh
  `<worktrees.root>/<repo>/<slug>` worktree on branch `wt/<slug>` cut from
  `origin/main`, whether or not the caller asked. A `cwd` outside any git
  repo has nothing to isolate, so it spawns plain.
- `"never"` — isolation is off; an explicit `worktree` request is rejected
  loudly rather than silently ignored.

**Depth-0 only.** A spawn made *through* an orchestrator's scoped sub-gateway
(depth > 0 — including any `agent_start` a supervisor session issues itself,
even with `attach: false`) always inherits its parent's working tree; the
`always` policy never provisions a second worktree for it, and an explicit
`worktree` request at depth > 0 is rejected (use `sandbox` for child
isolation instead). To exercise `always` end-to-end you need a genuine root
spawn — e.g. `agentproto sessions start <adapter> --cwd <repo>` from a shell,
not an `agent_start` call made from inside another session.

**Config key gotcha:** the field is nested — `{"worktrees": {"isolation":
"always"}}` — NOT a top-level `worktreeIsolation` key. The loader
(`loadWorktreeIsolation` / `loadConfig`) silently ignores unknown top-level
keys, so a hand-edit that adds `worktreeIsolation` at the top level parses
fine, `agentproto config show` will happily print it back, and the policy
still silently resolves to the `"on-request"` default — no error, no spawn
behaviour change. Verify with `agentproto sessions --json` after a root spawn
and check the descriptor for `worktreePath`/`worktreeId`, not just the config
file's contents. Config is re-read from disk on every spawn (no caching), so
a fix to the key takes effect on the next `agent_start`/`sessions start` —
no daemon restart needed.

## SessionsRegistry

Exposed via `gateway.sessions`. Useful when you want to register externally-spawned children (e.g. tunnel-driven spawns) or programmatically attach without going through HTTP.

```ts
gateway.sessions.spawnPty({
  argv: ["bash", "-l"],
  cwd: gateway.workspace,
  workspaceSlug: "default",
  cols: 120,
  rows: 40,
  name: "ops-shell",
})

const handle = gateway.sessions.attachPty(
  "ops-shell",
  { cols: 120, rows: 40 },
  (chunk) => process.stdout.write(chunk),
  (evt) => console.log("exited", evt.exitCode),
)
handle?.write("uptime\n")
handle?.resize(80, 24)
handle?.detach()
```

Other methods: `spawn` (raw `child_process.spawn`), `spawnAgent` (ACP), `register` (adopt an external `ChildProcess`), `attach` (SSE-style line subscription), `kill`, `forget`, `findByIdOrName`, `writeTerminalInput`, `readTerminalOutput`, `shutdown`. See [`sessions.ts`](./src/sessions.ts) for the typed surface.

## Chat routes — `POST /sessions/:id/chat` and `POST /sessions/chat`

The chat routes turn a daemon session into an AI-SDK v6 "UI message stream": they enqueue a user prompt on the session and fan the daemon's RAW transcript records (`events.jsonl`, the shapes `@agentproto/transcript-fixtures` documents) into a stream of `UIMessageChunk` objects — the protocol `ai`'s `createUIMessageStreamResponse` emits (`data: <JSON chunk>\n\n` SSE frames + `x-vercel-ai-ui-message-stream: v1`). The mapping is the pure `createTranscriptToUiMapper(sessionId)` from [`chat-stream.ts`](./src/chat-stream.ts); the background replay + live subscribe use the same `deliverRecordsExactlyOnce` machinery as `/sessions/:id/events/stream`, so a client sees no duplicate and no hole.

### Route contract

**`POST /sessions/:id/chat`** — enqueue a follow-up turn on an EXISTING session and stream its output.

- Method / path: `POST /sessions/:id/chat` (id-or-name, like `/sessions/:id/events`).
- Body (JSON): `{ "prompt": string, "interrupt"?: boolean, "source"?: string }`. `prompt` (non-empty) is required; `interrupt: true` cancels a mid-turn and redirects the same session (mirrors the MCP `agent_prompt` tool); `source` overrides the recorded provenance (default `http:chat`).
- Response: 200 with `Content-Type: text/event-stream`, header `x-vercel-ai-ui-message-stream: v1`, body a sequence of `data: <UIMessageChunk JSON>` frames ending in `data: [DONE]`. Adverse outcomes fail before any stream byte: `400` for a missing/invalid `prompt`, `404` for an unresolvable session, `409 {error:"session_not_alive"}` for a dead session, `409 {error:"prompt_rejected"}` when a busy session refused the prompt without `interrupt` (this is exactly the admission error `enqueuePrompt` throws).

**`POST /sessions/chat`** — create-and-chat variant. It REUSES the exact `/sessions/agent` spawn core: the same `spawnAgentSession` function and the same shared body→args mapper (`buildSpawnSessionHttpArgs`, kept in `http-server.ts` so the two surfaces can't drift from each other or from the MCP `agent_start` tool). Body is the `/sessions/agent` spawn fields (e.g. `adapter`, `cwd`, `workspaceSlug`, `orchestrator`, …) **plus a required `prompt`** (the opening user message). On success it does NOT return a 201 descriptor like `/sessions/agent` — it immediately bleeds the session's first turn into the chat stream above. Requires the host-injected `resolveAgentAdapter` (otherwise `501`).

Why not a second, lighter spawn path? Because the spawn surface (orchestrator / mcpServers / worktree / access / presets / …) is genuinely large and already validated in one place; duplicating a slice of it here would create two divergent spawn contracts. Sharing `spawnAgentSession` + `buildSpawnSessionHttpArgs` means `/sessions/chat` inherits every fix to either by construction. The cost is that `/sessions/chat` accepts the same (wide) body as `/sessions/agent`; callers wanting a minimal contract should use `/sessions/agent` (to create) then `/sessions/:id/chat` (to stream follow-ups).

### Record → `UIMessageChunk` mapping

Replayed in `seq` order, each RAW record maps as follows (see `chat-stream.ts` for the authoritative switch, under conformance test):

| RAW kind | Emitted chunk(s) |
|---|---|
| `user-prompt` | none (echo of the user's input, not assistant output) |
| `thought` | `reasoning-start` (once per run) + `reasoning-delta` (per fragment) + `reasoning-end` at the segment boundary |
| `text-delta` | `text-start` (once per run) + `text-delta` (per fragment) + `text-end` at the boundary |
| `tool-call` | `tool-input-available {toolCallId, toolName, input: arguments}` (`isUpdate` re-emits with the fresh snapshot) |
| `tool-result` | `tool-output-available {toolCallId, output: result}` (RAW `result`, unwrapped) — or `tool-output-error {toolCallId, errorText}` when `isError` |
| `tool-call-record` | none — DELIBERATE skip (bookkeeping that duplicates `tool-call` + `tool-result`) |
| `permission-resolved` | custom data part `data-tool-call-approval` (CONDITION 4, below) |
| `turn-end` | `finish` (`finishReason: "stop"` for `reason: "turn-complete"`; omitted when nothing maps cleanly) |
| any other kind | `{type:"error", errorText:"unhandled transcript record kind: <kind>"}` + a server-side `console.error` (CONDITION 2 — never a silent swallow) |

### Custom data part: `data-tool-call-approval`

A resolved permission decision (`permission-resolved` records) travels as a custom data part:

```json
{"type":"data-tool-call-approval","data":{"toolCallId":"call_fixture_01","decision":"allow","optionId":"once"}}
```

We use a `data-*` custom part rather than the `ai` v6 native `tool-approval-request` chunk (which has `approvalId`/`signature`) because the latter models a PENDING approval request (before execution), whereas our transcript only ever contains the already-RESOLVED final decision (`permission-resolved`). The `tool-call-approval` name is aligned with Mastra's `tool-call-approval` vocabulary for future consistency, not with the native chunk, which does not match our data. The generic data-part type in `ai` v6 is `DataUIMessageChunk` = `{ type: \`data-${NAME}\`, id?, data, transient? }`, so `data-tool-call-approval` is a first-class protocol citizen.

### Known gap — pending approval requests do NOT flow through this route yet

Only `permission-resolved` (the final decision) transits the chat stream today. PENDING permission requests (the same class of thing `ai` models as `tool-approval-request`, and Mastra as `tool-call-approval`) are **not** yet surfaced by this route — there is no per-turn "request is waiting for a human" event in this stream. That is a known gap, out of scope for this work package, not an oversight; closing it (emitting a pending-approval data part when the daemon holds on a permission) is future work.

## License

MIT — see [LICENSE](../../LICENSE).
