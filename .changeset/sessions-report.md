---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Added a fleet-wide session stats report over a start-time window: `agentproto sessions report [--since 12h] [--topN 5] [--json]` and the equivalent `sessions_report` MCP tool / `GET /sessions/report` REST route. Reports session counts by harness and model, status + end-reason breakdown, total/average wall-clock duration, tokens and estimated cost (split subscription vs api-key billing when the session's resolved auth mode says so), PRs opened by in-window sessions, the top-N costliest and top-N longest-running sessions, every currently-active session, and every alive `keepAlive` "permanent" agent. Merges the live registry with cold on-disk session rows so a busy host's `HISTORY_CAP` doesn't undercount the window.
