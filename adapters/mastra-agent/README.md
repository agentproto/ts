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
#   start_agent_session({ adapter: "mastra-agent", model: "openrouter/z-ai/glm-5.2" })
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

`run_command` is on by default; set `AGENTPROTO_MASTRA_NO_EXEC=1` to withhold it.

## Memory

Per-conversation memory via Mastra's LibSQL (SQLite) store. Each ACP session is
a memory **thread**, so the agent recalls earlier turns within a session. The db
is a single SQLite file under `~/.agentproto/mastra-agent/memory.db` (persistent
across spawns), overridable with `AGENTPROTO_MASTRA_MEMORY_DB`. A custom
`AGENT.md` tunes it via the `memory:` block (`scope`, `retention_turns`).

## Status

Streaming conversation + workspace tools (edit/run) + SQLite memory. Tool calls
execute inside Mastra but aren't yet relayed as ACP `tool_call` updates (the
final answer streams back) — that surfacing is the next increment.
