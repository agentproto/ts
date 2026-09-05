---
"@agentproto/runtime": patch
---

Fix cost refresh on empty turns. Some adapters (e.g., OpenRouter-routed opencode) settle their adapter-reported cost on trailing no-op turns carrying no assistant text or tool calls. On such turns, PR discovery lanes are correctly skipped (no new PR opened), but cost refresh must still run to re-render the footer once spend becomes known. Previously, cost refresh was entirely skipped on empty turns, leaving a session whose PR-creating turn stamped a footer with no cost amount to go unstamped forever if all later turns remained empty or if the session never exited.
