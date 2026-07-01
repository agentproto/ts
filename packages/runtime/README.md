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
| Health            | `GET /health`                            | Workspace + uptime — always public                     |
| Events (SSE)      | `GET /events`                            | RuntimeEvents stream                                   |
| MCP               | `POST /mcp` (Streamable HTTP)            | Stateless mode; per-request transport                  |
| Conversations     | `GET /conversations` / `GET /conversations/<id>` | Markdown bodies                                |
| Adapter discovery | `GET /adapters`                          | When `listAgentAdapters` is wired                      |
| Sessions list     | `GET /sessions` / `GET /sessions/:id`    | id-or-name in `:id`                                   |
| Agent spawn       | `POST /sessions/agent`                   | Long-lived ACP agent (needs `resolveAgentAdapter`)    |
| **PTY spawn**     | **`POST /sessions/terminal`**            | Needs `spawnPty` factory                              |
| **PTY attach**    | **`WS /sessions/:id/pty`**               | JSON frames `{kind:data|input|resize|exit|ping|pong}`; multi-subscriber, min-size resize, ring-buffer replay |
| SSE attach        | `GET /sessions/:id/stream`               | Line-by-line text events                              |
| Kill / forget     | `POST /sessions/:id/kill`, `DELETE /sessions/:id` | SIGTERM, then drop from registry             |

### Auth model

- `Authorization: Bearer <token>` required on **mutating** `/sessions/*` routes (POST/DELETE) and the PTY WS upgrade.
- **No loopback bypass** for those routes — the threat being defended against is a browser fetch from a localhost-loaded page, which IS loopback. A browser can't read `runtime.json` (mode 0600); a same-user process can.
- Read routes (`GET /sessions`, SSE `/stream`) stay open for read-only telemetry compatibility.
- The optional `auth?: AuthOptions` field on `createGateway` is for the *tunnel* bearer (Cloudflare-fronted public surface), independent of the per-boot token.

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

## License

MIT — see [LICENSE](../../LICENSE).
