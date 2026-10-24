---
"@agentproto/inference-endpoint": minor
"@agentproto/llm-endpoint": minor
"@agentproto/app": minor
"@agentproto/app-kit": minor
"@agentproto/bridge": minor
"@agentproto/mastra": minor
"@agentproto/cli": patch
"@agentproto/apps": patch
"@agentproto/runtime": patch
"@agentproto/product": patch
"@agentproto/adapter-mastra-agent": patch
"@agentproto/skill-pack-agentproto": patch
"@agentproto/app-client": patch
"agentproto-vscode": patch
---

Complete the AIP-52/AIP-53/AIP-61 batch renames: add the canonical `@agentproto/bridge`, `@agentproto/app` and `@agentproto/inference-endpoint` packages (moved from `mastra`, `app-kit` and `llm-endpoint`), keep the old names as deprecated re-export shims, and repoint every workspace dependency, import, test and doc at the new names.

This complements the changeset already in the PR (`.changeset/aip70-p3-batch7b-renames.md`); the two are merged by changesets so each package is bumped at most once.
