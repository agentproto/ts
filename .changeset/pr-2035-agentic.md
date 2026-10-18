---
"@agentproto/runtime": minor
"@agentproto/sandbox-e2b": patch
---

runtime: classify a sandbox box that dies at/after its lifetime deadline while idle as expected expiry (`SandboxBoxExpiredError`), ending the row `status:"exited"` / `endedReason:"sandbox-expired"` instead of `crashed`; add the `sandbox-expired` end reason, a `markSandboxExpired` registry action, and a `type:"branch"` session-outcome artifact carrying the delivered work branch.

sandbox-e2b: document the plan-level continuous-runtime cap behind the lifetime constants (comment-only).
