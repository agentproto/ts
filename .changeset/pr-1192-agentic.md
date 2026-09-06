---
"@agentproto/runtime": patch
---

Enable transcript export for command sessions. Command sessions now export as proper assistant tool-call + tool-result messages instead of empty transcripts. Adds kind-less CommandLogEntry detection and rendering logic, title fallback chain (label > command > default), and explicit tool-call-record skipping to prevent double-counting.
