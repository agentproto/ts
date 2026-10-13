---
"@agentproto/runtime": minor
"@agentproto/sandbox-e2b": minor
---

Sandbox sessions survive a box that dies outside `close()`. The host now checkpoints a box's work branch periodically (every 5 min, `AGENTPROTO_SANDBOX_CHECKPOINT_INTERVAL_MS`, `0` = off) and at each turn end: it pushes `wt/<slug>` when ahead and force-pushes a snapshot of uncommitted work (built through a throwaway index) to `agentproto-checkpoint/wt/<slug>`, falling back to a host-side `checkpoint.bundle`. A watchdog probes the box daemon's `/health` and, after 3 failed or 10 unanswered probes, takes a last checkpoint and marks the session crashed so it can be restarted. `session_restart` on a session whose box is gone now boots a fresh box, re-clones the workspace remote, checks out the pushed branch and re-applies the snapshot, instead of failing. The e2b provider enables a 4 GiB swap file on fresh boots (`config.swapMb`, `0` = off).
