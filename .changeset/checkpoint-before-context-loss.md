---
"@agentproto/runtime": minor
---

Context-losing steps now write a checkpoint first, and compaction can be reserved to the operator. A `/compact` or `/compress` prompt, the runtime's own auto-compaction and the context hard stop each persist a checkpoint (goal, plan, decisions, changed files, tests, errors, risks, next step) before they act; if the checkpoint cannot be written, compaction is refused (the hard stop still happens, with a loud warning). New `contextContinuity.compactRequiresOperator` policy flag: a compaction prompt attributed to a session (`agent_prompt`, `session_compact`, the session itself) is refused, so only an operator-originated prompt can compact. `session_compact` now attributes its prompt to the calling session.
