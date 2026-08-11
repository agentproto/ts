---
"@agentproto/cli": patch
---

Add workspace-local adapter resolution as a fallback when npm/node_modules resolution fails. Enables adapters under active development to resolve from `adapters/<slug>/dist/index.mjs` before they're added as dependencies or published to npm, improving the adapter authoring workflow.
