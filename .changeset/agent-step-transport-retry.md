---
"@agentproto/workflow-runtime": minor
"@agentproto/runtime": minor
"@agentproto/skill-pack-agentproto": patch
---

Agent steps retry transport failures. A `kind: agent` step whose session dies before its first turn ends (killed or crashed mid-turn, "ACP connection closed") is re-spawned with the same prompt in the same run workspace, instead of failing the run. By default that is one retry after 1 s. A step can set `retry: { max_attempts, backoff, initial_ms }` in WORKFLOW.md, the same block gates take; `max_attempts: 1` turns it off, and a declared `retry` also covers spawn failures. A turn that ended is never retried (empty or errored reply, schema mismatch, input request), and neither is a deliberately ended session, a cancelled run or a `sessionRef` reuse. Each retry is logged as a `step.retrying` run event. New exports: `AgentSessionLostError`, `isAgentTransportFailure`, `DEFAULT_AGENT_TRANSPORT_RETRY`, and the `onAgentRetry` run hook.
