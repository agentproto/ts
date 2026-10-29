---
"@agentproto/runtime": minor
---

An AGENT.md `on: {turn-end: session:clerk-pass}` entry now enables the AIP-68 clerk for that agent's sessions. The clerk's configuration (debounce, run, exclude) stays in `metadata.hooks.clerk`; the `on` entry only adds `enabled: true` at the agent level, and an explicit `metadata.hooks.clerk.enabled` (true or false) still wins, so existing manifests keep their behaviour. The agent `on` scanner no longer reports the `turn-end` clerk entry as a refused reaction binding, since the clerk's own turn-end controller owns it.
