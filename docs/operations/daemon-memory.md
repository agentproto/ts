# Daemon memory: investigation and operating recommendations

Measured on macOS, Node 22.22.0, 2026-10-12. Measurements below use different
metrics deliberately: RSS is resident RAM; footprint includes memory macOS
has compressed/paged out. Do not sum RSS and compressed memory.

## Findings

- `host load` added macOS `top` MEM and CMPRS. `man top` defines MEM as physical
  footprint already. The reported 4.6 GB therefore double-counted compressed
  memory; a direct `vmmap` sample measured about 2.9 GB. The parser is corrected.
  Confirmed against this machine's installed manual and Apple's published
  [top manual](https://github.com/apple-oss-distributions/top/blob/main/top.1):
  MEM denotes physical footprint. Apple's [XNU ledger definition](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/task.c#L1226-L1233)
  includes compressed-memory terms in that footprint. CMPRS is a separate
  diagnostic column, not an extra amount to add to MEM.
- Seven to eight live agent trees used about 3.2 GiB RSS. Each Claude session
  brought its own adapter and several MCP processes. Idle does not mean free.
- A later pre-activation snapshot had five idle agent trees: 43 processes and
  2.397 GB RSS, plus 0.839 GB daemon RSS (decimal units). Four ordinary sessions
  used 0.429–0.563 GB each, including six to eight Node processes and a separate
  Replicate MCP launcher. The keepAlive session used 0.369 GB with four processes.
  This is why a handful of idle sessions can cost gigabytes; the VS Code row
  count alone is not a useful RAM estimate. This snapshot followed the diagnostic
  restart and is separate from the original 2.9 GB daemon-footprint measurement.
- Five old orphan process trees contained thirteen processes, about 330 MiB RSS:
  development servers and Cloudflare tunnels. No surviving duplicate Claude/ACP
  trees were found after the observed restart. These servers may intentionally
  outlive their creating session; do not blindly kill everything with PPID 1.
- Adapter discovery imports implementations, not just manifests. In an isolated
  cold process, listing 15 installed adapters took about 1.6 seconds and increased
  RSS from 171 MB to 411 MB and live heap from 41 MB to 162 MB. It loaded ONNX,
  DuckDB, tokenizers and SQLite native modules. A daemon that merely lists harnesses
  does not need to retain these libraries.
- The new short-lived discovery worker returned the merged 20-entry listing twice
  in about 3.2–3.5 seconds per cold probe. Parent RSS remained about 176 MB and its
  heap about 41 MB; none of the above ML/DB native modules loaded in the parent.
  This is an isolated probe, not a measured reduction for the production daemon.
- V8 GC was active. A live post-restart probe dropped RSS from 741 MB to 503 MB
  after collection, but live heap only from 441 MB to 384 MB. There is genuine
  retained state as well as collectible allocations. These observations do not
  establish an object-level leak or explain all native allocations.
- Replay history previously bounded only line count (500), allowing large strings
  to accumulate across historical session rows. It now bounds UTF-16 payload to
  512K code units (~1 MiB), with a 32K-code-unit suffix per oversized line. Original
  live lines and durable transcript events are preserved.

## Implemented controls

Discovery runs in an IPC child process that exits after returning metadata. The
parent caches adapter listings for 60 seconds and capability/model results for
5 seconds, coalesces identical requests, runs only one discovery worker at a time,
caps pending requests and retained cache entries at 32, and
invalidates on adapter installation. Failed probes are not cached; workers time
out after 30 seconds. Actual agent starts still resolve the requested adapter.
This trades cold discovery latency and transient worker RAM for lower retention
from these three discovery endpoints. Build/install changes can take up to the
listing TTL to appear. Adapter-carried role discovery and third-party tunnel/
sentinel discovery still import adapter implementations in the host; isolating
the CLI listings does not remove those separate import paths.

The bundled CLI resolves the worker beside `dist/cli.mjs` (or `dist/index.mjs`).
A TypeScript source caller resolves `packages/cli/dist/adapter-discovery-worker.mjs`
instead of looking for an absent `.mjs` beside `src/registry/isolated-discovery.ts`.
Source execution requires `pnpm --filter @agentproto/cli build` first;
`pnpm --filter @agentproto/cli dev` uses tsup watch to keep the worker current.
A missing build produces an explicit build/reinstall error. The worker remains
compiled JavaScript with empty `execArgv`, rather than copying the parent's
loader/inspector arguments. Path tests cover both bundle entries and source execution; a real
source-mode test verifies the fork/IPC/exit round trip.

`daemon.resumeSessionsOnBoot` remains the master enable switch. The additive
`daemon.bootResumePolicy` selects `all` (legacy default) or `keepalive`. Use:

```sh
agentproto config set daemon.bootResumePolicy keepalive
```

Only explicit `keepAlive: true` sessions then eagerly resume. Other sessions
remain resumable when prompted. The separate `continueInterruptedOnBoot` opt-in
also respects this policy when sending automatic continuation prompts. Manual
continuation remains available for other sessions. Config takes effect on
next daemon start. KeepAlive also exempts a session from idle reaping (including
the sandbox reap, [`daemon.sandboxIdleReapAfterMs`](../cli/verbs/config.md#sandbox-idle-reap)).

Because `keepAlive` sessions are never idle-reaped, a finished one would
otherwise be respawned on every daemon restart forever. The boot pass therefore
stops eagerly resuming a `keepAlive` session that has been idle longer than
`daemon.bootResumeKeepAliveMaxIdleMinutes` (default `30`, measured from its last
turn-end; `0` disables the cutoff). The row is not killed, archived or changed:
it stays dead-but-lazy-resumable, and its next prompt or an explicit
`session_restart` brings it back. Pinned sessions and sessions carrying an
operator-assigned `operatorLabel` (the persistent brains and PMs, e.g.
`pygmalion-brain-persistent`) are exempt and always resume. A session marked
completed through `session_mark_completed` (or the `operator-completed` close
path) also drops its `keepAlive` flag and is never eagerly resumed.

```sh
agentproto config set daemon.bootResumeKeepAliveMaxIdleMinutes 30
```

HTTP `/health` and MCP `daemon_health` now expose `bootResumePolicy` and a
`memory` object with Node RSS, heapUsed, heapTotal, external and arrayBuffers.
These counters are not a macOS footprint/native-allocation breakdown. External
and arrayBuffers overlap; do not add them. No automatic explicit-GC loop is added.

## Further recommendations, in order

1. Record health counters and process-tree RSS every minute through representative
   turns, idle periods and builds. Compare post-GC plateaus in a controlled test
   process, not a repeated forced-GC loop in the production daemon. A rising
   plateau distinguishes retained objects from transient allocation pressure.
2. Make adapter manifests/generated metadata the discovery source of truth,
   including adapter-carried roles and provider-family classification. This
   would remove the discovery worker's cold imports entirely while preserving
   runtime resolution/credential checks on actual start. Do not report readiness
   from package presence alone: broken exports and missing credentials still matter.
3. Put native ML/DB providers behind lazy imports and disposable worker boundaries.
   Bound their lifetime/idle retention and concurrency. Loading a native binary is
   not evidence a model is loaded, but it should not happen for unrelated CLI work.
4. Audit retained session runtime state, newline-free text/thought assembly,
   transcript export/search caches and request/server lifecycle. Use byte budgets
   and lifecycle eviction, not only counts. Full transcript reads and stringify
   operations can create large temporary copies even when retained rings are small.
5. Reduce per-agent MCP fan-out by declaring only the capabilities needed by that
   role. Pool servers only where their transport and identity isolation explicitly
   allow sharing. A shared daemon cannot automatically make every stdio MCP safe
   to share between agents.
6. Reconcile orphan process ownership using session markers plus PID start times.
   Offer a reviewable cleanup command and explicit persistent-service exemption.
   Do not treat every detached listener or dead-parent subagent as disposable.

## Investigation limitation

An initial profiler cleanup expression used an unsupported dynamic import and
caused an unhandled rejection in the daemon. Automatic restart recovered five
sessions; one active turn was interrupted. This is not evidence of a pre-existing
memory crash. Subsequent diagnostics closed the inspector without dynamic imports.
No full heap snapshot was taken, so no particular retained object graph is claimed
as the cause of the full 2.9 GB footprint.

## Local activation result

The full build, full workspace type checking and full workspace test gate passed.
Tests used `VITEST_MAX_WORKERS=1` and `NODE_OPTIONS=--no-experimental-webstorage`
to avoid an existing jsdom/global-localStorage conflict in this machine's Node
environment. Runtime: 536 files, 6,960 passed tests; CLI: 137 files, 1,686 passed
tests (both also have two intentionally skipped tests).

Activated locally with a graceful daemon stop/start and the keepalive boot policy.
After startup, only the persistent session was live. Managed process-tree RSS
was 1.290 GB across five processes, versus 3.237 GB across 44 before activation:
daemon 0.644 GB, persistent session 0.647 GB while doing work. A native sample
measured 519.5 MiB daemon footprint. These are immediate snapshots with changed
session activity, not a controlled attribution of savings to each code change
or proof that a leak cannot recur.

The production daemon still had ONNX, DuckDB and tokenizer libraries loaded.
Role registry discovery imports every discovered adapter; third-party tunnel
and sentinel discovery also import packages before checking their family.
Manifest-first discovery therefore remains the next concrete architectural fix.
Two already-running development-server trees (about 246 MB RSS) became classified
as orphans once their owning session rows stopped. Their processes predate this
activation; they were preserved alongside the five previously reported detached
trees. No old Claude/ACP session tree remained live after shutdown.
