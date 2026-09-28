---
"@agentproto/cli": minor
"@agentproto/runtime": minor
"@agentproto/llm-endpoint": minor
---

Device inference over pair/v2: a controller can address a paired host's local models transparently as `<endpointId>@<device>` (e.g. `ollama@work-mac/llama3.1:8b`), routed over the paired E2E channel with no open inbound port. Includes the opt-in `features.deviceInferenceShare` flag + `agentproto devices share-inference on|off` (gated by host-scoped pairings via a daemon-injected `x-agentproto-host-scope` header), the streaming `POST /devices/:id/exec-stream/<subpath>` relay, corporate-proxy support (`HTTPS_PROXY`/`NO_PROXY`) for rendezvous dials, and a `doctor` rendezvous reachability step.