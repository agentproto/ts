---
"@agentproto/sandbox": patch
"@agentproto/sandbox-computer": patch
"@agentproto/runtime": patch
---

Stop a dead or dropped session from pinning a computer box. `sandbox_attach` rendezvous connects no longer take a session slot nobody can release, a failed `boot`/`connect` releases the slots it took, a throwing MCP `close()` can no longer skip the provider release, and the sandbox gc pass releases dead attachés' slots on boxes that stay in use (`releaseSession`), treats registry-absent sessions as dead (daemon opt-in, grace-limited) and runs its first pass two minutes after daemon start.
