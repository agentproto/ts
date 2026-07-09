# @agentproto/adapter-pi

AIP-45 AGENT-CLI adapter for **[earendil-works/pi](https://github.com/earendil-works/pi)**
(`@earendil-works/pi-coding-agent`) — an MIT, headless TypeScript coding
agent. This adapter drives pi over its **persistent JSON-over-stdio RPC mode**
(`pi --mode rpc`), spawned as a real child process.

```ts
import { pi, piRuntime } from "@agentproto/adapter-pi"

const session = await piRuntime().start()
for await (const evt of session.send({ role: "user", content: "list the files" })) {
  console.log(evt.kind)
}
await session.close()
```

## ⚠️ KEY LIMITATION — pi has no MCP support

Pi ships **neither ACP nor MCP**. That makes two things true, and they are the
single most important thing to know before choosing this adapter:

1. **Injected MCP tools are ignored.** The proprietary arm's `connect()`
   receives `mcpServers` (the host may try to mount the daemon's own
   orchestration gateway, or any scoped toolset). Pi **cannot** mount them.
   This adapter does **not** silently drop the request — it logs a one-time
   warning. The agentproto substrate toolset is unavailable; pi runs **only
   its own built-in file/shell tools** (read, write, edit, bash, …).
2. **No sub-agent orchestration.** Because the orchestration gateway can't be
   mounted, a pi session cannot itself spawn + supervise sub-agents
   (`capabilities.sub_agents: false`).

If your workflow depends on the agentproto MCP substrate (custom tools,
nested orchestration, corpus/knowledge tools), pick an ACP adapter
(`claude-code`, `opencode`, `hermes`, …) instead. Pi is the right choice when
you want pi's own agent loop + built-in tooling as the execution surface.

## What it is

Because pi has no ACP/MCP, this is a `protocol: "proprietary"` manifest:
`createAgentCliRuntime` skips the built-in ACP/print subprocess plumbing and
instead dynamic-imports this package's `createAgentCliClient(definition)`
factory (see `createProprietaryProtocolArm` in `@agentproto/driver-agent-cli`).
Unlike `@agentproto/adapter-mastracode-inprocess` (the in-process proprietary
arm), **this arm spawns a real child** (`pi --mode rpc`) and translates pi's
RPC event stream into the canonical `StreamEvent` taxonomy.

- **Multi-provider** — Anthropic, OpenAI, Google (Gemini). One provider key
  minimum. See [`SECRETS.md`](./SECRETS.md).
- **Streaming** — text + thinking deltas, tool-call/result lifecycle.
- **Live duplex** — pi's RPC mode supports `steer` / `follow_up` / `abort`
  mid-turn (`capabilities.bidirectional: true`).
- **Resumable** — pi persists sessions; the client captures pi's session id
  from `get_state` and reattaches via `--session <id>`
  (`continuation.default: "native-resume"`).

## Configuration

| Option   | Type   | Notes |
| -------- | ------ | ----- |
| `model`  | string | Passed to pi's `--model` (accepts `provider/id`, e.g. `anthropic/claude-sonnet-4-5`). |
| `effort` | enum   | Thinking level, mapped 1:1 to pi's `set_thinking_level`: `off \| minimal \| low \| medium \| high \| xhigh`. |

The pi binary is resolved from `definition.bin` (`pi`), overridable via the
`AGENTPROTO_PI_BIN` env var (used by the gated smoke test to point at a local
install without a global `pi` on PATH).

## Safety

Pi has **no built-in permission system** — file, process, network and
credential access run with the launching user's permissions, and non-interactive
modes (including `--mode rpc`) show no trust prompt. Treat a pi session as
arbitrary code execution. See [`SANDBOX.md`](./SANDBOX.md).

## Docs in this package

- [`PI.md`](./PI.md) — AIP-45 manifest overview.
- [`PI-RPC.md`](./PI-RPC.md) — the reverse-engineered RPC wire profile + the
  pi-event → `StreamEvent` mapping table.
- [`SECRETS.md`](./SECRETS.md) — provider env slots.
- [`SANDBOX.md`](./SANDBOX.md) — no built-in permissions; containerization.

Built against pi **0.80.3**. The event/command wire profile was
reverse-engineered from pi source (`packages/coding-agent/src/modes/rpc/*` +
`core/agent-session.ts`); see `PI-RPC.md`.
