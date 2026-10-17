---
"@agentproto/workspace": minor
"@agentproto/cli": minor
---

Added `workspace/v2` (AIP-34 extended): `defineWorkspaceV2` + `WorkspaceDefinitionV2`/`WorkspaceHandleV2` (TS authoring), `writeWorkspaceV2Manifest` (.ts → .md) and `parseWorkspaceV2Manifest`/`workspaceV2FromManifest` (.md → object) — all backed by the single `workspaceV2FrontmatterSchema`, so load/export/verify can never drift from each other. Adds the companion formats a tree needs: `TYPES.md` (node-type registry), `agentproto.lock` (tree-wide app/pack lockfile), and `EXPORT.md` (the sealed/hard node digest). `workspace/v1` is untouched — v2 is an additive sibling schema, not a bump.

Adds the first version of the cross-node verifier, `checkWorkspaceTree` (`@agentproto/workspace/checker`) and the CLI surface `agentproto workspace check <dir>`: validates node `type` against `TYPES.md` (allowed parents, wall floor, required files), two-sided `includes`/`exports` consent, `uses_secrets` grants against the provider's `SECRETS.md` (plus a no-literal-secret-values heuristic), and `policy.limits` budget aggregation (most-restrictive-wins down the tree).
