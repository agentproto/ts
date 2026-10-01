---
"@agentproto/acp": minor
"@agentproto/cli": patch
"@agentproto/runtime": patch
---

fix(runtime): detect a dead ACP connection instead of reporting it alive — a
second, independent liveness axis (`adapterConnected`) so a row whose ACP
transport died is no longer reported as running/Idle forever.
