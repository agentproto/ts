---
"@agentproto/runtime": minor
---

An AGENT.md `on: {turn-end: session:clerk-pass}` entry now enables the AIP-68 clerk for that agent's sessions. The clerk's configuration (debounce, run, exclude) stays in `metadata.hooks.clerk`; the `on` entry only adds `enabled: true` at the agent level, and an explicit `metadata.hooks.clerk.enabled` (true or false) still wins. The agent `on` scanner leaves the clerk's turn-end entry out of the reaction bindings so it is not refused there.
