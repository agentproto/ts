---
"@agentproto/runtime": patch
---

A human decision on an approval can re-prompt whoever opened it. `POST /approvals` takes an optional `wake` ({sessionId} and/or {agent} label) and `approval_request` an optional `wake: true` (the caller's own session); on `approval:decided` the daemon sends that target a `[Approbation <id> décidée : approved|refused]` notice, resolved at decision time through the successor chain or the agent label, queued behind a busy turn and never interrupting it. No wake target, no live target: nothing is sent.
