---
"@agentproto/runtime": patch
---

Send `X-MCP-Subscription-Id` (the sentinel id returned by `events/subscribe`) on every signed event delivery attempt; OpenAI rejected deliveries without it (found against ChatGPT).
`events/subscribe` results now carry `truncated: false` alongside `cursor: null`.
