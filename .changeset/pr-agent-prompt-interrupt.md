---
"@agentproto/runtime": minor
---

agent_prompt / message_parent: queued-mid-turn delivery hint + configurable interrupt default.

When a prompt lands mid-turn and gets FIFO-queued, the tool's return now says
so (`delivery: "queued-mid-turn"`) and tells the caller to re-send with
`interrupt: true` if the message should cut the in-flight turn instead.
`message_parent` gains an `interrupt` flag so a child can redirect its parent
the same way.

New 3-state interrupt semantics on both tools: unset resolves the daemon
default `defaults.agentPromptInterrupt` (false today), `true` cuts the
in-flight turn, explicit `false` queues without the hint. The explicit flag
always wins over config. Threaded to the root gateway and the scoped
orchestrator gateway.
