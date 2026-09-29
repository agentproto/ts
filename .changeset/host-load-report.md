---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

feat(host): host-level load report. New `agentproto host load [--full] [--json] [--watch <s>] [--budget <ms>]` prints loadavg vs core count, CPU user/sys/idle, RAM (used/wired/compressor/free) and swap, per-disk transfers/s and MB/s, and the top 10 processes by CPU and by memory footprint (compressed pages included), each tagged with its owning session or `orphan`/`system`, plus a WARNINGS section: swap above 50%, old busy or serving orphans (ppid 1), deleted-cwd processes, filesystem-wide `find`/`bfs`/`du` scans, duplicate servers on one port, load above 4x cores. The same JSON is served by `GET /host/load` and the `host_load` MCP tool (`detail: "summary" | "full"`). macOS uses `vm_stat`, `sysctl`, `iostat`, `top`, `ps`, `lsof`; Linux reads `/proc`; no sudo. Every probe runs under a timeout so the call stays around 2 s on a saturated host, and a slow probe is named in `partial`. The collector (`getHostLoadService`, `createHostLoadService`, `collectHostSample`) is exported from `@agentproto/runtime` for schedulers that gate heavy jobs on host load.
