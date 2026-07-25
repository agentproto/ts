---
"@agentproto/runtime": patch
---

Resolve session route/model as a single source of truth: `resolveEffectiveRoute` replaces two disagreeing hand-written resolvers, and `reconcileModelRoute` prevents a route-only or model-only restart/spawn override from leaving the descriptor's `route.gateway` and `model` fields describing two different billing endpoints.
