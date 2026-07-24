---
"@agentproto/llm-endpoint": minor
"agentproto-vscode": minor
---

Add hot-reload functionality for local model packs (packs.local.json). The llm-endpoint proxy now validates pack configurations and exposes a POST /v1/packs/reload endpoint for live reloading without a restart. The VS Code extension gains a "Reload Local Router Packs" command with tree-view integration and field-scoped error feedback.
