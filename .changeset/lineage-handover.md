---
"@agentproto/runtime": minor
---

Add the generic **lineage handover** mechanism: a successor session can take over a replaced session's children, so a persistent orchestrator (the "brain") that is replaced by a NEW session (restart, wallet change, continue-fresh) leaves its supervisors/executors reachable.

- `agent_start.succeeds: "<sessionId>"` declares the new session the successor of another one. Only the human operator, the replaced session itself, or the session that owns it may declare it. On declaration the replaced row's LIVE children are re-parented onto the new session (its `parentSessionId` moves), which is what makes the successor their OWNER for the drive tools (`agent_prompt` / `agent_interrupt` / `agent_kill` / `session_restart` - the session-owner gate keys on `parentSessionId`) and what routes their `message_parent` reports to the successor instead of the dead row. The successor also inherits the replaced row's place in the spawn tree.
- `session_continue_fresh` does the same automatically: the fresh continuation takes over the retired row's children, so the continued "brain" can still drive them and they can still report up.
- New MCP verb `session_adopt { childIds, from }` moves named children of a row onto its DECLARED successor. Only the human operator or that declared successor may run it.
- Every handover records the succession on both descriptors (`succeededBy` / `succeeds`, persisted) and emits a `session:lineage-handover` event on the session event bus (from, successor, adopted/skipped children, reason, actor).
