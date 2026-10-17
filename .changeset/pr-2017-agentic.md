---
"@agentproto/workspace": minor
"@agentproto/cli": minor
---

`workspace/v2` (AIP-34 extended) reference implementation: `defineWorkspaceV2` plus `.ts ↔ .md` manifest round-trips backed by a single zod schema, the companion formats (`TYPES.md`, `agentproto.lock`, `EXPORT.md`), the cross-node `checkWorkspaceTree` verifier, and the `agentproto workspace check <dir>` CLI surface. This increment also exports pre-default input types (`TypesManifestFrontmatterInput`, `AgentprotoLockInput`, `ExportManifestFrontmatterInput`) so the `write*` helpers accept author input that omits schema-defaulted fields.
