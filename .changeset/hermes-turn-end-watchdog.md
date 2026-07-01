---
"@agentproto/acp": minor
"@agentproto/driver-agent-cli": minor
"@agentproto/runtime": minor
"@agentproto/adapter-hermes": patch
---

Add a per-turn silence watchdog to the ACP client, fixing an unbounded hang
when an adapter's ACP server drops the final `prompt` JSON-RPC response
(observed live with hermes after it hits its internal max-tool-iterations
cap and produces a final answer but never replies over the wire). Built on
top of session-liveness's `onActivity` plumbing: `AcpClientOptions.turnIdleTimeoutMs`
starts a timer alongside `connection.prompt()`, reset on every activity
signal (incoming `session/update`, outbound RPCs) observed during that turn,
and — if it elapses with no activity and the real response still hasn't
arrived — synthesizes a `turn-end` event with `reason: "watchdog-timeout"`
so the daemon's turn drain loop completes instead of hanging forever. A late
real response is logged and discarded, never crashes, and never produces a
duplicate turn-end.

Threaded through `AgentCliConnectOptions.turnIdleTimeoutMs` →
`AgentCliStartOptions.turnIdleTimeoutMs` → the new manifest field
`session.turn_idle_timeout_ms`, which `createAgentCliRuntime(...).start()`
falls back to when the caller doesn't override it per-spawn. Disabled by
default (undefined) for every adapter except hermes, which now declares
`turn_idle_timeout_ms: 300_000` (5 minutes) — the only adapter with
observed evidence of this failure mode.

`SessionTurnEndEvent` (the `session:turn-end` bus event) gained an optional
`reason` field carrying the driver's reported turn-end reason, so
`policy_attach` gates / `session_monitor` / any other consumer can
distinguish an inferred watchdog completion from a real one.
