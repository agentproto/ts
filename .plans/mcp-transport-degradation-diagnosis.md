# MCP transport degradation — diagnosis

Diagnosis only. No runtime code is changed by this document or its PR.

Scope: two separate incidents in the same general territory (daemon
behavior under session concurrency). Incident 1 is the `[mcp
transport.onerror] Parse error: Invalid JSON` loop + `ECONNRESET`/`fetch
failed` outage under ~24 concurrent `claude-code` sessions, recovered only
by `launchctl kickstart`. Incident 2 is 4 concurrent `opencode` +
`deepseek/deepseek-v4-flash` sessions each finishing in ~68s with zero
output, then becoming unqueryable before anyone could inspect them.

All file:line references are against this worktree
(`packages/runtime/src/*`, and the vendored
`@modelcontextprotocol/sdk@1.30.0` under
`node_modules/.pnpm/@modelcontextprotocol+sdk@1.30.0_zod@4.4.3/…`).

---

## Incident 1 — MCP transport error loop / ECONNRESET

### 1. What `WebStandardStreamableHTTPServerTransport.handlePostRequest` does on a truncated/malformed body

The daemon imports the **Node.js wrapper** class, `StreamableHTTPServerTransport`,
not `WebStandardStreamableHTTPServerTransport` directly
(`packages/runtime/src/http-server.ts:31`, instantiated at
`http-server.ts:1099-1101`). The stack trace in the incident names
`WebStandardStreamableHTTPServerTransport.handlePostRequest` because the
Node wrapper is a thin shim: its constructor builds a
`WebStandardStreamableHTTPServerTransport` internally and delegates every
method to it (vendored SDK
`.../server/streamableHttp.js:48-160`, doc comment at `:1-8`: *"This is a
thin wrapper around `WebStandardStreamableHTTPServerTransport`… uses
`@hono/node-server` to convert between Node.js HTTP and Web Standard
APIs"*). So the class named in the trace is real code that runs on every
request, just one layer under what the daemon directly constructs.

`handlePostRequest` (`.../server/webStandardStreamableHttp.js:461-509`)
reads the body with `await req.json()` inside its own `try { … } catch`
(`:487-494`). **Any** rejection from that read — a genuine JSON syntax
error, or a stream read failure from a connection reset partway through
the body — is caught generically and re-labeled `"Parse error: Invalid
JSON"`:

```js
try {
    rawMessage = await req.json();
}
catch {
    this.onerror?.(new Error('Parse error: Invalid JSON'));
    return this.createJsonErrorResponse(400, -32700, 'Parse error: Invalid JSON');
}
```

This directly supports the working hypothesis: a truncated body (client
disconnect / `ECONNRESET` mid-request) surfaces here with the exact same
message as a syntax error — the two are indistinguishable from the log
line alone. Nothing after this point re-throws; the method returns a
`Response` object (a normal 400), and the whole `handlePostRequest`
call sits inside the SDK's own outer `handleRequest` try/catch
(`.../webStandardStreamableHttp.js:698`, generic `'Parse error'` fallback).
**A malformed/truncated POST does not throw past `handlePostRequest`. It
resolves to a 400 response for that one request.** It does not crash the
transport instance, the `McpServer`, or the HTTP server.

### 2. Connection limits / body size limits / backpressure on the daemon's HTTP server

None exist for `/mcp`. The daemon's server is a bare
`node:http.createServer` (`http-server.ts:24,1508`), and `server.listen`
is called with no other configuration
(`http-server.ts:2728-2730`):

```ts
const server: Server = createServer((req, res) => { … })
…
server.listen(opts.port, bind, () => resolve())
```

No `server.maxConnections`, `server.timeout`, `server.keepAliveTimeout`,
`server.headersTimeout`, or `server.requestTimeout` is set anywhere in
this file (grepped for all of them — zero hits besides the `listen` call
itself), and there is no `server.on("clientError", …)` handler either, so
Node's process-wide defaults apply: unbounded concurrent connections,
5s keep-alive timeout, 60s headers timeout, and default `clientError`
behavior (auto-400 + socket close, not configurable here).

Body size: the codebase **does** have a body-size cap, but it is scoped to
one route, not `/mcp`. `http-server.ts:1334` documents *"Body capped at 32
MiB. Larger uploads error 413"* and `:1398` implements it
(`reply(413, { error: "file_too_large", maxBytes: MAX_BYTES })`) for the
file-upload route; a second, unrelated 413 exists for a different payload
guard at `:6150`. Neither applies to the `/mcp` POST body — `req.json()`
inside the SDK transport reads the stream to completion with no size
ceiling of its own. **Say plainly: there is no connection cap, no
backpressure/queueing mechanism, and no body-size limit protecting
`/mcp`.**

### 3. Can the transport/session re-arm without a full daemon restart? What's actually wedged?

The daemon does **not** hold one long-lived MCP transport across
requests. It follows the SDK's documented stateless pattern explicitly
(comment at `http-server.ts:517-523`): *"The SDK's `StreamableHTTPServerTransport`
is single-use… The official stateless pattern… builds a fresh `McpServer`
and `StreamableHTTPServerTransport` per request, connects them, and tears
both down on `res.close`. We follow that."* The implementation
(`serveMcp`, `http-server.ts:1094-1131`) does exactly that:

```ts
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
…
res.on("close", () => {
  void transport.close()
  void server.close()
})
try {
  await server.connect(transport)
  await transport.handleRequest(req, res)
} catch (err) { … }
```

Given this, **there is no persistent transport-layer state to get
"wedged" by a bad request** — every POST gets its own transport and
`McpServer`, disposed on `res.close`. This matters for root-causing: the
process staying alive and "logging normally elsewhere" is consistent with
*no single shared object failing outright* — but the incident's
`ECONNRESET`/`fetch failed` symptoms on **other** routes (not just `/mcp`)
mean something *process-wide* was still degraded. Since the transport
itself is provably not a long-lived singleton, the wedge (if there truly
was one, versus sustained overload — see §5/§6) has to live in one of the
genuinely shared singletons that every fresh `McpServer` rebinds into on
each request — the sessions registry, the remote-tunnel controller, the
pairing registry, workspace-brains, the supervisor (all wired in
`packages/runtime/src/index.ts:1652-1783`, closures rebuilt per call but
closing over the *same* singleton objects) — not in the transport class
named in the log line. Nothing in this incident's evidence (as given)
points at one of those singletons hanging; this diagnosis can rule out
"the transport didn't re-arm" as the mechanism but cannot, from static
reading alone, prove which singleton (if any) did. See §6's alternate,
better-supported explanation for why a restart was needed even without
anything being truly wedged.

### 4. Relationship between session/adapter-config directory COUNT and per-request resource usage

Checked directly — no code path found that enumerates either directory
at request time:

- **`~/.agentproto/sessions/<id>/`** (55,628 entries at incident time) is
  the per-session structured-transcript directory
  (`packages/runtime/src/transcript-writer.ts:40-42`, `sessionTranscriptDir`).
  Each session's writer opens **one** `createWriteStream` by direct,
  known path (`transcript-writer.ts:178`, `flags: "a"`) — it never lists
  the parent directory. The stream is opened when a session starts and
  `.end()`-ed on session close/settle (`transcript-writer.ts:528,537`).
  **File-descriptor usage here scales with the number of currently
  ACTIVE sessions holding open writers, not with the historical directory
  count.** No `readdir`/`fs.watch` over this directory exists anywhere in
  `packages/runtime/src/*.ts` (grepped for `readdir` + `sessions` — the
  only hit is `daemonRegistryDir()` in `agentproto-dir.ts`, a wholly
  different, much smaller directory — see below).
- **`~/.agentproto/adapter-config/<sessionId>/`** (279 dirs) is likewise
  resolved by direct path per session id (`sessions.ts:512-513`,
  `adapterConfigDirFor`); no code enumerates the parent `adapter-config/`
  directory.
- The one directory the daemon *does* `readdir` on a hot-ish path is
  `~/.agentproto/daemons/` (daemon **discovery** registry, one small JSON
  file per running daemon process — not per session), read via
  `readDaemonRegistry` (`agentproto-dir.ts:138-166`). This is unrelated to
  the 55,628/279 counts and is not on the `/mcp` request path.
- The in-memory session **registry** itself (`sessions` `Map`, distinct
  from the transcript directories) is loaded from `~/.agentproto/sessions.json`
  (or its per-bucket equivalents) **once at daemon boot**
  (`createSessionsRegistry`, `sessions.ts:3506-3529`, calling
  `loadHistorySnapshot`, `sessions.ts:7397+`), capped at `HISTORY_CAP = 200`
  **per bucket** (`sessions.ts:1813-1833`). This cap is a boot-time load
  ceiling, not something re-evaluated per request.

**Conclusion: the 55,628 session-transcript directories and 279
adapter-config directories were ambient disk usage at incident time, not
something any request-handling code path touches, opens, or scales with.**
This refutes the "resource pressure from directory count" half of the
working hypothesis as directly stated. The real per-request cost that
*does* scale with load is described in §6.

### 5. Missing instrumentation

Concretely, none of the following exist today, and each would have
turned this from a 30-minute blind restart into a diagnosable event:

- **No connection/fd count exposed anywhere.** `registerDaemonHealthTools`
  (wired at `index.ts:1687-1698`) reports `startedAt`,
  `resumeSessionsOnBoot`, reap/crash-detect intervals — no live socket
  count, no `process._getActiveHandles().length`-style gauge, nothing
  from `server.listening`/Node's connection tracking.
- **No structured field on the malformed-body log line.** The `onerror`
  handler (`http-server.ts:1106-1108`) logs only `err` — an `Error`
  with the fixed message `"Parse error: Invalid JSON"`. It never logs
  the request's `Content-Length` header, bytes actually received, remote
  address, or whether the underlying `res`/socket had already emitted
  `"close"`/`"error"` — any of which would have let someone confirm the
  "truncated body from a reset connection" theory in real time instead of
  reconstructing it from vendored SDK source after the fact.
- **No rate limiting on this specific error log.** See §6 — this
  repo already has exactly the utility needed
  (`createReconnectLogGate`, `reconnect-log-gate.ts`) and does not apply
  it here, unlike the structurally identical prior incident it was built
  for.
- **No "N transports currently erroring" gauge**, nor any counter at all
  for `/mcp` request outcomes (200 vs 4xx vs 5xx vs onerror-fired). There
  is no metrics/counters module in `http-server.ts` — `console.error` is
  the only signal.
- **`daemon.log` is never rotated.** Already known and named in-repo
  (`reconnect-log-gate.ts:6-7`: *"a single dead pairing produced ~85% of
  one 2.9MB never-rotated `~/.agentproto/daemon.log`"*). The MCP
  onerror path can reproduce the same failure mode (see §6) and nothing
  bounds `daemon.log`'s size or rotates it — this incident's 3.2MB growth
  is the same unbounded-log-file problem recurring in a second
  subsystem.
- **No per-request timing/cost logged for `mcpServerFactory`.** Every
  `/mcp` POST rebuilds the entire tool surface (§6) — there is no timer
  around that rebuild, so a slow rebuild under load would be invisible
  even with full log access.

### 6. Existing error-recovery/circuit-breaker code that this incident's path bypassed

**Yes — and it's a near-exact structural match the incident's `onerror`
path does not use.** `packages/runtime/src/reconnect-log-gate.ts` implements
`createReconnectLogGate`: log the first failure in a loop immediately,
then at most one line per window, with a suppressed-count suffix on the
next emission. Its own doc comment states the precedent directly:
*"Logging every single failure buries the daemon log — a single dead
pairing produced ~85% of one 2.9MB never-rotated `~/.agentproto/daemon.log`"*
(`reconnect-log-gate.ts:5-7`). It is wired into exactly **one** call site
today — `pairing-registry.ts:238` (`const dialFailureGate =
createReconnectLogGate({ now })`), gating outbound tunnel/pairing
reconnect-failure logs (`pairing-registry.ts:233-238`). It is **not**
wired into `serveMcp`'s `onerror` handler
(`http-server.ts:1106-1108`), which calls bare `console.error` on every
single parse failure with no gate, no dedup, no rate limit. Grepped the
full `packages/runtime/src/*.ts` tree for `ReconnectLogGate`/
`createReconnectLogGate` usage — `pairing-registry.ts` is the only
consumer.

This matters for root cause, not just hygiene: under the incident's load
(~24 concurrent sessions, "error counter incremented by 2 per client
probe"), an ungated `console.error` on a hot, adversarial-shaped path
(clients that are themselves retrying because they're getting resets)
means every failed probe writes 1-2 lines to `daemon.log` with **no
ceiling**. Two things follow from how that log file is opened, both
directly verifiable and not present in the incident write-up's own
hypothesis:

- The daemon is launched via `launchd` with `StandardOutPath` **and**
  `StandardErrorPath` both set to `~/.agentproto/daemon.log`
  (`packages/cli/src/commands/daemon.ts:835-836`; comment at `:23`:
  *"Logs go to `~/.agentproto/daemon.log` (stdout + stderr merged)"*).
  launchd hands the process a file descriptor for a **regular file** on
  fd 1/2, not a pipe or TTY.
- Node.js writes to `process.stdout`/`process.stderr` **synchronously**
  when the underlying fd is a regular file on POSIX (documented Node.js
  runtime behavior, not specific to this repo — files, unlike pipes/TTYs
  under a pty, are always sync-write in Node's stream implementation).
  Every `console.error(...)` call is therefore a blocking disk write that
  stalls the single-threaded event loop until it completes.

Put together: an ungated `onerror` handler, on a launchd-redirected
regular-file log, under a burst of malformed/reset connections from ~24
concurrent clients, is a plausible mechanism for genuine event-loop
stalling — which would explain **all** of the observed symptoms without
needing anything to be permanently "wedged" in the SDK-crash sense: the
process doesn't die (nothing throws past a boundary that kills it — see
§1/§3), it keeps logging (the writes are just serialized and slow, not
stopped), and other routes see `ECONNRESET`/`fetch failed` (their sockets
hit Node's default 5s keep-alive timeout or the client's own timeout
while the event loop is busy synchronously writing log lines instead of
servicing them) — and a client that gets reset naturally retries with
another (still-truncatable) connection, re-triggering the same `onerror`
path and sustaining the storm until something interrupts it. A full
process restart is the one intervention that reliably breaks a retry
storm like this, which matches why only `launchctl kickstart` recovered
it.

**This is presented as the best-supported hypothesis from static reading,
not a confirmed root cause** — confirming it needs a live repro (burst of
malformed `/mcp` POSTs against a build with `daemon.log` pointed at a
regular file, watching event-loop lag / other-route latency) or a
postmortem correlation of `daemon.log` line-arrival timestamps against
the `ECONNRESET` timestamps on other routes, neither of which this
diagnosis pass had access to. It is materially better supported than the
directory-count theory (§4, which the code refutes) because every step
in the chain above is a concrete, cited fact about this code and about
Node's documented I/O behavior, not an assumption.

---

## Incident 2 — opencode/deepseek: 4 concurrent sessions, 68s, zero output, vanished

### 1. What actually removes a session from `session_list`'s default view

`session_list` (`packages/runtime/src/session-tools.ts:346-430`) pulls
`registry.list({ includeArchived: true })` (`:397`) and then applies, in
order: subtree scoping for a scoped orchestrator caller (`:401-404`),
an `archived` filter unless `includeArchived` was requested (`:405-407`,
default **excludes** archived), a `kind` filter defaulting to
"exclude `command`-kind rows" (`:408-417`), and an optional
`status`/`onlyAlive` filter (`:418-424`, both opt-in, no default
exclusion by status). The underlying registry method
(`sessions.ts:6671-6686`, `list()`) filters **only** on `archived` — it
sorts by `startedAt` descending and returns every non-archived row
regardless of status or age. There is **no TTL, no ring-buffer size on
the descriptor itself, and no default status exclusion** that would hide
a freshly-exited (`status: "exited"`/`"error"`) session from the default
view. The only things that can make a *live* session stop appearing are:

- **Explicit archival** — `session_archive` (only callable on a
  terminal-status session, `sessions.ts:7060-7068`) or `session_gc`
  (`session-tools.ts:2380-2417`, calling `registry.gcSessions`,
  `sessions.ts:7083-7104`) — both are tool calls a human/agent must
  invoke; neither runs automatically on session exit.
- **The idle-reaper** (`runIdleReapPass`/`isReapable`,
  referenced at `sessions.ts:2716-2724,6890-6942`) — but this only fires
  on sessions that are **currently idle while still `running`**
  (a stalled/parked live session), marking them `killed` with
  `endedReason: "idle-reaped"`. It does not touch a session that has
  already reached a terminal status, and marking-as-killed is not
  removal — the row stays in `list()`'s output.
- **`sessions.delete(id)`** — the only two call sites in the whole file
  are inside `gcSessions` with `forget: true` (`sessions.ts:7098`, an
  explicit, opt-in tool call) and one other explicit-forget path
  (`sessions.ts:7226`). Grepped the file for every `sessions.delete(` /
  `sessions.set(` call — no automatic/timed deletion exists.
- **`HISTORY_CAP = 200`** (`sessions.ts:1833`) only bounds what's loaded
  from `sessions.json` **at daemon boot** (`loadHistorySnapshot`,
  called from `createSessionsRegistry`, `sessions.ts:3506-3529`) — it
  is not re-applied live, so 4 new sessions cannot evict themselves or
  each other via this cap outside a restart.

**No automatic eviction/TTL/reaping path in this codebase explains a
session vanishing from `session_list`'s default view within moments of
exiting.** The one mechanism that *would* explain "invisible to the
person who checked" without any deletion at all is subtree scoping
(`session-tools.ts:401-404`): if whoever polled `session_list`/
`agent_output` was a scoped orchestrator session that is not an ancestor
of the 4 opencode children (e.g. queried from a sibling session, or the
4 were spawned as roots rather than under the checking session), they
would be excluded by `collectSubtree`, indistinguishable from "gone" to
that caller even though the rows are intact in the full registry. This
diagnosis flags that as the most plausible explanation actually supported
by the code, but cannot confirm it without knowing the exact spawn/query
topology used in the incident — that detail wasn't in the report and
isn't recoverable from static reading.

### 2. Plausible causes for exiting at ~68s with zero output

Ruled out as an explicit, coded timeout: no timeout constant in
`packages/driver/agent-cli/src/*.ts` is near 68s on the turn/session
path. `session.idle_timeout_ms` and `turn_idle_timeout_ms`
(`schema.ts:240,245`) default to 600,000ms (10 min); the opencode adapter
itself sets `idle_timeout_ms: 1_800_000` (30 min) both at the top level
and under `continuation.pinned_session`
(`adapters/opencode/src/index.ts:104,175`). The only 60s-ish constant
found repo-wide is `setup_step.timeout_ms` default 60,000ms
(`packages/driver/agent-cli/src/schema.ts:124`), which governs
`agentproto setup <adapter>` provisioning **steps**, not a normal
`agent_start` turn — not the same code path. **68s is very likely not a
hardcoded timeout firing; it looks like elapsed wall-clock time to some
externally-caused failure**, most plausibly:

- **`npx -y opencode-ai acp` spawn overhead under concurrency.** The
  opencode adapter is invoked via `bin: "npx"`,
  `bin_args: ["-y", "opencode-ai", "acp"]`
  (`adapters/opencode/src/index.ts:75-76`) — every session spawn pays
  npm's registry-resolve/cache-lock cost unless already locally cached.
  Four concurrent `npx` invocations contending for the same npm cache
  lock/directory is a well-known source of serialized, multi-second-to-
  tens-of-seconds startup delay that an *isolated single-session test*
  would never surface (no contention with concurrency = 1). This is
  consistent with "worked fine isolated, failed specifically at 4
  concurrent" and with zero output (a session stuck resolving/installing
  the npx package before the ACP handshake even starts produces no ACP
  stream events at all). The `npx -y` launch command itself is a real,
  verified property of the adapter (`adapters/opencode/src/index.ts:75-76`)
  — the actual delay magnitude under 4-way contention is not something
  this static-reading pass can measure.
- **OpenRouter-side rate limiting / concurrent-request rejection** on
  `deepseek/deepseek-v4-flash` — 4 simultaneous first-token requests from
  a fresh account/key against OpenRouter could plausibly be
  throttled or queued long enough to explain the delay, then error out
  before any token streams, again producing literally zero output. This
  repo doesn't own that behavior (it's OpenRouter's side), so this is
  named as a plausible external cause, not something verifiable in-repo.
- **A spawn/auth-resolution failure that errors before first token.**
  `spawnAgentPending`'s failure outcome (`PendingAgentOutcome`,
  `sessions.ts:3068-3093`, `ok: false` branch) stamps a short
  human-readable `message` onto `SessionDescriptor.lastError` rather than
  throwing into the void — so if this is what happened, `lastError`
  on the (still-registered) descriptor should carry the actual reason.
  That the incident reporter found nothing to inspect argues against a
  clean `ok:false` settle (which would leave a readable `lastError`) and
  more toward either the npx-contention stall above, or a genuine
  visibility gap (§1) preventing anyone from reaching that field at all.

No single one of these is confirmed from static code reading alone — this
needs a live repro (4 concurrent opencode spawns, watching for npx-lock
contention or the adapter's stderr) to pin down definitively.

### 3. Retention/TTL policy on session output buffers or the registry entry itself

**Output buffer:** `RECENT_BYTES_CAP = 64 * 1024` (`sessions.ts:1790`) is
a **size** cap on the ring buffer of recent output bytes per session —
applied at `sessions.ts:4087` (oldest chunks dropped once the buffer
exceeds 64KiB). It is not time-based and does not remove the session
descriptor; a session that wrote literally zero bytes never touches this
path either way (nothing to cap).

**Registry entry:** No distinct TTL exists separate from "the process
died." A terminal-status descriptor persists indefinitely in the
in-memory registry (and in `sessions.json`/bucket files) until an
explicit `session_archive`/`session_gc(forget:true)` call, or until it
falls off the **boot-time** `HISTORY_CAP = 200`-per-bucket load (which
only prunes on the *next daemon restart*, oldest-`startedAt`-first,
`sessions.ts:1813-1833,7397+`). There is no configurable "keep terminal
sessions visible for N minutes" setting — today it's either indefinite
(default) or immediate-on-explicit-archive; nothing in between, and
nothing automatic.

### 4. Same root cause as Incident 1, or a separate defect?

**Separate defect**, based on what the code actually shows:

- Incident 1's best-supported mechanism (§6 above) is event-loop
  contention from ungated synchronous logging under connection-reset
  retry pressure — a resource/timing problem entirely inside the
  daemon's `/mcp` HTTP path.
- Incident 2's candidate causes (§2 above) are all **upstream of, and
  unrelated to**, that path: `npx` process-spawn contention and/or
  OpenRouter-side throttling happen before an ACP session ever reaches
  the daemon's session registry in a way that would touch `/mcp` POST
  handling at all. Nothing in `session_list`/`registry.list()`/
  `gcSessions`/the idle-reaper (§1) touches directory counts, request
  volume, or anything else implicated in Incident 1.
- The two incidents share only a *category* — "something breaks under
  concurrency" — not a mechanism. If anything, Incident 2 is **two**
  separable problems in its own right: (a) whatever actually causes the
  68s/zero-output failure (unconfirmed, §2), and (b) the observability
  gap named explicitly in the task brief — a session that fails silently
  and cannot be inspected afterward is a **real, standalone defect**
  regardless of (a)'s cause, and the closest code-level explanation this
  pass could find for "cannot be inspected afterward" is subtree scoping
  hiding a real, intact row (§1) rather than any actual deletion. That
  gap would exist and be worth fixing even in a world with infinite
  compute/no rate limits, which is why it's named as separate from
  Incident 1's resource-pressure story.

---

## Combined: what instrumentation is missing (both incidents)

1. **Rate-limit the `/mcp` transport `onerror` log** the same way
   `pairing-registry.ts:238` already rate-limits reconnect-dial failures
   — `createReconnectLogGate` (`reconnect-log-gate.ts`) is generic and
   already exists; `http-server.ts:1106-1108` is the one call site that
   doesn't use it despite being structurally identical to the incident
   the gate was built for.
2. **Rotate or cap `daemon.log`.** It is opened once by launchd
   (`daemon.ts:835-836`) and never rotated by anything in this repo —
   confirmed by the reconnect-log-gate precedent (`reconnect-log-gate.ts:6-7`)
   and this incident's independent 3.2MB growth in a different subsystem.
3. **A connection/fd/active-request gauge on `/health` or a new
   `/debug` route** — nothing today exposes live socket count, active
   `/mcp` requests in flight, or per-request timing for
   `mcpServerFactory`'s per-request tool-surface rebuild
   (`index.ts:1652-1783`), which is the one per-request cost in this path
   that *does* scale with concurrent client volume (more concurrent
   clients ⇒ more concurrent full-gateway rebuilds ⇒ more synchronous
   work competing for the same event loop that's also serving every other
   route).
4. **Log the actual bytes received (or `Content-Length` vs. bytes read)
   on every "Parse error: Invalid JSON"** — today's `onerror` handler logs
   only the SDK's generic `Error` object (`http-server.ts:1107`), which
   cannot distinguish "client sent genuinely malformed JSON" from
   "connection was reset mid-body" — exactly the ambiguity this incident's
   own working hypothesis had to resolve by reading vendored SDK source
   after the fact instead of from the log line itself.
5. **Session-exit visibility**: nothing in `session_list`/`agent_output`
   distinguishes "row genuinely gone" from "row exists but excluded by
   subtree scoping" — a caller hitting an empty/filtered result has no
   signal that a broader (`includeArchived`, or an unscoped/root query)
   might find it. A `session_list` response could cheaply note when
   subtree scoping suppressed rows the caller isn't privileged to see,
   distinct from "there is nothing here."

## Should we file a fix PR, and for what specifically?

Yes, narrowly — two independent, low-risk, well-justified next steps,
each traceable to a specific finding above and each small enough to land
without redesigning the transport or the registry:

1. **Wire `createReconnectLogGate` (or an equivalent per-key gate) into
   `serveMcp`'s `onerror` handler** (`http-server.ts:1106-1108`). This is
   the single highest-confidence fix: it's a direct reuse of existing,
   already-tested code for the exact failure mode (`reconnect-log-gate.ts`
   + its test suite), addresses the most concrete, verifiable contributor
   to Incident 1 identified in this pass (§6), and carries essentially no
   behavioral risk — it only changes logging cadence, not transport
   handling, exactly as its own doc comment promises
   (`reconnect-log-gate.ts:15`: *"This only changes logging cadence…
   untouched"*). Should ship alongside a repro/measurement (burst of
   malformed `/mcp` POSTs against a file-backed stdout) to confirm the
   event-loop-stall hypothesis in §6 before or alongside the fix, since
   that hypothesis — however well-supported by cited code — is not yet
   confirmed by a live reproduction.
2. **Log received-bytes-vs-`Content-Length` (or otherwise disambiguate
   "malformed JSON" from "truncated by reset") on the `onerror` path.**
   Small, additive, directly closes the diagnostic gap this exact
   incident's authors had to work around after the fact.

Everything else surfaced here (a connection/fd gauge, `daemon.log`
rotation, per-request `mcpServerFactory` timing, `session_list`
scoping-visibility hints, and — separately — actually root-causing
Incident 2's 68s/zero-output failure) is real and worth doing, but each
needs either a design decision (what should the gauge look like, is log
rotation daemon-owned or launchd-owned) or a live repro this diagnosis
pass didn't have (confirming npx-lock contention or OpenRouter throttling
for Incident 2). Recommend scoping the first fix PR to items 1-2 above —
concrete, cited, low-risk — and opening separate follow-up issues (not
PRs) for the rest, each linking back to the specific section of this
document that motivates it.
