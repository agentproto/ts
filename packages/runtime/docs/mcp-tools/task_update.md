# task_update

Update a task (rev-CAS: pass the rev you last read; a mismatch answers
`{conflict:true, current}`). The OWNER sets status and releases itself
(`owner:null`); the CREATOR/operator also edit fields, reassign `owner`, cancel,
and reopen a done task (`status:"pending"`).

`status:"done"` on a task with a declared `verify` does NOT close it
immediately — the reply says `verifying:true` and the gate decides after your
turn ends (green → done, red → stays `in_progress` with `lastVerifyError`; watch
`task:changed`). `evidence:{policyId}` closes it off an already-passed policy
without re-running anything. `status:"awaiting_approval"` parks the task on one
or more `approvalIds` (must resolve non-empty, in this write or already on the
task) — a human `approval:decided` on any of them then moves it on its own:
approved → `in_progress`, denied → `cancelled` (`meta.reason:"denied"`). The
owner is never released while waiting, even across a restart.

Field detail cut from the schema lives here; each schema field description ends
with a pointer like `Details: tool_help {name:"task_update", topic:"artifacts"}`.

## evidence

With `status:"done"`: an already-PASSED completion policy standing in for the
gate — `{ policyId }` is stamped verbatim, nothing re-runs.

## artifacts

Replace the evidence trail: session artifacts
(`{ sessionId, key, sha256 }`) and/or approval payload pointers
(`{ approvalId }`). Owner-settable, like `note`.
