---
"@agentproto/cli": minor
---

New `agentproto host health`: a verdict on whether the host can take more agents. It prints `OK`, `WARN` or `CRIT` with the reasons, then a table of checks (load per core, RAM and swap pressure, daemon reachability and uptime, live and busy sessions, orphan processes, free disk under the sessions dir), and exits 0, 1 or 2 so cron and scripts can gate on it. Thresholds are named constants (`DEFAULT_HEALTH_THRESHOLDS`) with `--warn-*` / `--crit-*` overrides such as `--warn-load` and `--crit-load`. It supports `--json`, `--watch`, `--local` and `--no-color`, reuses the `host load` sampler (daemon first, in-process fallback), and stays read-only. An unreachable daemon is CRIT but the other checks are still reported.
