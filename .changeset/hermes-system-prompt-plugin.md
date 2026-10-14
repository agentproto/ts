---
"@agentproto/adapter-hermes": minor
"@agentproto/cli": minor
"@agentproto/driver-agent-cli": minor
"@agentproto/runtime": minor
---

feat(adapter-hermes): system-prompt channel via an agentproto hermes plugin — ships a bundled `agentproto-system-prompt` hermes plugin (reads `AGENTPROTO_SYSTEM_PROMPT_FILE`, registers cache-safe sections at `after_memory`, frozen at session start), `hermesSystemPromptPluginStatus`/`installHermesSystemPromptPlugin` helpers, and `agentproto adapters hermes-plugin status|install [--enable] [--json]` (enable = explicit consent via `hermes plugins enable`). Delivery budget `MAX_HERMES_SYSTEM_PROMPT_CHARS` = 7500. The driver gains the `env-file` `systemPrompt` channel (writes `<session config dir>/agentproto-system-prompt.md`, a private temp dir when none, removed on close; points the declared env var at it), and the runtime wires it end to end: the hermes resolver entry sets `supportsSystemPrompt` only while the plugin is installed AND enabled (checked per spawn), `systemPromptMaxChars`/`systemPromptUnavailable` degrade an over-limit or unavailable channel to a first-prompt prefix + a warning naming the limit or the install command (session-spawn, workflow agent host, restart, and agent projection).
