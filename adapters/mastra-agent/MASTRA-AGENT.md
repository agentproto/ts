# MASTRA-AGENT.md

AIP-45 manifest companion for `@agentproto/adapter-mastra-agent` — the
first-party agentproto agent. See `src/index.ts` for the authoritative
`defineAgentCli` handle.

Unlike the other adapters, this package does not wrap an external agent CLI:
it **is** the agent. An AIP-42 `AGENT.md` is parsed (`@agentproto/agent`), built
into a live Mastra agent (`@agentproto/mastra`), and served over AIP-44 ACP.

- **bin:** `node <dist>/cli.mjs acp` (self-locating) — also published as the
  `agentproto-mastra` bin.
- **protocol:** `acp` (stdio JSON-RPC).
- **models:** any Mastra-routable `provider/model` id; default
  `openrouter/z-ai/glm-5.2`. Provider key comes from the spawn env.
- **session:** persistent, 30-min idle timeout, context carryover.
