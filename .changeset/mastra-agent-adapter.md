---
"@agentproto/adapter-mastra-agent": minor
"@agentproto/cli": patch
---

Add `@agentproto/adapter-mastra-agent` — the first-party agentproto agent.

Unlike codex/hermes/claude-code (which wrap an external agent CLI), this adapter
IS the agent: an AIP-42 `AGENT.md` is run as a live Mastra agent behind an
AIP-44 ACP server, served over stdio. It is spawnable by the daemon as the
`mastra-agent` arm AND launchable standalone via the `agentproto-mastra acp`
bin — our own loop, our own models (any Mastra-routable `provider/model` id,
resolved from the spawn env), no third-party CLI in the loop. Registered in the
CLI catalog + devDeps like the other in-repo adapters.
