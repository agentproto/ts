---
"@agentproto/runtime": minor
"@agentproto/cli": patch
"agentproto-vscode": patch
---

Introduce shared dashboard presence classifier (`presenceFor`) to unify session-status rendering across CLI and VS Code. Previously, the CLI sessions table and VS Code tree/webview each derived their own inconsistent status readings. The new four-state model (running/tending/attention/quiet) is driven by a pure, config-aware classifier in @agentproto/runtime, consumed identically by both clients. Fixes status divergence and adds grace-window config (`sessions.attentionDelaySec`, default 60s).
