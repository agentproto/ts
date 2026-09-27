---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Device registry (DEVICES-PLAN PR-A): new `createDeviceRegistry` / `registerDeviceTools` / `readPairingsSnapshot` exports and `rename`/`isOnline` on `PairingRegistry` in `@agentproto/runtime`; new `agentproto devices list|rename|revoke` CLI verb and a `devices` step in `doctor` in `@agentproto/cli`, with matching `/devices` REST routes and `device_*` MCP tools over the shared pairing registry.
