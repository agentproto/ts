---
"@agentproto/runtime": minor
---

Add the opt-in daemon-side session titler (`titler.enabled` in config): after the first completed turn of an `agent-cli` session with a default spawn label, generate a short prosaic title (OpenRouter by default, local first-line fallback) and rename the session. User-created labels are never overwritten; disabled by default.
