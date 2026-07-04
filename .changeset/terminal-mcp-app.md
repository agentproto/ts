---
"@agentproto/runtime": minor
---

Add `agentproto_terminal`, an interactive terminal MCP App: exposes a live PTY/shell session to a sandboxed iframe over a WebSocket straight from the daemon (query-string token for browser compatibility), with a self-contained ANSI→HTML UI, line-buffered input, and a Ctrl-C signal. Registration is gated by `spawnPty`; per-resource CSP (`connectDomains`) lets the iframe allowlist the exact WS origin. `AGENTPROTO_PUBLIC_WS_ORIGIN` overrides the WS base URL when the daemon sits behind a public tunnel.
