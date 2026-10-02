---
"@agentproto/mcp-server": patch
---

Stop answering `server/discover` with the unserved 2026-07-28 protocol version. Claude Code 2.1.280 switched to the "modern" era on it, got an invalid `tools/list` and mounted 0 tools; the SDK now answers `-32601` so clients stay on 2025-11-25. `events/*` methods and the `events` capability at `initialize` are unchanged.
