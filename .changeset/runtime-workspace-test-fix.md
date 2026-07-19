---
"@agentproto/runtime": patch
---

Repair two `WorkspaceEntry` test literals that predated the AIP-34
`addedAt`/`updatedAt` fields becoming required, restoring `check-types` green.
