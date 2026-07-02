---
"@agentproto/relay": minor
---

Add @agentproto/relay — a standalone companion service that lets one external HTTP webhook wake up exactly one pre-configured agentproto session. Fixed target session baked into startup config (never a request parameter), mandatory bearer token with constant-time comparison, basic rate limiting, and an optional `--tunnel` flag to publish a cloudflared quick tunnel via the daemon.
