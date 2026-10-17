---
"@agentproto/runtime": patch
"@agentproto/apps": patch
---

`@agentproto/runtime` now stamps installed app service-owner sessions with an explicit `origin` of `app-service:<appId>` at spawn time, so session lifecycle policy can distinguish app-managed roots from human-launched sessions without inferring ownership from a mutable display label.

`@agentproto/apps`' Session Steward now treats `app-service:*` and `pygmalion` / `pygmalion:*` origins as machine-owned roots eligible for origin-bounded lifecycle actions, and documents the separation between classifier verdicts and deterministic mutation authorization.
