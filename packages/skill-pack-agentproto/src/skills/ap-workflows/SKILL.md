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

### Conditional steps: `kind: branch`

Arms are **exclusive** with a join — exactly one arm's steps run, then the run continues after the arms:

```yaml
  - id: maybe-render-pdf
    kind: branch
    branches:
      - when: $input.exportPdf   # bare ref = truthiness; or `<ref> <op> <literal>`
        next: pdf-render
    # default: <id>             # optional arm for "no when matched"
    # join: <id>                # optional: where execution resumes
  - id: pdf-render               # the arm body: its target up to the next arm target / the join
    kind: tool
    tool: pdf.render
  - id: next-step                # the join (step after the last arm target): runs either way
```

- Every `next`/`default`/`join` must be a LATER sibling in the same step list.
- Arm body = its target step up to (not including) the next arm's target; the last arm runs up to `join` (default: the step right after its target, so give a multi-step last arm an explicit `join:`).
- No `default` and nothing matched ⇒ only the steps between the branch and its first arm target run (none when the first target is the very next step), then the join. So an optional step needs no no-op "skip" sibling.
- Untaken arms' steps show as `skipped` in `workflow_status` (AIP-58 `step.skipped` event) — not missing, not `done`.
- `fallthrough: true` is the legacy mode (target + every later sibling runs); don't use it for new workflows.

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
- Re-running a failed run: re-invoke `workflow_run_file` with the SAME `path`, `input`, and `cacheKey` — every `cacheable` step that already succeeded replays from the journal (no re-spawn); only the step that failed (or whose resolved input changed) re-executes. Each item of a `map` caches independently, so fixing one bad item and re-running only re-does that item. A replayed step still shows in `workflow_status` as `done`, marked `cached: true`. This is a manual retry (re-supply the same args yourself), not a resumable run object — a first-class retry/replay verb is AIP-58 P5, not implemented yet.
- Cancel is graceful: in-flight steps complete, but no new stages start.
- Returning `runId` immediately does not mean the run started cleanly — first `workflow_status` poll is where a bad step spec surfaces.

## Pointers

- agentproto — daemon overview; the workflow engine's stage/barrier model.
- ap-spawn-agent / ap-prompt-agent — the per-session primitives workflow steps wrap.
- ap-read-output — fetching a session's reply for downstream stages.
- pb-build-app — apps bundle WORKFLOW.md files; this is their runtime.
