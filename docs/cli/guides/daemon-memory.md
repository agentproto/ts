# Find out why your daemon looks big

Status: Stable

Your Activity Monitor (or `top`, or `ps`) shows the agentproto daemon using
more memory than you expected. This guide walks you from the cheap reads to a
heap snapshot: first decide whether the daemon actually **holds** that memory
or only has not collected it yet, then find which part of it grows, then turn
the knobs that bound it.

The commands below assume the default port, `18790`. If you started the daemon
with `agentproto serve --port <n>`, use that port instead.

## 1. Read the current numbers

`/health` returns the daemon's `process.memoryUsage()` as a `memory` object,
in bytes:

```bash
curl -s http://127.0.0.1:18790/health | jq '{version, build, uptimeMs, memory}'
```

From an agent, the MCP tool `daemon_health` returns the same `memory` object.

| Field | Meaning |
|-------|---------|
| `rss` | Resident memory of the daemon process. Not its child processes. |
| `heapUsed` | JavaScript heap in use, **including garbage V8 has not collected yet**. |
| `heapTotal` | Heap V8 has reserved. |
| `external` | Memory of C++ objects bound to JavaScript objects. |
| `arrayBuffers` | Buffers and ArrayBuffers. Already counted in `external`: do not add them. |

None of these is a full native or OS footprint, and none of them covers the
agent processes the daemon spawns. Each live agent session runs its own
adapter and MCP processes, so a few idle sessions can cost more than the
daemon itself. If the process tree is what is big, skip to
[step 6](#6-bound-the-number-of-live-sessions).

## 2. Find the `[heap]` lines

Every 5 minutes (the first one 5 minutes after boot) the daemon writes one
`[heap]` line to its log. A daemon installed with `agentproto daemon install`
logs to `~/.agentproto/daemon.log`; a foreground `agentproto serve` prints it
on stdout.

```bash
grep '\[heap\]' ~/.agentproto/daemon.log | tail -n 12
```

One line looks like this (wrapped here, one line in the log):

```text
[heap] heapUsed=1457MB heapTotal=1573MB rss=2458MB external=59MB arrayBuffers=11MB
  afterMajorGc=398MB@2026-11-02T20:11:01.097Z majorGcs=38
  handles=TCPSocketWrap:44,PipeWrap:43,Timeout:23,ProcessWrap:20,TCPServerWrap:3
  sessions=total:1030,live:14 policies=total:118 workflowRuns=total:501 eventsIndexCache=entries:2
  hosts=hosts:452,pollers:1,inFlight:0,snapshots:1,snapshotOutputs:2,snapshotBytes:27964,cachedBodies:1,cachedBodyBytes:27619,handshakeFailures:1
  pairing=pairings:0,revoked:6,offers:0,loops:12,channels:0,online:0,localDevices:0
```

- The five memory fields and `afterMajorGc` are in MiB (1024 x 1024 bytes,
  rounded), printed with an `MB` suffix.
- `afterMajorGc` is `heapUsed` measured right after the last major
  (mark-compact) GC, with the time of that GC. It reads `none` until the first
  major GC. `majorGcs` counts them since boot.
- `handles` counts the live handles by type (timers, sockets, pipes, child
  processes), largest first.
- Every other field is one owner of long-lived state, as `name=key:value,...`:

| Field | What it counts |
|-------|----------------|
| `sessions` | `total`: session rows, archived included. `live`: rows `running` or `starting`. |
| `policies` | Completion policies held by the supervisor. |
| `workflowRuns` | Workflow runs held by the runner. |
| `eventsIndexCache` | Cached `events.jsonl` indexes. |
| `hosts` | The host registry: hosts, pollers, in-flight forwards, snapshots (count, outputs, bytes), cached session bodies (count, bytes), handshake failures. Only when the daemon runs a host registry. |
| `pairing` | The pairing registry: pairings, revoked, offers, loops, channels, online, local devices. Only when the daemon runs a pairing registry. |

A probe that fails prints `<name>=error` instead of breaking the line.

To follow the floor alone:

```bash
grep '\[heap\]' ~/.agentproto/daemon.log | grep -o 'afterMajorGc=[^ ]*' | tail -n 24
```

## 3. Read the floor, not `heapUsed`

`heapUsed` counts everything V8 has allocated and not yet collected. Under a
large `--max-old-space-size`, V8 can let garbage pile up for a long time before
a major GC, so `heapUsed` and `rss` swing by gigabytes while the daemon holds
much less. In the line above, `heapUsed` is 1457 MB but the floor after the
last major GC is 398 MB.

Compare `afterMajorGc` across lines taken hours apart:

- **Flat floor, big swings in `heapUsed`.** Transient allocation. Nothing is
  leaking. The swings still cost real pages on a host that is short on memory;
  if that is your case, look at what the daemon was doing at the peaks (a large
  rollup, a transcript export, a brain query).
- **Rising floor and a count that rises with it.** That count names the owner.
  `sessions=total` climbing with the floor means rows are piling up;
  `handles` with one type climbing means a timer or socket is not released.
  Put both series in your issue.
- **Rising floor, every count flat.** Something nobody counts yet is retaining
  memory. That is when a heap snapshot is worth its cost (step 5).

## 4. Read the same report on demand

`GET /debug/heap` serves the report behind the `[heap]` line as JSON, without
waiting for the next line. Memory values are in bytes here, and `handles` is
not sorted.

```bash
curl -s http://127.0.0.1:18790/debug/heap | jq '{afterMajorGc, majorGcs, handles, structures}'
```

From the same machine, a call without an `Origin` header needs no token. From
anywhere else, send the daemon bearer (see the next step). A call made as a
session the daemon spawned is refused with `403 operator_only`.

## 5. Take and compare heap snapshots

`POST /debug/heap-snapshot` writes a V8 heap snapshot of the daemon. Know the
cost before you run it:

- **It blocks the daemon's event loop** until the file is written: seconds per
  GB of heap. No request, session event or timer runs meanwhile. Pick a quiet
  moment.
- **It needs free memory.** It refuses with `507 insufficient_memory` when free
  memory is below `heapUsed` plus 256 MiB. Free memory is `os.freemem()`, capped
  by `memory.max - memory.current` under a cgroup v2 limit. On macOS
  `os.freemem()` leaves out reclaimable inactive pages, so the guard errs on the
  safe side.
- **It needs disk.** The file is about the size of the heap. Files go to
  `~/.agentproto/heap-snapshots/` and are never deleted for you.
- **It contains secrets.** A heap snapshot holds every string the daemon has in
  memory, tokens and provider keys included. Do not attach one to a public
  issue.

The route takes the daemon bearer and nothing else. The daemon writes a fresh
token at each boot to the `token` field of `~/.agentproto/daemons/<port>.json`
(and of `<workspace>/.agentproto/runtime.json`), mode 0600. Read it inline so
it never lands in your shell history:

```bash
curl -s -X POST http://127.0.0.1:18790/debug/heap-snapshot \
  -H "Authorization: Bearer $(jq -r .token ~/.agentproto/daemons/18790.json)" | jq
```

The answer carries `path`, the absolute path of the file (named like
`heap-2026-11-02T20-11-01-097Z-12345.heapsnapshot`),
`heapUsed`, `freeBytes`, `durationMs` and a `warning`. Without the bearer the
route answers `401 unauthorized`; a failed write answers `500 snapshot_failed`.

One snapshot rarely names a leak. Take two, an hour or more apart, while the
floor is rising, then compare them in Chrome DevTools (or any viewer that reads
V8 `.heapsnapshot` files):

1. Open DevTools on any page, **Memory** tab, **Load** both files.
2. Select the later snapshot and switch the view to **Comparison** against the
   earlier one.
3. Sort by **Size Delta**. The constructors that grew are the candidates; the
   **Retainers** pane shows what keeps them alive.

## 6. Bound the number of live sessions

The daemon's own heap is often not the biggest cost: every live agent session
keeps its own process tree. Two settings decide how many come back after a
daemon restart. Both take effect on the next daemon start.

`daemon.resumeSessionsOnBoot` (default off) turns on the automatic boot resume.
When it is on, `daemon.bootResumePolicy` picks what it brings back: `all`
(default) or only `keepalive` sessions. Every other session stays resumable on
its next prompt.

```bash
agentproto config set daemon.bootResumePolicy keepalive
```

`keepAlive` sessions are never idle-reaped, so a finished one would come back
on every restart. `daemon.bootResumeKeepAliveMaxIdleMinutes` (default `30`,
measured from its last turn-end, `0` disables it) stops resuming a `keepAlive`
session idle for longer than that. The row is not killed or changed: its next
prompt or a `session_restart` brings it back. A pinned `keepAlive` session is
exempt from the cutoff.

```bash
agentproto config set daemon.bootResumeKeepAliveMaxIdleMinutes 30
```

While the daemon runs, `daemon.idleReapAfterMs` (default off) retires idle
sessions, and `daemon.sandboxIdleReapAfterMs` does the same for sandboxed ones;
`keepAlive` sessions are exempt from both. See
[`config`](../verbs/config.md#common-keys). To list the `keepAlive` sessions
that are alive right now, run `agentproto sessions report`; an agent can clear
one's flag with the MCP tool `session_set_keepalive`.

To check the effect, compare `sessions=...,live:` and `/health` before and
after the next restart.

## 7. What to put in an issue

- `version`, `build` and `uptimeMs` from `/health`, your OS, and the daemon's
  `--max-old-space-size` if you set one.
- The `[heap]` lines that cover the growth, at least an hour of them, unedited.
- One `GET /debug/heap` output taken at the end.
- What the daemon was doing: how many sessions, which harnesses, any app, rollup
  or export you ran around the peaks.
- If you took snapshots: the top rows of the Comparison view and the retainer
  chain of the biggest one, as text or a screenshot. Not the `.heapsnapshot`
  files themselves.

## See also

- [`daemon`](../verbs/daemon.md): install, start, stop, `logs`.
- [`config`](../verbs/config.md): every `daemon.*` key.
- [`docs/operations/daemon-memory.md`](../../operations/daemon-memory.md): the
  investigation history behind these controls.
