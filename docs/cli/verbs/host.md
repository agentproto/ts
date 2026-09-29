# `agentproto host load`

```text
agentproto host load [--full] [--json] [--watch <seconds>] [--budget <ms>]
                     [--fresh] [--local] [--no-color]
```

One-screen report on why a machine is slow. It replaces the hand-run
`top` / `vm_stat` / `iostat` / `ps` / `lsof` session with one command that
also names the agent session behind each heavy process. Read-only: it needs no
sudo and never kills anything.

## What it shows

| Section | Content |
|---------|---------|
| `load` | Load average 1/5/15 min against the core count (`= 55.3x per core`) |
| `cpu` | User / sys / idle percent over a 1 s interval |
| `memory` | Used, wired, compressor, cached, free and *available* (free + reclaimable) |
| `swap` | Used of total and percent |
| `disks` | Per disk: transfers/s, MB/s, KB per transfer |
| `WARNINGS` | See below |
| `TOP BY CPU` / `TOP BY MEMORY` | Ten heaviest processes, each with its owner |

`TOP BY MEMORY` ranks by memory **footprint**, not RSS: on macOS that is
resident plus compressed pages (`top`'s `MEM` + `CMPRS`), on Linux it is
`Pss + SwapPss`. A process the footprint probe did not cover falls back to RSS
and is marked `*`.

`--full` adds a per-session rollup (memory, CPU, process count per session) and
the complete process list.

### Owners

| Owner | Meaning |
|-------|---------|
| `sess_xxx (label)` | Descends from that session's adapter process |
| `daemon` | The agentproto daemon and its own children |
| `provisioning` | Worktree provisioning (`pnpm install`, builds) not yet attached to a session |
| `orphan` | Reparented to init (ppid 1), same user, not an OS service. A session that is gone left it behind (`orphan (sess_xxx)` when an adapter-config path names the session) |
| `system` | OS services and installed apps (`/System`, `/Library`, `/Applications`, `*.app`), or another system user |
| `other` | Everything else: your shells, editors, other users |

## Warnings

| Warning | Fires when |
|---------|-----------|
| `swap` | Swap used above 50% (`critical` from 85%) |
| `load` | 1-minute load above 4x the core count |
| `orphan` | An orphan older than 30 min that is using more than 5% CPU, or is a dev server (vite, next, webpack, ...) listening on a port |
| `deleted-cwd` | A process whose working directory was deleted (the classic `node -e mkdirSync(...)` loop) |
| `fs-scan` | `find` / `bfs` / `fd` / `du` / `tree` rooted at `/`, `~`, the home directory, `/Users`, `/home` or `/Volumes` |
| `duplicate-port` | Two or more unrelated processes listening on the same TCP port (workers forked by one parent do not count) |

The orphan rule is a heuristic: a service started under `launchd` by a user
agent (for example a `brew services` daemon) also has ppid 1 and can trip it
when it is busy. The report only names the process; nothing is killed.

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--full` | off | Per-session rollup and every process |
| `--json` | off | Machine-readable report, the same JSON as `GET /host/load` |
| `--watch <s>` | off | Refresh every `<s>` seconds; with `--json`, one JSON object per line |
| `--budget <ms>` | 1900 | Time budget for the sample, at least 300 |
| `--fresh` | off | Bypass the daemon's 2 s cache |
| `--local` | off | Sample in this process instead of asking the daemon (no session attribution) |
| `--no-color` | off | Plain output |

Exit codes: `0` ok, `1` the report could not be produced, `2` bad usage.

## Speed and partial results

The call is bounded (about 2 s by default, even at load 500). Every probe runs
in parallel under its own timeout; one that is missing, denied or too slow is
named on a `partial:` line and the rest of the report still ships. On a
saturated Mac the `top` call that measures per-process footprint can take
10 s or more, so it is usually reported `partial` at the default budget and the
memory ranking falls back to RSS. Pass `--budget 15000` when you want the
footprint on a busy host.

When the daemon is absent or does not answer in time (the situation this verb
exists for), the CLI samples in-process and says so under the header; only
session attribution is lost.

## Platforms

| | macOS | Linux |
|-|-------|-------|
| CPU, disks | `iostat -c 2 -w 1` | two `/proc/stat` and `/proc/diskstats` reads |
| Memory | `vm_stat` | `/proc/meminfo` |
| Swap | `sysctl vm.swapusage` | `/proc/meminfo` |
| Process table | `ps` | `ps` |
| Footprint | `top -l 1 -o mem -stats pid,mem,cmprs` | `/proc/<pid>/smaps_rollup` |
| Listening ports | `lsof -iTCP -sTCP:LISTEN` | `ss -ltnp` |
| Working directory | `lsof -d cwd` plus an existence check | `readlink /proc/<pid>/cwd` |

Other platforms are not covered by dedicated probes: the report falls back to
Node's own load, memory and CPU-count figures and shows the rest as
`unavailable`.

## Other surfaces

- REST: `GET /host/load?detail=summary|full&fresh=true&budgetMs=<ms>` on the
  daemon.
- MCP: the `host_load` tool takes `detail` (`"summary"` or `"full"`), `fresh`
  and `budgetMs`, and returns the same JSON. A subtree-scoped caller sees the
  host metrics plus only its own sessions' processes and warnings
  (`scoped: true`).
- In-process: `getHostLoadService()` (and `createHostLoadService()`,
  `collectHostSample()`) are exported from `@agentproto/runtime`, so a
  scheduler such as the provisioning queue can gate heavy jobs on
  `report.loadPerCore`, `report.swap` or `report.warnings` without shelling
  out. One probe round is shared by all callers within the 2 s cache window.
