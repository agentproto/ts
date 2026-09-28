---
"@agentproto/model-routing": minor
---

Renamed the AIP-57 pack constructor and type to `defineRoutingPack` / `RoutingPack`, since `definePack` and `Pack` collided in name with the unrelated `definePack` / `PackDefinition` in `@agentproto/pack` (AIP-52, a commercial vertical bundle — a different concept entirely). `definePack` and `Pack` remain exported as deprecated aliases for existing consumers.
