---
"@agentproto/runtime": minor
---

Add `reach_send`, a daemon MCP tool that lets any session tell the owner something through the REACH route. A tell needs a `dedupeKey`, is deduped per session for 24 h, is limited to 20 per session per day, and refuses `urgency: "now"`. The `telegram` floor posts a tell as HTML-escaped plain text to the approval cards' chat. Receipts go to `<home>/reach/tells.jsonl` without the summary or links.
