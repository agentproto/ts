---
"@agentproto/runtime": minor
---

Workflow `kind: "approval"` steps are now resolved by a human instead of silently auto-approving. A declarative approval step parks the run as `awaiting-approval` with an `awaitingApproval` inbox record (visible in `workflow_status`), emits `workflow:approval-requested`/`workflow:approval-resolved` session events, and waits for a decision through `workflow_escalation_resolve`'s new approval form (`approvalId` + `approved` + `who` + optional `note`) — also exposed as `WorkflowRunner.resolveApproval`. The decision is appended to the app state ledger (`kind: "approval"`, `by: "human"`); a step `timeout_ms` resolves as rejected with `who: "timeout"`; a run parked awaiting approval survives a daemon restart (the pending item is re-registered, exactly one ledger event). `app_status` surfaces `awaitingApprovals[]` across the app's runs.
