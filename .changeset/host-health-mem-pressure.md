---
"@agentproto/cli": patch
---

`agentproto host health` / `host guard`: swap and RAM are now warnings only. Each caps at WARN on its own; the memory CRIT verdict (which arms the host-guard marker and refuses gates and workflow starts) needs both swap >= 95% and RAM available <= 5% at the same time, reported by a new `mem pressure` check. The default `--crit-swap` moves from 85 to 95 (health only; the runtime `host_load` swap warning is unchanged), and `--crit-swap` / `--crit-mem` now configure that combined limit. Load, daemon, disk and session checks are unchanged.
