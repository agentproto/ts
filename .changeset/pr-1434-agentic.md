---
"@agentproto/runtime": patch
---

Harden remote-provider file permissions (tunnel config and cloudflared log files are now owner-only, 0o600) and lower quick-tunnel log level from debug to info to avoid leaking Authorization headers and token query params into logs. Also deduplicate SSE response headers into a shared helper that adds `x-accel-buffering: no` to all SSE routes.
