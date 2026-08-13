---
"@agentproto/runtime": patch
---

Add opt-in `gh` provenance PATH shim for local agent sessions. When `provenance.wrapGh` is enabled, spawned sessions get a shim directory prepended to PATH so `gh pr create` (or adapter subprocesses) automatically append the daemon's deterministic `@agentproto-bot` provenance footer to PR bodies, matching cloud runner behavior.
