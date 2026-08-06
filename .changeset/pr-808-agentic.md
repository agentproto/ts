---
"@agentproto/cli": patch
---

Enhance CLI daemon discovery documentation with comprehensive explanation of the layered fallback strategy (env override → home runtime.json → central registry → workspace runtime.json), PID liveness checks for stale file detection, and known limitation regarding restart handoff windows. Updates help text in `browser`, `presets`, `sessions`, and `tunnel` commands to reference the full discovery order.
