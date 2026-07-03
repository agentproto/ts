---
"@agentproto/driver-agent-cli": patch
---

Fix `write ENOBUFS` crash when a print-protocol subprocess (e.g. mastracode)
produces output faster than a slow downstream consumer drains it. The stdout
consumer was a `for await (const line of rl)` loop that backpressured onto
`child.stdout`: when the loop suspended at a slow downstream consumer (e.g. an
SSE write to the orchestrator client that stopped reading), readline paused the
stream, the OS pipe buffer filled, and the child's next `write()` failed with
`ENOBUFS`, killing the subprocess mid-turn. The print arm now drains
`child.stdout` continuously (readline flowing mode) into an in-memory queue and
yields to downstream at whatever pace it consumes, so the subprocess never
observes backpressure from a slow client.
