---
"@agentproto/runtime": minor
---

Add AIP-45 mode support to CronAction agent type: `mode` (mode id), `permissionHold` (start in permission-hold mode), and `options` (manifest-declared option ids). These optional fields are properly threaded through `startSession` and `spawnAgent` calls with conditional spreading to maintain backwards compatibility.
