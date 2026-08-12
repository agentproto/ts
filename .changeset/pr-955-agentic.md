---
"@agentproto/cli": patch
"@agentproto/driver-agent-cli": minor
"@agentproto/runtime": minor
---

Persistent per-session isolated adapter config directories to enable native resume after adapter respawns.

Previously, the isolated `CLAUDE_CONFIG_DIR` was a throwaway mkdtemp recreated on every spawn. This meant the SDK's conversation store (projects/<cwd-slug>/<uuid>.jsonl) was lost on respawn, causing resumeSessionId to degrade to a digest fallback every time an adapter process was reaped and restarted.

The fix introduces `SessionDescriptor.adapterConfigDir` to persist the config location across respawns, keyed by the first session id in a lineage (`~/.agentproto/adapter-config/<sessionId>`). The runtime threads this through all spawn paths (agent_start, session_restart, lazy resume, cron, judges, webhooks, workflow steps), and the driver preserves the SDK's own state when reusing a persistent dir while always re-asserting `mcpServers: {}` to prevent ambient leaks from mid-session `claude mcp add` commands.

Backward compatible: legacy rows without the new field keep today's digest-fallback behavior.
