---
"@agentproto/runtime": patch
---

Fix: Gate /mcp endpoint against cross-origin browser drive-by attacks. Malicious web pages could previously fetch http://127.0.0.1:<port>/mcp and drive shell + filesystem tools via the loopback bypass in auth mode "none". Now the endpoint rejects untrusted cross-origin browser requests (identified by the Origin header) unless they present a valid bearer token. Native MCP clients and trusted localhost dev origins remain unaffected.
