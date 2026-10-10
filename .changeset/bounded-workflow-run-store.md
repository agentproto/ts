---
"@agentproto/runtime": minor
---

Bound workflow-run persistence. `workflow-runs.json` is replaced by one file per run (`workflow-runs/<runId>.jsonl`), written asynchronously and only when that run changed; lease heartbeats rewrite a tiny `.lease` sidecar instead of the registry. Step and run outputs over a configurable ceiling (`AGENTPROTO_WORKFLOW_*` env overrides) keep a bounded preview plus a pointer, with the full value kept as a per-run artifact file that `workflow_status full:true` and `workflow_artifact_get` still resolve. Memory holds active runs plus a count/age-capped summary index and lazy-loads older runs; `WorkflowRunner.list()` returns summaries and `flush()` awaits durability. The legacy file is migrated on first boot (idempotent, `.bak` kept). Runs parked at `awaiting-approval` survive a restart as a small envelope and expire after `approvalTtlMs` (default 7 days) with `errorCode: "approval-expired"`.
