---
"@agentproto/mcp-app-host": minor
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

feat(mcp-apps): serve MCP App views from a dedicated sandbox origin, as the MCP Apps spec requires (host and view on different origins, `allow-same-origin`, CSP as an HTTP header). The daemon registers views at `POST /mcp-app-sandbox/views` and serves them on `<token>.sandbox.localhost` (or a dedicated port, or a fixed public hostname via `daemon.mcpAppSandbox`). A sandbox origin is never trusted by the daemon: any request carrying one in `Origin`/`Referer`, and any WebSocket upgrade from one, is refused with 403 whatever the allowlist says, and a sandbox host serves documents only. `mountMcpApp` uses the sandbox origin automatically when the daemon offers one and otherwise falls back to the opaque-origin `srcdoc` (logged as "restricted mode"); new `@agentproto/mcp-app-host/csp` export with `buildSandboxCspHeader`.
