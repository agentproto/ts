---
"@agentproto/runtime": minor
---

Resolve session route/model as a single source of truth: `resolveEffectiveRoute`, `modelWithRoute`, and `reconcileModelRoute` replace two disagreeing hand-written resolvers and prevent route/model overrides from describing two different billing endpoints (SPEC risk R2 / §4.4).
