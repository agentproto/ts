---
name: ap-workflows
description: Run multi-stage session pipelines with agentproto workflows — workflow_start with barrier-gated stages of concurrent steps, sessionRef to reuse earlier output, workflow_status/cancel, workflow_run_file for AIP-15 WORKFLOW.md, and workflow_escalation_resolve for human answers. Trigger when asked to pipeline agents, fan out stages, or run a WORKFLOW.md.
---

# ap-workflows

## When to use

- Work needs ordered phases where each phase fans out agents that run in parallel.
- A later stage must act on an earlier stage's output (produce → review → fix).
- You have a ready AIP-15 `WORKFLOW.md` (+ optional `entry.mjs`) to run as-is.

## Start a pipeline

```json
workflow_start({
  "workflowId": "review-then-fix",
  "stages": [
    { "label": "produce", "steps": [
        { "label": "plan", "adapter": "claude-code", "prompt": "Draft the migration plan for src/auth." }
    ]},
    { "label": "review", "steps": [
        { "label": "review-a", "adapter": "claude-code", "prompt": "Review the plan for data-loss risks." },
        { "label": "review-b", "adapter": "claude-code", "prompt": "Review the plan for test coverage." }
    ]},
    { "label": "fix", "steps": [
        { "label": "fixer", "sessionRef": "review-a", "prompt": "Address the review comments." }
    ]}
  ]
})
// → { "runId": "wf_..." } — execution is background; returns immediately.
```

**Steps within a stage run CONCURRENTLY. Stages are barriers:** stage N+1 does not start until every step of stage N has finished (or failed). `adapter` spawns a NEW session for the step; `sessionRef` (a prior step's `label`, any earlier stage) reuses that session instead — ignoring `adapter`.

## Poll and steer

```json
workflow_status({ "runId": "wf_..." })
// → per-stage: each step's status + sessionId — read earlier output via ap-read-output on that id
workflow_cancel({ "runId": "wf_..." })   // in-flight steps finish; no new stage starts
workflow_list({})                        // running / done / failed / cancelled runs
```

## Run a WORKFLOW.md file

```json
workflow_run_file({
  "path": "workflows/morning-sweep/WORKFLOW.md",
  "input": { "date": "2026-09-01" },
  "cacheKey": "morning-sweep-2026-09-01"
})
```

Loads the AIP-15 file via the workflow-loader and runs it through the same runner as `workflow_start`, in the background. With a `cacheKey`, cacheable steps replay unchanged output on re-invocation instead of re-spawning.

## Escalations

When a step's `policy` is `escalate` and its session asks for human input mid-stage, the run parks until answered:

```json
workflow_escalation_resolve({
  "runId": "wf_...", "stageIndex": 1, "stepIndex": 0,
  "response": "Use the staging DB, not prod."
})
```

The answer is injected into the awaiting session and the stage resumes.

## Gotchas

- Later-stage steps read earlier output via `sessionRef` **plus** `agent_output` on that sessionId (see ap-read-output) — `sessionRef` reuses the conversation, it does not paste output into the prompt.
- `policy: "escalate"` parks the stage until someone calls `workflow_escalation_resolve` — an unresolved escalation means the run sits there forever. Give the webhook (`notifyUrl`) or check `workflow_status` on a cadence.
- `cacheKey` only affects steps marked `cacheable: true` — cache only idempotent/pure steps; replayed output goes stale otherwise.
- Cancel is graceful: in-flight steps complete, but no new stages start.
- Returning `runId` immediately does not mean the run started cleanly — first `workflow_status` poll is where a bad step spec surfaces.

## Pointers

- agentproto — daemon overview; the workflow engine's stage/barrier model.
- ap-spawn-agent / ap-prompt-agent — the per-session primitives workflow steps wrap.
- ap-read-output — fetching a session's reply for downstream stages.
- pb-build-app — apps bundle WORKFLOW.md files; this is their runtime.
