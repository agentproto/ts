---
"@agentproto/runtime": minor
---

Agent review lanes retry once in a fresh reviewer session on transient reviewer errors (configurable via `review.laneRetries`, `0` disables; credential, quota and unknown-model errors are never retried) and report the adapter's own error text. The daemon reviewer host also fails closed on OpenRouter: a lane whose preset, model or auth profile resolves to OpenRouter is refused with a pointer to opencode-go / Claude-subscription presets.
