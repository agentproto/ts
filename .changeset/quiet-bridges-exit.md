---
"@agentproto/cli": patch
---

fix(cli): stop `agentproto mcp-bridge` from outliving its stdio host

The bridge parked forever and ignored stdin EOF, so a killed host left one orphaned bridge per session (ppid 1, ~35 MB each) until the machine swapped (45 orphans / ~4 GB observed). It now exits when stdin closes, when the stdio transport closes, or, on POSIX, when it is reparented because its parent died — even when the stdio pipe stays open.
