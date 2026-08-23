---
"@agentproto/runtime": patch
---

Rate-limit `/mcp` transport error logs through the existing
`createReconnectLogGate` (first failure immediate, then ≤1 line per minute
with a suppressed-count suffix). Bare per-failure `console.error` on a
launchd-redirected regular-file stderr is a synchronous disk write per
malformed probe — a log flood and an event-loop stall risk under bursts of
retrying clients (the `Parse error: Invalid JSON` / ECONNRESET incident).
Wire behavior is unchanged: every probe still gets its JSON-RPC error
response.
