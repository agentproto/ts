---
"@agentproto/runtime": patch
"agentproto-desktop": patch
"agentproto-vscode": patch
---

Fix transcript debounce-split bug where mid-word fragments split by interleaved tool-call records would create artificial paragraph breaks. Adds `partial` flag to track explicitly unterminated flushes and updates reducers to rejoin text-delta records that haven't reached newline termination, keeping sentences coherent across tool interactions.
