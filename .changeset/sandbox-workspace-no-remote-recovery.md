---
"@agentproto/runtime": minor
"@agentproto/sandbox": patch
---

Sandbox sessions are now recoverable for workspaces with no `remote` in workspaces.json. The clone source is derived from the checkout's git `origin` (ssh forms normalized to https, registered `agentproto.git.<slug>` credential used, public repos only otherwise, never persisted); a workspace with no usable origin has its box working dir checkpointed to the host as a size-capped tarball at turn end and teardown, and `session_restart` on a fresh box extracts it. Missing pieces are reported with how to fix them. The sandbox agent-session host also forwards the provider's `writeFile`.
