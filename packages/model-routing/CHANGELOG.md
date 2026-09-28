# @agentproto/model-routing

## 0.3.0

### Minor Changes

- 38b821d: Renamed the AIP-57 pack constructor and type to `defineRoutingPack` / `RoutingPack`, since `definePack` and `Pack` collided in name with the unrelated `definePack` / `PackDefinition` in `@agentproto/pack` (AIP-52, a commercial vertical bundle — a different concept entirely). `definePack` and `Pack` remain exported as deprecated aliases for existing consumers.

## 0.2.0

### Minor Changes

- 4cae3f1: Initial release of `@agentproto/model-routing`, the AIP-57 MODEL-ROUTING reference implementation: packs over declared keyspaces, ordered override > env > pack layers that always report which layer won, `null` as a non-overridable capability gate, and deterministic sticky selection over chains via FNV-1a over the stable prefix. Pure per AIP-57 §7 — no I/O, no clock, no randomness.
