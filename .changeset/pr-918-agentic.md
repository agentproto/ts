---
"@agentproto/runtime": patch
---

Add `conversation_locate` MCP tool for bidirectional session ↔ native-transcript lookup, enabling both forward (sessionId to native path) and reverse (native path to sessionId) queries. Also implement graceful fallback to daemon events when native transcripts are missing.
