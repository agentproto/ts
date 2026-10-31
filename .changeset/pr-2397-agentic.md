---
"@agentproto/runtime": minor
"@agentproto/apps": patch
---

Context settings now layer setting by setting over the request, adapter and daemon blocks (AIP-46 §Session context rule 4), and `contextSettings` is the name of the block on `agent_start`, `POST /sessions/agent`, `POST /sessions/:id/restart` and in `defaults.contextSettings` and `defaults.adapters.<slug>.contextSettings`; `contextContinuity` stays an alias. A layered block whose percent bands conflict fails the spawn as `invalid_context_settings` (HTTP 400) and names the layers.

Minor, not major (`.changeset/README.md` reserves major for a removed export, a changed signature or a renamed type): nothing is removed or renamed, `ContextSettings` and `layerContextSettings` are new exports. A partial block now inherits its unset keys from the adapter and daemon blocks instead of the built-in defaults, which is the AIP-46 conformance fix.
