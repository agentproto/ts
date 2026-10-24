---
"@agentproto/inference-endpoint": minor
"@agentproto/app": minor
"@agentproto/app-kit": minor
"@agentproto/bridge": minor
"@agentproto/mastra": minor
"@agentproto/llm-endpoint": minor
"@agentproto/cli": patch
"@agentproto/apps": patch
"@agentproto/product": patch
"@agentproto/adapter-mastra-agent": patch
"@agentproto/runtime": patch
"@agentproto/skill-pack-agentproto": patch
"@agentproto/app-client": patch
"agentproto-vscode": patch
---

Rename three packages to their AIP-70 names: `@agentproto/llm-endpoint` to `@agentproto/inference-endpoint` (AIP-61), `@agentproto/app-kit` to `@agentproto/app` (AIP-53) and `@agentproto/mastra` to `@agentproto/bridge` (AIP-52). The old names stay as deprecated re-export shims with the same exports, and every workspace dependency, import, test and doc points at the new names.
