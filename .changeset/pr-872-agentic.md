---
"@agentproto/runtime": minor
---

Add `injectMcpAppBridge()` function to inject MCP Apps wire protocol bridge into UI app HTML at serve time. The bridge enables all app panels to communicate with the host via postMessage JSON-RPC without requiring each app to ship its own shim. Cache integration ensures injection runs once per (path, version) rather than on every request.
