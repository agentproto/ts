---
"@agentproto/adapter-mastra-agent": patch
---

Fix SQLITE_CANTOPEN (14) when an OS-confined mastra-agent spawn (workflow step, app boundary) opens its memory db: the adapter now declares a `stateHome`, so a confined spawn gets a writable per-session state dir (`AGENTPROTO_MASTRA_STATE_HOME`) instead of `~/.agentproto/mastra-agent`, which the sandbox denies.
