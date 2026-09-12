---
"@agentproto/sandbox": minor
"@agentproto/runtime": minor
"@agentproto/sandbox-e2b": minor
"@agentproto/cli": minor
---

Expose sandbox liveness separately from session liveness: optional `SandboxProvider.probe()` with `SandboxProbeResult`, a portable `SandboxBoxGoneError` sentinel (e2b maps provider 404s to it), a `GET /sandboxes/:id/alive` runtime route, a new `"gone"` sandbox-ledger state with `sandboxAlive`/`sandboxCheckedAt` projected onto session summaries, and a LIVE column plus `--no-probe` flag for `sandbox list`.
