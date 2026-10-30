---
"@agentproto/runtime": patch
---

Run the exit-time sandbox checkpoint GC against the host workspace repo instead of the in-box `cwd`. Sandbox descriptors now persist a `sandboxRepoRoot` (the host repo root) so `agentproto-checkpoint/*` refs can be reclaimed after a session exits, including across session restart.
