---
"@agentproto/runtime": patch
---

`GET /sessions/:id/screencast.jpg` serves the latest Bureau recording frame of a tab owned by session `:id` when `:id` is not a chrome-live browser descriptor (that path is retired). The daemon calls Bureau as `:id`, so Bureau's tab ownership decides what is visible and a link only sees its own session's tabs. No tab, no frame, or Bureau unreachable all answer the same 404 `no_screencast_frame`.
