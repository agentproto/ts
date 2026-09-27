---
"@agentproto/secrets": minor
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Reverse pairing (DEVICES-PLAN PR-C): optional `scope: "host"` on pair/v2 offer URLs in `@agentproto/secrets` (`encodeOfferUrl`/`parseOfferUrl`, additive — a plain offer's URL is unchanged); new `createHostRegistry`/`HostRegistry` in `@agentproto/runtime` (the daemon-side pair/v2 client for registering and driving another daemon as a host), merged into `createDeviceRegistry`/`device_list` as `role: "host"`, plus the `device_add` MCP tool and `/devices/add` + `/devices/:id/exec` REST routes; new `agentproto pair offer --host` and `agentproto devices add|status` in `@agentproto/cli`.
