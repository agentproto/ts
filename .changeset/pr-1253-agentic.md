---
"@agentproto/apps": minor
---

Add a builtin `session-chat` panel: a thin launcher widget that deep-links/frames the installed `@agentik/session-chat` app's standalone UI (install notice when not installed), plus a new `csp.frameDomains` field on `AgnoMcpApp`.

---
"@agentproto/runtime": minor
---

Mount the `agentproto_session_chat` builtin panel and add an `?embed=1` trusted-embedder opt-out for the standalone app-UI host's anti-framing headers.
