---
agentproto-vscode: minor
---

Add "Use My Existing Claude Code Login" — a source-backed auth profile that reuses your local Claude Code subscription without pasting a token (resolved fresh on every spawn), plus an activation-time auto-adopt policy (`agentproto.autoAdoptLocalLogin`: auto | ask | off). Codex/Gemini are deferred: the subscription-source mechanism needs an adapter with an `authSubscription` bearer env, which only claude-code provides today.
