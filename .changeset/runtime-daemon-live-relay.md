---
"@agentproto/runtime": minor
---

Relay a session's Bureau live browser stream over the daemon. `GET /sessions/:id/live.mjpeg` picks the newest open tab Bureau lists as owned by `:id` (like `screencast.jpg`), calls `browser_live_view` as `:id` with `reuse: true`, and pipes the MJPEG verbatim with an `x-live-stream-id` header. `GET|HEAD /sessions/:id/live/:streamId/replay.mp4` relays the kept video of one of the last 5 streams relayed for that session, passing the `range` header through. Both routes use the screencast gate (daemon bearer, or a link token whose `sessionId` / `browserSessionId` claim is `:id`), accept only loopback Bureau URLs and never expose them, answer one uniform `404 no_live_stream` on any miss, never stop the stream, and cap relays at 3 per session and 12 per daemon (`429 live_relay_busy`).
