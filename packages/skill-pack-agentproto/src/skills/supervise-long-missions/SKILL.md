---
name: supervise-long-missions
description: "Route missions that outlive your attention — durable waiting, completion gates with retries, scheduled cron check-ins, shared task boards, spend tracking, and cleanup. Use when an agent works longer than one turn or you must not block on it. Triggers: supervise, long-running mission, check-in, non-blocking wait, completion gate."
---

# supervise-long-missions

For missions that outlive your attention. Each row names the primitive that
owns the mechanics; open it for tool signatures and recipes.

| I want… | Open |
| ------- | ---- |
| Non-blocking notification when work completes | `ap-wait-durable` |
| Completion gates with automatic retry nudges | `ap-policies` |
| Scheduled check-ins re-pinging my own session | `ap-cron` (kind prompt-session) |
| A shared board with claim semantics for workers | `ap-tasks` |
| Spend tracking and windowed cost estimates | `ap-models-auth` |
| Cleanup when the mission ends | `ap-lifecycle` |

Playbooks that assemble these steps end-to-end:

- Parallel workers with fan-in and durable waiting → `pb-supervise-parallel-mission`.
- Boss-style scheduled check-ins into one session → `pb-boss-checkins`.

Start here if a mission will run longer than this conversation: arm
`ap-wait-durable` first, add `ap-policies` for quality gates, then `ap-cron`
(kind prompt-session) for periodic check-ins.

Golden rule: arm the watch AT spawn time; wakeup timers are a safety net,
never the mechanism.
