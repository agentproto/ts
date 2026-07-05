---
"@agentproto/runtime": minor
---

Wire `langfuseSessionTracer` into the session loop as an opt-in per-session observer. Sessions trace to Langfuse when spawned with `trace: true` on `agent_start`, or when `defaults.langfuseTracing` is set in config.json — off by default. Creds are reused from the existing eval-reporter langfuse store; no new setup required.
