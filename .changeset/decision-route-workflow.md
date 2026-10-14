---
"@agentproto/runtime": minor
---

Ship the `decision-route` workflow (`workflows/decision-route/WORKFLOW.md`) and
its `decision_*` stage tools: collect bounded metadata-only evidence (paths and
code only on an explicit DECISION.md opt-in, secrets scrubbed), apply the
DECISION.md rules with zero models, classify unresolved ranges through one Jev
direct-API call, escalate through at most ONE configured agent-harness session,
map the closed choice to a REVIEW.md binding and, in `enforce` mode only, run
and validate the review. `shadow` is the default and starts no review lane.

The execution profile is enforced before any spawn: `local-free` allows only
OpenCode `-free` / `big-pickle` ids (including role overrides, fallbacks and
`review.recovery`), `remote-sonnet` also allows the configured Claude Code
Sonnet, E2B placement grants no entitlement, and unknown identity fails
closed. The conservative `deep` route cannot bypass the profile. Every stage
records workflow / run / step / profile / model / wait reason, parents spawned
sessions under the workflow run, and reports failures, timeouts and
cancellations separately from approval. Tool restrictions are reported as
configured vs enforced, never as a hard no-tools guarantee.

`decide()` no longer caches backend failures: a conservative fallback is never
remembered as a trusted decision, and a changed classifier identity misses.
Agent session spawns accept a `workflowOwner` that is stamped into the session meta.
