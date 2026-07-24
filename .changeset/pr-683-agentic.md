---
"@agentproto/adapter-claude-code": patch
"@agentproto/adapter-claude-sdk": patch
"@agentproto/adapter-hermes": patch
"@agentproto/runtime": minor
"agentproto-vscode": patch
---

Fix model routing for multi-vendor gateways (OpenRouter/Requesty) by introducing route-identity suffixes. Add bare-product curation tolerance for existing allowlists on direct routes. Export a new `@agentproto/runtime/catalog-models` subpath for the vscode picker's unroutable-model warning.
