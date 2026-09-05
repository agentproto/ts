---
"@agentproto/runtime": minor
---

Propagate the config-default wallet into sandbox spawns: when `defaults.adapters.<slug>.auth` names a wallet, the host now resolves its credential and forwards it to the box daemon so the sandboxed child session bills the same wallet, and the host descriptor echoes the forwarded wallet for UIs.
