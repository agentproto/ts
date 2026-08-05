---
"@agentproto/runtime": minor
"@agentproto/cli": patch
---

Session identity environment variables: inject `AGENTPROTO_SESSION_ID` and `AGENTPROTO_WORKSPACE_SLUG` into every process spawned by the daemon on a session's behalf (agent adapters, terminals, commands, cron jobs). Each spawn gets its own freshly minted id; the variables are set last to prevent caller forgery. This enables spawned processes to report back session context, tag telemetry, and nest child sessions under parent sessions via `parentSessionId`.
