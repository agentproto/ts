---
"@agentproto/runtime": patch
---

fix(tunnel): cloudflared providers no longer wedge under a busy host

The quick + named Cloudflare tunnel providers spawned `cloudflared` with
`stdio: ["ignore", "pipe", "pipe"]` and watched the pipe for a readiness
marker. Under a busy host event loop (the daemon serving MCP/sessions), the
64 KiB stdout/stderr pipe could fill before it was drained — blocking
cloudflared's log writes and stalling it *before* it opened the edge
connection. The tunnel never registered and `start()` timed out after 30s
with an opaque error, even though the network and credentials were fine.

Both providers now redirect cloudflared's stdout+stderr to a log file
(writes never block) via a shared `spawnCloudflaredUntil` helper, and
surface the captured output tail when start fails — so a stalled or crashed
cloudflared is diagnosable instead of a black box.
