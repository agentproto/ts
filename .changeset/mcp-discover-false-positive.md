---
"@agentproto/runtime": patch
---

`session_capabilities`'s `mcpServers[].error` no longer reports a false positive for the daemon's own `/mcp` mount: a harness probing the deregistered `server/discover` method (removed in #1684) and falling back to `initialize`/`tools/list` is normal negotiation, not a failed mount, and a successful `tools/list` now clears any earlier handshake error instead of leaving it stuck in the response.
