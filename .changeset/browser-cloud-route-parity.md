---
"@agentproto/runtime": patch
---

fix(browser): HTTP route `POST /sessions/browser` now forwards `location`/`baseUrl`/`binPath` to `adapter.ensure()` (parity with MCP `start_browser`); `registerBrowser` includes `location` in the dedup key so a cloud call never returns a pre-existing local session
