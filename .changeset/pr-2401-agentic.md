---
"@agentproto/runtime": minor
---

The daemon now counts every spawn admission decision per stage and outcome (reuse, deny, allow, defer) in memory and exposes them read-only via `GET /spawn-admission` (`total`, `stages`, `dedupeSources`, capped `codes`, `since`), writing one `[spawn-admission]` log line per non-allow decision. `canSpawn` gains an optional `ignoreLevel` so a delegation-gate `allowed` verdict can skip only the open-mode level comparison, leaving the delegation-deny and closed-allowlist clauses intact; no spawn decision changes.
