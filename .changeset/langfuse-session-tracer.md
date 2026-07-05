---
"@agentproto/telemetry-langfuse": minor
"@agentproto/runtime": minor
---

Agent-session tracing to Langfuse. `@agentproto/runtime` gains
`langfuseSessionTracer` — a `SessionObserver` that projects the per-session
stream into Langfuse traces + generations + tool spans, with native tokens/cost
from the runtime's own pricing and every outbound payload passed through a
resolved `@agentproto/redaction` redactor at the egress boundary (opt-in; off by
default at the call site). All adapters are covered from the one shared tap — no
per-adapter instrumentation, and the metadata telemetry port is untouched.

`@agentproto/telemetry-langfuse` extracts a shared `createIngestionClient`
(auth + batch + atomic-drain flush) that both the eval sink and the session
tracer sit on; the atomic drain also fixes a latent bug where items enqueued
during an in-flight flush could be dropped.
