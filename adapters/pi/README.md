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

## MCP support — bridged into pi tools

Pi ships **no native MCP client** — but this adapter closes that gap. When the
host injects `mcpServers` into `connect()` (the daemon's orchestration gateway,
or any scoped toolset), the adapter **bridges** them into pi by exploiting pi's
own TypeScript **extension** system:

1. At `connect()`, it enumerates each server's tools (`tools/list`), writes a
   per-session config JSON, and spawns pi with `-e <mcp-bridge-extension.mjs>`
   plus `PI_MCP_BRIDGE_CONFIG`.
2. The bundled extension registers **one pi tool per MCP tool** (namespaced
   `mcp__<server>__<tool>`); each tool's `execute` proxies the call to the MCP
   server over `@modelcontextprotocol/sdk`.

Net result: pi gains agentproto's full injected toolset, **including
`agent_start`** when the daemon injects its gateway (`--orchestrator` flag),
enabling sub-agent orchestration (`capabilities.sub_agents: true`). When no
MCP servers are injected, behavior is unchanged (pi runs only its own
built-in file/shell tools). Full mechanism, limitations, and caveats
(image/binary-content, cancellation): [`MCP-BRIDGE.md`](./MCP-BRIDGE.md).

## What it is

Because pi has no native ACP/MCP protocol surface, this is a
`protocol: "proprietary"` manifest:
`createAgentCliRuntime` skips the built-in ACP/print subprocess plumbing and
instead dynamic-imports this package's `createAgentCliClient(definition)`
factory (see `createProprietaryProtocolArm` in `@agentproto/driver-agent-cli`).
Unlike `@agentproto/adapter-mastracode-inprocess` (the in-process proprietary
arm), **this arm spawns a real child** (`pi --mode rpc`) and translates pi's
RPC event stream into the canonical `StreamEvent` taxonomy.

- **Multi-provider** — Anthropic, OpenAI, Google (Gemini), Moonshot AI, OpenRouter. One
  provider key minimum. See [`SECRETS.md`](./SECRETS.md).
- **Streaming** — text + thinking deltas, tool-call/result lifecycle.
- **Live duplex** — pi's RPC mode supports `steer` / `follow_up` / `abort`
  mid-turn (`capabilities.bidirectional: true`).
- **Resumable** — pi persists sessions; the client captures pi's session id
  from `get_state` and reattaches via `--session <id>`
  (`continuation.default: "native-resume"`).

## Configuration

| Option   | Type   | Notes |
| -------- | ------ | ----- |
| `model`  | string | Passed to pi's `--model` (accepts `provider/id`, e.g. `anthropic/claude-sonnet-4-5`, `moonshotai/kimi-k2.7-code`, `openrouter/deepseek/deepseek-v4.1-flash`). |
| `effort` | enum   | Thinking level, mapped 1:1 to pi's `set_thinking_level`: `off \| minimal \| low \| medium \| high \| xhigh`. |

The pi binary is resolved from `definition.bin` (`pi`), overridable via the
`AGENTPROTO_PI_BIN` env var (used by the gated smoke test to point at a local
install without a global `pi` on PATH).

## OpenRouter models

`models.allowed` advertises the OpenRouter catalog as literal 3-segment ids
(`openrouter/<vendor>/<product>` — e.g. `openrouter/deepseek/deepseek-v4.1-flash`,
`openrouter/z-ai/glm-5.3-flash`), matching pi's own `--model` resolver
(verified live: `pi --model openrouter/deepseek/deepseek-v4.1-flash` resolves
and bills correctly with an `OPENROUTER_API_KEY`-backed access profile). This
closed a real gap: `agentproto models pi` / `catalog_models` used to show only
Anthropic/OpenAI/Google/Moonshot even though the route worked when named
explicitly.

```sh
agentproto sessions start pi \
  --model openrouter/deepseek/deepseek-v4.1-flash \
  --access-profile openrouter-dev-local
```

## Lean review mode

`--mode lean` is an opt-in, READ-ONLY session shape for a cheap editorial pass
— e.g. reviewing a text excerpt without needing to edit files or run shell
commands. It passes pi's own:

```
--tools read --no-context-files --no-skills --no-extensions
```

- `--tools read` restricts pi to its `read` built-in only (drops `bash` /
  `edit` / `write`) — **deliberately not `--no-tools`**. The daemon's own
  AGENTS.md injection (`session-spawn.ts`) is a full inline copy only under
  its configured size cap (default 8KB); a repo whose AGENTS.md is bigger than
  that gets a **pointer** sentence naming the path instead of the content. A
  fully tool-less session would have no way to act on "read it before your
  first tool call" — keeping `read` enabled means that instruction stays
  actionable regardless of the target repo's AGENTS.md size. **A pointer is a
  path, not the file's content — never assume lean mode delivers the full
  text without a `read` tool to fetch it.**
- `--no-context-files` disables pi's own native AGENTS.md/CLAUDE.md
  auto-discovery — its own, separate, uncontrolled duplicate of what the
  daemon already injects into the prompt. This does NOT affect the daemon's
  own AGENTS.md injection, which happens regardless of mode.
- `--no-skills --no-extensions` drop pi's own skill/prompt-template/extension
  discovery. Any host-injected `mcpServers` are skipped outright (no
  MCP-bridge enumeration) rather than bridged only to sit behind a tool
  allowlist that excludes them.

Default (no `--mode`) sessions are completely unaffected — this is additive,
opt-in behavior.

### Exact invocation

```sh
agentproto sessions start pi \
  --mode lean \
  --model openrouter/z-ai/glm-5.3-flash \
  --access-profile openrouter-dev-local \
  --prompt "$(cat review-prompt.md)"
```

or via the `agent_start` MCP tool: `{ adapter: "pi", mode: "lean", model:
"openrouter/z-ai/glm-5.3-flash", access: { profileRef: "openrouter-dev-local" }, prompt: "..." }`.

**When NOT to use it:** any session that needs to edit files, run commands, or
use bridged MCP tools — lean is read-only by construction. If the target
repo's AGENTS.md carries instructions that require tools beyond reading a
file (rare, but possible for an unusually prescriptive AGENTS.md), lean mode
cannot satisfy them; use the default mode instead.

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
