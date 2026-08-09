---
"@agentproto/runtime": minor
---

Add optional `encoding` parameter to `file_read` MCP tool to support base64 encoding for binary files, fixing corruption of binary content (PNGs, audio, video, etc.) that was caused by UTF-8 decoding. Default behavior unchanged — existing callers continue to receive UTF-8 text as before.
