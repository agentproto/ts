---
"@agentproto/runtime": patch
---

`GET /sessions/:id/screencast.jpg` serves a Bureau `browser_screenshot` (JPEG, quality 55) of the newest open tab owned by session `:id` instead of `browser_record_frame`, so it no longer needs a recording that Bureau kills after 10 minutes, nor any cooperation from the agent. Each frame is a real capture of the browser, so frames are cached per session for 800 ms, concurrent requests of one session share one capture, and at most 2 captures run at once daemon-wide. A tab that errors (`target_gone`) is skipped for the next one and drops the tab list cache. The 200 now carries `content-length`; a miss answers the 404 `no_screencast_frame` with the message "No open browser tab for this session.".
