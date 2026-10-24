---
"@agentproto/runtime": patch
---

Record what a triage stage would decide for sentinel deliveries. The new `sentinel-triage` module classifies each session delivery as `wake` or `fyi` using ordered rules (`terminal`, `coalesced-repeat` within 10 minutes, then `default`) and appends an observation-only JSONL line (`applied: false`) to `~/.agentproto/sentinel-triage.jsonl`. Delivery itself is unchanged.
