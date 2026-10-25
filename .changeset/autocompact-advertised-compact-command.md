---
"@agentproto/runtime": patch
---

Autocompact now fires on sessions whose harness advertises its compact slash command (`/compact`, or `/compress` for hermes) in `available-commands`. It used to require a `compact` session mode, which no real ACP adapter advertises, so the absolute token threshold never compacted a claude-code session.
