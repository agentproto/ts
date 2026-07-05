---
"@agentproto/telemetry-langfuse": minor
---

Enrich the Langfuse eval sink so traces are self-describing instead of showing
`input`/`output` undefined:

- `eval.started` sets trace `input` (suite descriptor); `eval.finished` upserts
  trace `output` (total/passed/failed/meanValue/passRate/durationMs).
- `eval.case.started`/`eval.case.finished` now open/close a per-case **span**, and
  per-case scores nest under their case span (`observationId`) while aggregate
  scores stay at the trace root — so the trace renders as a proper tree.
- Batch-envelope ids are now `${bodyId}#${operation}` so a create and a later
  upsert/update of the same object (trace output, span close) are not collapsed
  by Langfuse's event dedup.

Verified live against a real Langfuse project: 207/0-errors, trace input+output
populated, two case spans with nested scores.
