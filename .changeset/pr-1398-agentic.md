---
"@agentproto/runtime": patch
---

fix(runtime): require the tunnel bearer on every non-loopback route — a forged `Origin` no longer grants tunnel access; `/health`, `/inbound/:slug` (HMAC), and `GET /apps/:appId/ui` remain exempt.
