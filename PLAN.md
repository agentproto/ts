# agentproto — session liveness / health tracking

## Context

While supervising delegated hermes/claude-code sessions through agentproto's
`policy_attach` + `session_monitor`/`agent_output`, we repeatedly hit the gap
where a session goes quiet (many minutes, no output) and there is no
daemon-native way to tell if it's (a) still working through a long tool-call
chain, (b) truly hung, or (c) crashed silently. Today we reach outside
agentproto entirely (`sqlite3 ~/.hermes/state.db`, `ps aux | grep hermes`,
manual polling of `message_count`) — none of which works against a remote
daemon.

This provides liveness/heartbeat fields on `SessionDescriptor` so the
existing `session_list`/`agent_sessions_list`/`session_monitor` tools answer
"is this session alive and making progress" without adapter-specific
forensics.

## Grounded findings (verified against tree `feat/session-liveness` @ 8d1191e)

### 1. `pid: null` — why it happens and exactly where

The chain is fully traceable:

- `packages/driver/agent-cli/src/define-agent-cli.ts:102` — the daemon spawns a
  real `ChildProcess` via `spawn(definition.bin, ...)`. `child.pid` is a valid
  integer at this point.
- `define-agent-cli.ts:179-192` — the `AgentCliRuntimeSession` returned by
  `start()` exposes ONLY `{ sessionId, send, cancel, close }`. **The pid is
  discarded here — the ChildProcess is held in closure but never exposed.**
- `packages/driver/agent-cli/src/types.ts:547-552` —
  `AgentCliRuntimeSession` interface confirms: only `sessionId`, `send`,
  `cancel`, `close` — no `pid`, no `child`.
- `packages/runtime/src/agent-tools.ts:455-479` — `agent_start` handler calls
  `resolved.startSession(...)` (returns `AgentCliRuntimeSession`), then passes
  the result to `registry.spawnAgent()` as `agentSession: AgentSessionLike`.
- `packages/runtime/src/sessions.ts:39-44` — `AgentSessionLike` interface has
  `{ sessionId, send, cancel, close }` — NO pid field.
- `sessions.ts:1146-1211` (`spawnAgent`) — line **1153** hardcodes
  `pid: null`. The comment says "driver already started the session" but the
  driver gives us no way to reach the pid.
- Contrast with `sessions.ts:1035-1046` (`spawn`) and `sessions.ts:1099-1108`
  (`register`) — both set `pid: child.pid ?? null` because they own the
  ChildProcess directly. `spawnPty` (`sessions.ts:1256-1261`) sets
  `pid: pty.pid` for the same reason.

**Root cause**: the `AgentSessionLike` / `AgentCliRuntimeSession` /
`AgentCliClient` interfaces were designed around protocol-level operations
(`send`, `cancel`, `close`) and never threaded the OS-level process id
through. The pid exists at the spawn site but is dropped before it reaches
the registry.

### 2. `lastOutputAt` vs real activity — the gap

- `sessions.ts:633` — `lastOutputAt` is updated ONLY in `appendLine()`, which
  fires when text lands in the ring buffer.
- `sessions.ts:683` — same for `appendBytes()` (PTY byte stream).
- `sessions.ts:713-801` (`projectEvent`) — maps ACP `StreamEvent` kinds to
  ring-buffer lines: `text-delta` → `appendLine`, `thought` → `appendLine`,
  `tool-call` → `appendLine`, `tool-result` → `appendLine` (on error),
  `turn-end` → `appendLine`.
- **The gap**: when hermes is mid-way through a long internal tool-call chain
  with NO new ACP `session/update` notifications arriving, `lastOutputAt` is
  untouched. The ring buffer gets no new lines. From the outside, the session
  looks identical to a genuine hang — `status: "running"`, `busy: true`, but
  `lastOutputAt` is stale.
- The `busy` flag (`sessions.ts:912`) correctly says "a turn IS in flight,"
  but `busy` cannot distinguish "genuinely still computing" from "process
  crashed silently but we haven't noticed yet."

### 3. ACP client layer — where activity does flow (but isn't surfaced)

- `packages/acp/src/client/index.ts:152-250` — `createAcpClient` wraps stdin/
  stdout as web streams, creates a `ClientSideConnection`, and handles
  `session/update` notifications in `buildClientHandlers` (:381-413).
- `acp/src/client/index.ts:386-397` — the `sessionUpdate` handler translates
  ACP notifications (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`,
  `tool_call_update`) into `StreamEvent` objects and enqueues them.
- `acp/src/client/index.ts:415-459` (`translateSessionUpdate`) — maps the
  ACP notification discriminator (`sessionUpdate` field) to `StreamEvent.kind`.
- **Every JSON-RPC message on stdio** (both directions) is a potential
  liveness signal. The ACP client handles incoming `session/update`
  notifications; outgoing messages (`newSession`, `prompt`, `cancel`,
  `setSessionConfigOption`) are also proof the daemon is communicating with
  the child.

There is currently **no hook** for the ACP client to pulse a "still alive"
signal to the registry. The `AcpClientSession.prompt()` returns an
`AsyncIterable<StreamEvent>` — a consumer must drain it to see events, but
between events the consumer has no signal at all.

### 4. Turn-end detection — where the hermes forced-stop gap may live

- `packages/acp/src/client/index.ts:286-310` — the `prompt()` method calls
  `connection.prompt()`, then `.then()` to enqueue a synthetic `turn-end`
  StreamEvent. The `stopReason` is parsed from the ACP `PromptResponse`:
  `"cancelled"` → reason `"cancelled"`, `"max_turns"` → reason
  `"max_turns"`, default → `"completed"`.
- `sessions.ts:927-929` — `runAgentTurn` drains `for await (const evt of
  rt.agentSession.send(wrapped))`. The `turn-end` event arrives IN the
  stream, not after it.
- `sessions.ts:930,944-947` — on normal completion, `turnCompleted = true`,
  `turnsCompleted++`, `session:turn-end` event is emitted on the bus.
- **The hermes forced-stop scenario**: hermes has an internal
  "max tool-calling iterations" cap. When hit, it's forced to emit a final
  response via a synthetic user-role nudge message. If the ACP adapter
  (hermes) does NOT properly resolve `connection.prompt()` with a
  `stopReason` after this forced stop, the daemon never sees `turn-end`.
  The session stays `busy: true`, `status: "running"` eternally.
- This is a protocol-level edge case in the hermes ACP adapter. The fix for
  it belongs in `@agentproto/adapter-hermes` or the hermes ACP adapter
  upstream — but the liveness fields proposed here would at minimum let a
  supervisor DETECT the hang (no activity for N minutes), which is the
  detection gap this plan closes.

### 5. `idle_timeout_ms` — declarative only, no runtime enforcement

- `adapters/claude-code/src/index.ts:43` — `session: { idle_timeout_ms: 1_800_000 }`
- `adapters/hermes/src/index.ts:55` — same declaration.
- `packages/driver/agent-cli/src/types.ts:142-147` — `AgentCliSession`
  interface declares `idle_timeout_ms?: number` as a manifest field.
- `packages/driver/agent-cli/src/continuation/strategies/pinned-session.ts:53,144`
  — the ONLY consumer of `idle_timeout_ms`: it sets an idle eviction timer
  for the pinned-session continuation strategy. After the timeout, the pinned
  child process is closed.
- **There is NO daemon-level idle-check loop** that examines `lastOutputAt`,
  compares to `idle_timeout_ms`, and kills/kills+marks hung sessions. This
  would be the natural follow-up feature once liveness fields are reliable.
  (Explicitly out of scope for this plan — detection only, not automated
  recovery.)

### 6. What `session_monitor` already uses on the descriptor

- `packages/runtime/src/orchestration-tools.ts:690-754` — the synchronous
  pre-check in `session_monitor` inspects:
  - `desc.awaitingInput` (:694) — fast-return for awaiting-input sessions
  - `desc.turnsCompleted > 0 && !desc.busy && desc.status === "running"`
    (:718-721) — fast-return for already-finished turns
  - `desc.status === "exited" || "killed" || "error"` (:739) — fast-return
    for terminal sessions
  - `desc.busy` (:912-913) — prevents mistaking a fresh turn-start for a
    finished one
- New liveness fields (`lastActivityAt`, `processAlive`) would be read-only
  additions to these checks — no change to the existing fast-return logic,
  just new information the caller can inspect when there IS no fast-return.

## Design decisions

### Decision 1: new fields on `SessionDescriptor` (no new tool)

**Recommendation**: add liveness fields directly to `SessionDescriptor`. They
surface automatically in every tool that returns session descriptors:
`session_list`, `agent_sessions_list`, `terminal_sessions_list`,
`command_list`. No new MCP tool, no new REST endpoint, no API surface growth.

A dedicated `session_health(sessionId)` tool was considered but rejected:
- It would duplicate the descriptor-reading code path already in
  `session_list`
- Callers already get `SessionDescriptor` from `agent_start` / `agent_output`
  / `session_list` and can inspect new fields without a second call
- `session_monitor` already fills the "check state" role — the new fields
  make it more informative without adding another tool

**Naming convention**: follow the existing `lastOutputAt` pattern
(`lastActivityAt`, `processAlive`), not a new prefix.

### Decision 2: `lastActivityAt` — update on ANY ACP traffic, not just output

**Recommendation**: `lastActivityAt` is distinct from `lastOutputAt`.
`lastOutputAt` stays unchanged (ring-buffer line timestamp). `lastActivityAt`
is updated whenever:
- An ACP `session/update` notification arrives (even if it translates to a
  `StreamEvent` that doesn't produce a ring-buffer line — e.g. some
  notifications are `null` from `translateSessionUpdate`)
- An ACP RPC response arrives (`newSession`, `prompt`, `cancel`,
  `setSessionConfigOption`)
- An ACP RPC request is sent (outbound traffic proves the daemon is still
  interacting)

**Implementation approach**: add an `onActivity?: () => void` callback to
`AcpClientOptions` (in `packages/acp/src/client/index.ts`). The callback
fires from `buildClientHandlers.sessionUpdate` (all incoming) and can be
wrapped around the `connection.*` call sites. The runtime passes a closure
that updates `SessionRuntime.desc.lastActivityAt` and calls
`schedulePersist()` (debounced).

The alternative of wrapping the stdio streams with a "bytes passing through"
interceptor was considered but rejected — it's lower-level than needed and
would fire on any subprocess output (including stderr noise), not just on
meaningful protocol traffic.

### Decision 3: `processAlive` — a cheap `process.kill(pid, 0)` check

Once `pid` is threaded to the descriptor (fix Decision 4), a liveness check
is trivial: `process.kill(pid, 0)` throws `ESRCH` if the process is dead.
This is the standard POSIX "signal 0" check — zero-overhead, no syscall
beyond what the kernel already tracks.

**Recommendation**: `processAlive?: boolean` on `SessionDescriptor`, computed
from `pid` at descriptor-read time (in `list()`/`get()`). It should be:
- `true` when `pid !== null` AND `process.kill(pid, 0)` succeeds
- `false` when `pid !== null` AND the check throws `ESRCH`
- Absent/omitted when `pid === null` (no process to check)

**Implementation**: add a helper method `isProcessAlive(desc)` called from
`list()` and `get()` in the sessions registry. Computed at read time (not
persisted) since it's a live OS query — persisting it would make
`sessions.json` stale on restore.

### Decision 4: thread `pid` through `AgentSessionLike`

**Recommendation**: add `readonly pid?: number` to both `AgentSessionLike`
(in `sessions.ts`) and `AgentCliRuntimeSession` (in
`driver/agent-cli/src/types.ts`).

In `define-agent-cli.ts:179-192`, the existing `child` variable is in scope
— add `pid: child.pid` to the returned session object.

In `sessions.ts:1153` (`spawnAgent`), replace `pid: null` with
`pid: input.agentSession.pid ?? null`.

**Backward compatibility**: `pid` is optional (`?`). Older adapters that
don't expose it stay at `null` (current behavior). The `processAlive` check
simply omits the field when `pid` is null — no regression.

**Note on `AgentCliClient` vs `AgentCliRuntimeSession`**: The pid belongs on
`AgentCliRuntimeSession` (what `start()` returns), not on `AgentCliClient`
(the lower-level protocol arm). The `AgentCliClient` is designed to be
protocol-agnostic; a future WebSocket transport would have no pid. The
runtime session is the right place.

### Decision 5: keep `lastOutputAt` semantics unchanged

`lastOutputAt` is already consumed by UIs and `session_monitor`. Changing its
meaning (to fire on all activity vs. just output) would break existing
consumers that expect it to mean "last time something appeared in the
terminal." `lastActivityAt` is additive — consumers that want the fine-grained
liveness signal use it; consumers that want the human-visible output
timestamp keep using `lastOutputAt`.

## What to build

### 1. Thread `pid` through the agent session stack

**File**: `packages/driver/agent-cli/src/types.ts` (~line 552)
- Add `readonly pid?: number` to `AgentCliRuntimeSession`

**File**: `packages/driver/agent-cli/src/define-agent-cli.ts` (~line 179)
- Add `pid: child.pid` to the returned session object

**File**: `packages/runtime/src/sessions.ts` (~line 44)
- Add `readonly pid?: number` to `AgentSessionLike`

**File**: `packages/runtime/src/sessions.ts` (line 1153)
- Replace `pid: null` with `pid: input.agentSession.pid ?? null`

### 2. Add `processAlive` and `lastActivityAt` to `SessionDescriptor`

**File**: `packages/runtime/src/sessions.ts` (~line 106, after `lastOutputAt`)
```typescript
/** Last time ANY adapter-process activity was observed — ACP JSON-RPC
 *  traffic, protocol-level events, not just ring-buffer output lines.
 *  Stays current during long tool-call chains where `lastOutputAt`
 *  goes stale. Updated on incoming session/update notifications AND
 *  on outbound RPC calls. ISO 8601. */
lastActivityAt?: string
/** Whether the underlying OS process is still alive. Computed via
 *  process.kill(pid, 0) — cheap, zero-overhead, standard POSIX check.
 *  Absent when pid is null (no process to check). */
processAlive?: boolean
```

### 3. Add activity callback plumbing to the ACP client

**File**: `packages/acp/src/client/index.ts` (~line 94, `AcpClientOptions`)
- Add `onActivity?: () => void` to options

**File**: `packages/acp/src/client/index.ts` (~line 386, `buildClientHandlers`)
- Call `onActivity?.()` from `sessionUpdate` (all incoming traffic)

**File**: `packages/acp/src/client/index.ts` (~line 180-250, `newSession`/`loadSession`/`prompt`)
- Call `onActivity?.()` after each `connection.*` call that sends outbound
  traffic — proves the daemon is still interacting with the child.

**File**: `packages/driver/agent-cli/src/protocol/acp-client.ts` (~line 82, `AcpProtocolOptions`)
- Thread `onActivity` through to `createAcpClient`

**File**: `packages/driver/agent-cli/src/define-agent-cli.ts` (~line 127, `buildProtocolArm`)
- Thread `onActivity` from the runtime's options to the protocol arm

### 4. Wire the activity callback in `http-server.ts` (or the adapter resolution layer)

The `onActivity` callback needs to reach the `SessionsRegistry` so it can
update `SessionRuntime.desc.lastActivityAt`. The cleanest attachment point is
at the `resolveAgentAdapter` → `startSession` call site — the http-server or
the MCP `agent_start` handler already has access to the registry.

**File**: `packages/runtime/src/http-server.ts` — in the `POST /sessions/agent`
handler, or more precisely in the closure that wraps `agentSession.send()`:

Alternative: thread it through `AgentCliStartOptions` so the driver layer wires
it. Add `onActivity?: () => void` to `AgentCliConnectOptions`. The ACP arm
passes it to `AcpClientOptions.onActivity`.

**File**: `packages/driver/agent-cli/src/types.ts` (~line 399, `AgentCliConnectOptions`)
- Add `onActivity?: () => void`

**File**: `packages/runtime/src/agent-tools.ts` (~line 455, `startSession` call)
- Set `onActivity` on `startSession` options to a closure that updates the
  descriptor on the registry.
- Note: at this point we have the `desc` from `spawnAgent` result, so we can
  call `registry.get(id)` and update `lastActivityAt` directly. But
  `startSession` is called BEFORE `spawnAgent`. The activity callback needs
  the session id.

**Refined approach**: Instead of threading through `startSession` options
(which are pre-spawn), intercept the `agentSession.send()` calls in
`runAgentTurn` (`sessions.ts:927`). Every `send()` produces an
`AsyncIterable`. We can wrap it:

```typescript
// In runAgentTurn, after rt.agentSession.send(wrapped):
const stream = rt.agentSession.send(wrapped)
// Wrap to pulse activity on each yielded event
// (The for-await loop already does this per-event via projectEvent)
```

Actually, the simplest correct approach: update `lastActivityAt` in
`projectEvent` (`sessions.ts:713`) — this fires for EVERY StreamEvent
(text-delta, tool-call, tool-result, thought, turn-end, error). These are the
same events that prove the ACP channel is alive.

But the brief's scenario is "a session mid-way through a long internal
tool-call chain" — where NO StreamEvents arrive at all. So `projectEvent`
doesn't help for that case.

**Final refined approach**: Thread `onActivity` all the way:

1. `AcpClientOptions.onActivity` — fires on every JSON-RPC message received
2. `AcpProtocolOptions.onActivity` — threads to ACP client
3. The `AgentCliClient` interface doesn't need it — the ARM gets wired at
   construction
4. In `define-agent-cli.ts:127-128`, pass `onActivity` to
   `createAcpProtocolArm({..., onActivity})`
5. Wire `onActivity` at the `startSession` call site. Pass an `onActivity`
   closure that pulses `lastActivityAt` on the session descriptor.

The `startSession` → `start()` → `createAcpProtocolArm` path is where the
wiring happens. We need to thread `onActivity` through `AgentCliStartOptions`
→ `AgentCliConnectOptions` → `AcpProtocolOptions` → `AcpClientOptions`.

Alternatively, add `onActivity` to the `AgentCliClient` interface itself
(pass it to `connect()`), since `connect()` already receives options. This is
cleaner — the protocol arm receives it at connect time, no need to thread
through the runtime start options.

**Preferred approach**:
- Add `onActivity?: () => void` to `AgentCliConnectOptions`
- Pass it through `createAcpProtocolArm` → `AcpProtocolOptions` →
  `createAcpClient` → `AcpClientOptions`
- In `define-agent-cli.ts:154` (`arm.connect(...)`), forward `onActivity` from
  connect options.

### 5. Compute `processAlive` in the registry read paths

**File**: `packages/runtime/src/sessions.ts` — add a helper:

```typescript
function stampProcessAlive(desc: SessionDescriptor): void {
  if (desc.pid === null || desc.pid === undefined) {
    delete desc.processAlive
    return
  }
  try {
    process.kill(desc.pid, 0)
    desc.processAlive = true
  } catch {
    desc.processAlive = false
  }
}
```

Call it from `list()` (~line 1399-1403) and `get()` (~line 1404-1406). Don't
persist `processAlive` to `sessions.json` — it's a live OS query, stale on
restore.

### 6. Not in scope: ACP adapter turn-end detection bug (hermes forced-stop)

The turn-end detection gap (hermes hitting max_turns with no `turn-end`
emitted) is tracked as a separate issue. This plan's liveness fields
mitigate the SYMPTOM (you can now detect the hang) but don't fix the root
cause (hermes ACP adapter not signaling turn-end after a synthetic nudge).
The root cause fix belongs in the hermes ACP adapter upstream or in
`@agentproto/adapter-hermes`.

With `lastActivityAt` and `processAlive`, a supervisor can:
- See `lastActivityAt` stale for N minutes → suspect hang
- Check `processAlive: false` → process is dead, confirmed crash
- Check `processAlive: true` + `busy: true` + stale `lastActivityAt` →
  process is alive but not making progress — hung

## Explicitly out of scope for this plan

- **Automated recovery**: don't build a "kill and auto-restart hung sessions"
  loop. Detection only. Recovery is a natural follow-up once detection is
  reliable.
- **Adapter-specific state inspection**: don't propose reading hermes's SQLite
  or claude-code's JSONL from the daemon. The fix is adapter-agnostic, at
  the ACP/process-management layer the daemon already owns.
- **Fixing the hermes forced-stop turn-end gap**: tracked separately. This
  plan provides the tools to detect it; the root cause fix lives in the
  hermes ACP adapter.
- **New MCP tool**: no `session_health` tool. Fields go on
  `SessionDescriptor`, surfaced through existing tools.
- **`session_monitor` behavior changes**: the new fields are read-only
  additions — `session_monitor`'s fast-return logic is unchanged.

## Verification

1. `pnpm check-types` passes in `packages/acp`, `packages/driver-agent-cli`,
   `packages/runtime`, and all adapters — no new type errors from the
   interface additions.
2. `pnpm run test` passes — existing test suite should not need changes
   (only additive fields, no behavioral changes to existing paths).
3. Manual smoke test against a live daemon:
   - Spawn a hermes session with a long prompt → `session_list` shows
     `lastActivityAt` updating while the session is mid-turn
   - `lastOutputAt` stays stale while hermes is thinking between tool calls →
     confirms the two fields are distinct
   - `pid` is no longer `null` for agent-cli sessions
   - `processAlive: true` while the session is running
   - Kill the hermes process externally (`kill -9 <pid>`) → `processAlive`
     flips to `false` on next `session_list` call
4. Verify `sessions.json` round-trips: spawn a session, restart daemon,
   confirm (a) `pid`/`lastActivityAt` survive restore, (b) `processAlive` is
   recomputed fresh (absent if pid was null, or reflects current OS state).

## Critical files

- `packages/runtime/src/sessions.ts` — `SessionDescriptor` (new fields),
  `AgentSessionLike` (new `pid`), `spawnAgent` (use real pid), `list()`/`get()`
  (compute `processAlive`)
- `packages/acp/src/client/index.ts` — `AcpClientOptions.onActivity`,
  `buildClientHandlers` (fire callback)
- `packages/acp/src/types.ts` — reference only, no changes expected
- `packages/driver/agent-cli/src/types.ts` — `AgentCliRuntimeSession.pid`,
  `AgentCliConnectOptions.onActivity`
- `packages/driver/agent-cli/src/define-agent-cli.ts` — expose `child.pid`,
  thread `onActivity` to protocol arm
- `packages/driver/agent-cli/src/protocol/acp-client.ts` —
  `AcpProtocolOptions.onActivity`, thread to `createAcpClient`
- `packages/runtime/src/http-server.ts` — wire `onActivity` callback that
  pulses `lastActivityAt` on the descriptor (at the `resolveAgentAdapter` →
  `startSession` call site)
- `packages/runtime/src/agent-tools.ts` — same wiring in MCP `agent_start`
  handler
- `packages/runtime/src/session-tools.ts` — no code changes, new fields
  surface automatically in `session_list`/etc.
- `packages/runtime/src/orchestration-tools.ts` — no code changes; new fields
  are informational in `session_monitor` output
- All adapters (`adapters/claude-code/src/index.ts`,
  `adapters/hermes/src/index.ts`, etc.) — no changes needed; pid threading is
  in the shared driver layer

## Report back

Every file modified (one line each), `pnpm check-types` output across all
affected packages, `pnpm run test` output, and an honest account of what was
and wasn't verified live. If the actual ACP SDK behavior / event bus
internals don't match this plan's assumptions, stop and report the
discrepancy rather than improvising around it.
