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
  to run a custom agent; omit for a built-in conversational default.

## Status

First cut: conversational streaming. Tools declared in a custom `AGENT.md` run
inside Mastra but are not yet relayed as ACP `tool_call` updates — that's the
next increment.
