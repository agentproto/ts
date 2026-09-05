---
"@agentproto/workflow-runtime": patch
---

`runWorkflow`'s `approve` hook may now return a full decision `{approved, who, note?}` (a bare boolean still works), `ApprovalStep` gains `artifacts` and `timeoutMs` (timeout resolves as rejected with `who: "timeout"`), and the step output records who decided.
