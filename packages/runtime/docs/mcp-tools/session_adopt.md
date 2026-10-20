# session_adopt

Lineage handover: adopt the named CHILDREN of a replaced session onto its
DECLARED successor - the session recorded as that row's successor (the one
that took over its place in the spawn tree, e.g. after a `continue-fresh` or
an `agent_start.succeeds` declaration).

## from

The session whose children are being adopted (the replaced row). The
successor is NOT passed: it is the row's own recorded successor
(`from.succeededBy`). When no successor was declared, the call is refused -
declare the succession first (`agent_start { succeeds: "<id>" }` by the
operator or by the replaced session itself, or a `session_continue_fresh` of
that session).

## childIds

The ids of the children to move. Only sessions that ARE currently children
of `from` are moved - a call cannot adopt an unrelated session into someone
else's tree; anything else is reported back in `skipped`. So is a child
that cannot move without creating a cycle (the successor sits inside that
child's own subtree). A dead child is moved when named explicitly.

## What a move does

The adopted child's `parentSessionId` moves to the successor. That single
pointer carries the whole contract:

- the successor becomes the child's OWNER, so it may drive it
  (`agent_prompt` / `agent_interrupt` / `agent_kill` / `session_restart` /
  `session_continue_fresh` - the session-owner gate keys on
  `parentSessionId`);
- the child's `message_parent` reports reach the successor (it resolves the
  caller's recorded parent) instead of the row that was replaced;
- the replaced session loses those rights - it is gone anyway.

The child keeps its id, transcript and state: only the lineage pointer
moves.

## Who may run it

The human operator, or the DECLARED successor of `from`. Nobody else: a
child of `from` cannot adopt its siblings, and an unrelated session cannot
either. A scoped orchestrator cannot run it at all - the verb is not part of
the orchestrator tool set.

## Result

```json
{
  "ok": true,
  "from": "sess_old_brain",
  "to": "sess_new_brain",
  "adopted": ["sess_supervisor"],
  "skipped": []
}
```

Every move also emits a `session:lineage-handover` event on the session
event bus (from, successor, adopted/skipped, reason, actor).
