---
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

Joined CI hosts now report real liveness and are cleaned up. Every successful contact bumps `lastSeen` (persisted throttled) and `online` covers an active channel or a contact within the 2 min grace; joined hosts are probed in the background with bounded concurrency and exponential backoff (never giving up), resumed after a daemon restart, and record `lastProbeAt`/`lastError`. A joined host unreachable past a TTL (default 2 h, `AGENTPROTO_HOST_ENDED_TTL_MS`) or that says goodbye is marked `ended` and hidden from `device_list` / `GET /devices` / `devices list` unless `includeEnded` / `--include-ended`; ended hosts are deleted after a retention (default 7 d, `AGENTPROTO_HOST_ENDED_RETENTION_MS`). Manually added hosts and client devices are never ended or deleted (a manual host past the TTL only shows `stale`). The sweep runs every 60 s in `agentproto serve`.
