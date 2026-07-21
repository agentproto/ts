---
"@agentproto/runtime": patch
---

Harden loopback auth bypass by checking the entire family of proxy forwarding headers (not just X-Forwarded-For), closing a gap where proxies that strip XFF but set X-Real-IP / CF-* headers could bypass auth. Add explicit warning for unauthenticated passthrough tunnels so the exposure is surfaced to users instead of buried in prose.
