---
"@agentproto/runtime": patch
---

The HTTP `/cron` write routes (`POST /cron`, `PATCH`/`DELETE /cron/:id`, `POST /cron/:id/run`) now require the same credential as the mutating `/sessions/*` routes: the per-boot bearer token or an allowlisted Origin. A foreign browser Origin without the bearer is refused with 403, and `POST`/`PATCH` must send `content-type: application/json` (415 otherwise), so a cross-origin `text/plain` request cannot create or fire a job. `GET /cron`, `GET /cron/:id` and `GET /cron/runs` stay open like the other read routes. `scripts/smoke-local-daemon.mjs` now sends the token on its `/cron` calls.
