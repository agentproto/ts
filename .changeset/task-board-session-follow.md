---
"@agentproto/runtime": minor
---

session-follow: a follow can now subscribe to a task board with
`selector.boardId` and the new `task-changed` event. The daemon wakes the
follower (one coalesced digest, no polling) when a task on that board is
created, claimed, changes status, or is released by another actor — a pure
field edit is ignored, and the follower's own writes never wake it.
