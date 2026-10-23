---
"@agentproto/runtime": minor
---

Add `defaults.drive.allowSameWorkspace` (OFF by default), a new rule 5 in
`checkSessionOwnerGate` that lets the drive tools (`agent_prompt`,
`agent_interrupt`, `agent_kill`, `session_restart`, `session_continue_fresh`)
reach any session in the same workspace without a spawn-tree edge or an
`allowPromptFrom` grant — for operators running a flat roster of permanent
sibling agents.

Naming note for reviewers: this is a distinct flag from the existing
`defaults.messaging.allowSameWorkspace` (ON by default, gates
`message_send`/`message_reply` only). Both are named `allowSameWorkspace` in
their respective namespaces (`drive.*` vs `messaging.*`), which is a real risk
of confusion — same name, different defaults (OFF vs ON), different blast
radius (a drive grant can also restart/kill the target, not just message it).
Flagged for a product call on whether to rename/namespace one of them more
distinctly; not renamed here.
