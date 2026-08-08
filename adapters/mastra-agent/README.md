# @agentproto/adapter-mastra-agent

The **first-party agentproto agent**. Every other adapter
(`codex`, `hermes`, `claude-code`, `opencode`) wraps an *external* agent CLI.
This one is ours end to end: an AIP-42 `AGENT.md` is run as a live
[Mastra](https://mastra.ai) agent behind an AIP-44 ACP server — our loop, our
models, no third-party CLI.

```bash
# Standalone — drive it from any ACP-speaking host over stdio:
agentproto-mastra acp --model anthropic/claude-opus-4-8

# Or let the agentproto daemon spawn it like any other arm:
#   agent_start({ adapter: "mastra-agent", model: "openrouter/z-ai/glm-5.2" })
```

## How it works

```
AGENT.md ──parseAgentManifest──▶ AgentHandle
                                     │ buildMastraAgent (@agentproto/mastra)
                                     ▼
                              Mastra Agent.stream()
                                     │ text deltas
                                     ▼
          MastraAcpAgent (src/acp-host.ts)  ──agent_message_chunk──▶ ACP client
                                     ▲
                       @agentclientprotocol/sdk AgentSideConnection (stdio)
```

- **Model** — any `provider/model` string Mastra's gateway can route
  (`anthropic/…`, `openrouter/…`, `openai/…`). The provider key is read from the
  spawn environment. Default: `openrouter/z-ai/glm-5.2`.
- **Agent** — pass `--agent ./path/AGENT.md` (or `AGENTPROTO_MASTRA_AGENT_FILE`)
  to run a custom agent; omit for a built-in coding default.

## Workspace tools

The default agent is granted a workspace toolset, all **confined to the session
cwd** (path-traversal guarded):

| Tool | Does |
| --- | --- |
| `list_dir` | List a directory. |
| `read_file` | Read a UTF-8 file. |
| `write_file` | Create/overwrite a file (mkdir -p). |
| `edit_file` | Replace a unique substring. |
| `run_command` | Run a shell command (cwd-scoped, timeout). |
| `read_diff` | Show `git diff` against HEAD (or a base ref), optionally scoped to paths. |
| `apply_patch` | Apply a unified diff to workspace files (`git apply`). |
| `run_tests` | Run the workspace test command (default `npm test`, overrideable). |

> **Note:** `read_file` and `write_file` here are Mastra-native workspace tools
> scoped to this adapter's session cwd. They are distinct from the runtime MCP
> filesystem tools (`file_read`, `file_write`) registered on the daemon's `/mcp`
> endpoint.

`run_command`, `read_diff`, `apply_patch`, and `run_tests` are gated by `allowExec`
(default `true`); set `AGENTPROTO_MASTRA_NO_EXEC=1` to withhold them. Embedding hosts
can also pass `extraTools` to merge additional tools over the built-in set (extra wins
on id collision).

## Memory

Per-conversation memory via Mastra's LibSQL (SQLite) store. Each ACP session is
a memory **thread**, so the agent recalls earlier turns within a session. The db
is a single SQLite file under `~/.agentproto/mastra-agent/memory.db` (persistent
across spawns), overridable with `AGENTPROTO_MASTRA_MEMORY_DB`. A custom
`AGENT.md` tunes it via the `memory:` block (`scope`, `retention_turns`).

## Status

Streaming conversation + workspace tools (edit/run) + SQLite memory, with tool
activity surfaced live: each tool the agent runs is relayed to the host as an
ACP `tool_call` (status `in_progress`) and then a `tool_call_update` (status
`completed`/`failed` with the raw output) — read off Mastra's `fullStream` and
mapped in `src/tool-call-map.ts`. So a host (codex/claude-code/an IDE) shows the
"🔧 run_command: …" feed, not just the final prose.
