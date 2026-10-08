# `agentproto host`

Two read-only verbs: [`host load`](#agentproto-host-load), the human report on why a
machine is slow, and [`host health`](#agentproto-host-health), a verdict on whether
it can take more agents.

## `agentproto host load`

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

## `agentproto host health`

```text
agentproto host health [--json] [--watch <seconds>] [--budget <ms>] [--local]
                       [--no-color] [--warn-load <x>] [--crit-load <x>] [...]
```

Answers "is this host OK to spawn more agents?" in a few lines, and is meant to
be called from cron or scripts. The first line is the verdict and the reasons;
a compact table of every check follows.

```text
WARN  load 2.6x per core on 12 cores; 11 orphan processes (ppid 1)

CHECK         STATUS  VALUE          WARN   CRIT
load          WARN    2.60x per core >=2x   >=4x
ram           OK      41.2% avail    <15%   <5%
swap          OK      12.0% used     >=50%  >=85%
daemon        OK      up 3d          <60s   -
sessions      OK      9 live         >=30   >=60
busy          OK      3 busy         >=8    >=16
orphans       WARN    11             >=10   >=30
busy orphans  OK      0              >=1    >=5
disk          OK      212 GB free    <10 GB <2 GB
```

**Exit codes:** `0` OK, `1` WARN, `2` CRIT. A host that cannot be sampled at all
also exits `2` (fail safe). A usage error (bad flag or value) exits `64`, so it
cannot be mistaken for a verdict. With `--watch` the exit code is the last
verdict.

### Checks and default thresholds

A limit trips when the value is **at or above** it (load, swap, counts) or
**below** it (RAM available, uptime, disk free). The defaults live in one place,
`DEFAULT_HEALTH_THRESHOLDS` in `packages/cli/src/commands/host-health.ts`; the
load and swap limits are the daemon's own `host_load` limits.

| Check | WARN | CRIT | Flags |
|-------|------|------|-------|
| `load`: 1-minute load / cores | `>= 2` | `>= 4` | `--warn-load` `--crit-load` |
| `ram`: available / total (free + reclaimable) | `< 15%` | `< 5%` | `--warn-mem` `--crit-mem` |
| `swap`: used percent | `>= 50%` | `>= 85%` | `--warn-swap` `--crit-swap` |
| `daemon`: `GET /health` | uptime `< 60 s` (just restarted) | unreachable | `--warn-uptime` |
| `sessions`: live agent sessions | `>= 30` | `>= 60` | `--warn-sessions` `--crit-sessions` |
| `busy`: live sessions mid-turn | `>= 8` | `>= 16` | `--warn-busy` `--crit-busy` |
| `orphans`: processes reparented to init | `>= 10` | `>= 30` | `--warn-orphans` `--crit-orphans` |
| `busy orphans`: the `orphan` warnings of `host_load` (old and busy) | `>= 1` | `>= 5` | `--warn-busy-orphans` `--crit-busy-orphans` |
| `disk`: free space where the sessions dir lives | `< 10 GB` | `< 2 GB` | `--warn-disk` `--crit-disk` (GB) |

Overrides must stay ordered (`--warn-load` at most `--crit-load`, `--warn-mem`
at least `--crit-mem`, and so on). A check with no data (no swap probe, or
`--local` for the daemon and session checks) shows `SKIP` and never changes the
verdict.

If the daemon is unreachable the verdict is `CRIT`, but the other checks are
still reported from an in-process sample (the same fallback `host load` uses),
with a note under the verdict.

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | off | `{verdict, exitCode, sampledAt, reasons[], checks[], thresholds}`; each check has `id`, `label`, `status`, `value`, `unit`, `display`, `threshold` and `detail` |
| `--watch <s>` | off | Re-check every `<s>` seconds; with `--json`, one JSON object per line |
| `--budget <ms>` | 1900 | Time budget for the sample, at least 300 |
| `--local` | off | Skip the daemon: no daemon check, no session counts |
| `--no-color` | off | Plain output |

Read-only: it needs no sudo and never kills or changes anything. The session
counts come from `GET /sessions`, the daemon check from `GET /health`, and the
rest from the `host_load` report.
