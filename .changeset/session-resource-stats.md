---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

feat(sessions): per-session process-tree resource stats. The daemon samples the host process table (ps, with a /proc fallback on Linux) and attributes RSS, %CPU, process count and top commands to each live session by descending from its adapter pid, with separate buckets for the daemon and for worktree provisioning work, and a report-only list of agentproto-looking orphan processes (never killed). New surfaces: `agentproto sessions --stats[=full] [--json]` (RAM-sorted table, totals row, host load and free memory), `GET /sessions/stats`, a `session_stats` MCP tool, and `stats: true | "full"` on `session_list` and `agent_sessions_list`.
