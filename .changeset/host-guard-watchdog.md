---
"@agentproto/cli": minor
---

`agentproto host guard`: deterministic periodic host watchdog. On `host health` WARN it closes the oldest already-idle sessions (never busy, keepAlive, pinned, waiting, watched, or ancestor of a live session), just enough to fall back under the sessions threshold; on CRIT it sweeps harder, writes a marker that makes `agentproto workflow start|run-file` refuse to start workflows (override with `--force`) until the host recovers, and — after the cleanup pass, never before — escalates to a brain session or a fresh agent. Includes `--dry-run`, JSONL logging, and a bootstrap `scripts/host-guard.mjs` for cron use.
