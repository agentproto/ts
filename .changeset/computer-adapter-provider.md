---
"@agentproto/sandbox-computer": minor
"@agentproto/runtime": minor
---

New sandbox provider `@agentproto/sandbox-computer` (slug `computer`): boots the agentproto daemon on a self-hosted microVM computer through its controller HTTP API, with suspend=pause, resume (adopting the controller's rebuilt id), rm=stop, liveness probing, chunked exec-based file IO, and `sharedSessions: true` capability plus a per-process `maxSessions` cap. The runtime registry adds the `sharedSessions` capability field (default `false`) and stores token/controllerUrl credentials for the provider.
