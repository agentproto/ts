---
"@agentproto/runtime": minor
---

Session-follow: a session can now follow other sessions it did not spawn and be woken when they end a turn, await input, exit, crash, or get a PR opened/merged. New `session_follow` / `session_unfollow` / `session_follows` MCP tools and `POST|GET /follows`, `DELETE /follows/:idOrKey` routes; follows persist in `~/.agentproto/follows.json`. Events are coalesced per follower (`batchMs`, default 15s) into one `system`/`notice`/`next-turn` digest that never interrupts a busy follower.
