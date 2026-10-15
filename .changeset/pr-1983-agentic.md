---
"@agentproto/runtime": minor
---

Carry the PR review body (capped at 4096 chars as `data.body`) and the review's `html_url` (`data.reviewUrl`) on normalized `pull_request_review` webhook events, and append a whitespace-collapsed one-line snippet of the body (≤200 chars) to the event `summary` so watchers see why a verdict was given. An empty or absent review body keeps the previous `data`/`summary` shape exactly.
