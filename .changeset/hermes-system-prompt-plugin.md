---
"@agentproto/adapter-hermes": minor
"@agentproto/cli": minor
---

feat(adapter-hermes): system-prompt channel via an agentproto hermes plugin — ships a bundled `agentproto-system-prompt` hermes plugin (reads `AGENTPROTO_SYSTEM_PROMPT_FILE`, registers cache-safe sections at `after_memory`, frozen at session start), `hermesSystemPromptPluginStatus`/`installHermesSystemPromptPlugin` helpers, and `agentproto adapters hermes-plugin status|install [--enable] [--json]` (enable = explicit consent via `hermes plugins enable`). Delivery budget `MAX_HERMES_SYSTEM_PROMPT_CHARS` = 7500.
