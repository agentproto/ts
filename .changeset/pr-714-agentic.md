---
"@agentproto/runtime": patch
---

Add push-ingress (`POST /inbound`) and transmitter binding store for bidirectional contact routing. Introduces `inbound-router` shared logic for both poll and push ingress, `transmit_message` MCP tool for sending messages via imported agentpush aliases, and persistent bindings to route inbound replies into sessions. Modes: "spawn" (always new), "route" (bound sessions only), "route-or-spawn" (bound sessions or fallback spawn).
