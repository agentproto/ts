---
"@agentproto/runtime": patch
---

Gate the chrome-live screencast routes (`GET /sessions/:id/screencast`, `.jpg`, `.mjpg`) behind the per-boot sessions token. They streamed the agent tab's pixels to any caller, including a cross-origin page (CORS answers `*` to an untrusted origin). The HTML viewer carries its `?token=` / `?et=` onto the MJPEG stream URL and HTML-escapes the session id.
