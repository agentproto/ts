---
"@agentproto/runtime": patch
---

Agent Cards and app UI URLs now keep the public host behind a private tunnel: the link guard forwards the client's Host as `X-Forwarded-Host`, and the request base URL honors it (the configured public origin still wins).
