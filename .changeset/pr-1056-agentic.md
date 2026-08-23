---
"@agentproto/runtime": minor
---

Add ground-truth cross-check for judge gates: when a judge gate runs on a session that has already had a machine gate (shell or cost) execute, the judge's prompt now includes the machine gate's actual exit code and output. This prevents judges from rendering verdicts that contradict already-computed results. Includes `kind` discriminator on `PolicyRunState.lastGate` to distinguish shell/cost/judge gates.
