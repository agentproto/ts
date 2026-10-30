---
"@agentproto/runtime": minor
---

The caller identity counters behind `GET /identity` now persist in `identity-observations.json` and add up across daemon restarts; `since` is the first boot recorded, `bootedAt` and `boots` (last 50, with build sha) are new; deleting the file starts a new window.
