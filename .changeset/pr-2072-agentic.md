---
"@agentproto/sandbox-computer": minor
"@agentproto/runtime": minor
---

New sandbox provider `@agentproto/sandbox-computer` (slug `computer`): boots the agentproto daemon on a self-hosted microVM computer through its controller HTTP API, with suspend=pause, resume (adopting the controller's rebuilt id), rm=stop, liveness probing, chunked exec-based file IO, and a `sharedSessions: true` capability plus a per-process `maxSessions` cap.

`@agentproto/runtime` gains the optional `sharedSessions` sandbox-provider capability field (default `false`) and stores controller token/URL credentials for the provider.
