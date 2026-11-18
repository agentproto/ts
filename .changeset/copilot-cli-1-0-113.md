---
"@agentproto/acp": minor
"@agentproto/adapter-copilot-cli": minor
---

Bring the `copilot-cli` harness up to date with Copilot CLI 1.0.113. The ACP client now resolves the reasoning-effort config id from the session's advertised `configOptions` (`effort`, then `reasoning_effort`, then the `thought_level` category) instead of hard-coding `effort`, which Copilot rejects — so the requested effort is no longer silently dropped on Copilot, both at session start and for a mid-session `agent_set_effort` (Claude, Codex and OpenCode keep `effort`). The Copilot harness now declares its real model menu (`mai-code-2`, `claude-sonnet-5.5`, …) instead of an empty `modelCount`, declares `multimodal: true` (image prompt proved live), and documents the agent / plan / autopilot modes, the `reasoning_effort` id and that two concurrent prompts cancel each other (`steering: false` is correct). Docs and metadata are marked verified on 1.0.113.
