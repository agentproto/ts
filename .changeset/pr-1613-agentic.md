---
"@agentproto/runtime": minor
"@agentproto/cli": patch
---

`@agentproto/runtime`: new exports `projectBrowserTools` and `defaultBrowserAdapterResolution`/`defaultBrowserAdapterResolutionIds`, shared browser adapter resolution used by the CLI and MCP surface.

`@agentproto/cli`: `serve.ts` now resolves browser adapters through `defaultBrowserAdapterResolution` instead of a local mapping.
