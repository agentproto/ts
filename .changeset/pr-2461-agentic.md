---
"@agentproto/cli": patch
"@agentproto/runtime": patch
---

Host guard no longer kills work in flight: it reaps idle sessions instead.

- `agentproto host guard` (and the thin `scripts/host-guard.mjs` cron wrapper) now closes a session through a new `POST /sessions/:id/reap` route instead of `/kill`, so the row is tagged `guard-reaped` (not `operator-stopped`) and stays lazy-resumable.
- New `work-in-flight` and `child-alive` refusals: a dirty/unpushed/unknown worktree or a live `fix-pr*|exec-*|diag-*|fix-*` session younger than 2 h is never reaped; git probes are bounded to 2 s and any failure keeps the session.
- The CRIT idle window now has an absolute 900 s floor.
- `guard-reaped` is a known end reason and a deliberate end, so no automated pass (including eager resume-on-boot) revives it.
