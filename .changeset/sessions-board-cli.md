---
"@agentproto/cli": minor
---

`agentproto sessions board [--json] [--watch] [--all]`: an at-a-glance
session-status board. Every session gets one Badge — ACTIVE (running +
busy), IDLE (running, parked, young or keepAlive), STALE (running, idle
past the 15-min reap-risk age without keepAlive, or interrupted
mid-turn), AWAITING (awaitingInput/awaitingPermission), BLOCKED
(blockedOn set), ENDED (with endedReason), and with `--all` the
`kind:"command"` execution-log rows — sorted by attention-worthiness
behind a one-line summary header (`485 sessions — 3 blocked · 6 stale ·
5 active · 470 ended`). `--json` emits the classes plus every evidence
field the rules read (keepAlive, interrupted, continuedFrom handoff
edge, blockedOn, idleMs, costUsd when usage exists); `--watch` re-renders
every 2s on a TTY (q to quit).
