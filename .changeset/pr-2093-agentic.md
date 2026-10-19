---
"@agentproto/cli": patch
---

Sync stale CLI docs with shipped behavior: `session_list` bound/filter table (`ids?`, 50-row default + `truncated`/`total`/`nextCursor`), shared-sandbox ATTACHED column and `attachedSessions` refcount, default-on `--turn-retry` semantics for executor/`--sandbox` spawns, and the daemon init-system support matrix (macOS launchd, Linux systemd `--user` with pidfile fallback, Windows Task Scheduler). Docs-only; no code changes.
