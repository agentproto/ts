# agentproto — turn-end watchdog for adapters that hang without signaling completion

## Context

Confirmed, live, twice today: a hermes-adapter session can hang forever
with `status:"running"`, `busy:true`, no `session:turn-end` ever firing —
even though hermes itself finished and produced a complete final answer
(observed directly in `~/.hermes/state.db`: a synthetic "you've reached the
maximum number of tool-calling iterations" nudge followed by a real final
assistant message, with the agentproto daemon never noticing). This forced
manual diagnosis via `ps aux`/hermes's own sqlite db — exactly the gap the
`feat/session-liveness` plan (already written, implementation deferred) is
meant to make detectable. This plan fixes the underlying hang, not just its
detectability.

## Grounded findings (verified against `main` post-#139 merge)

- `adapters/hermes/src/index.ts:26-33` — hermes is a **pure external
  binary** (`bin: "hermes"`, `bin_args: ["acp"]`), spawned as a subprocess
  and driven over stdio JSON-RPC. Zero ACP server code for hermes exists in
  this repo — the daemon is a client only. This means the actual root cause
  (hermes's own ACP server apparently never sending a `prompt` JSON-RPC
  response after its internal forced-stop) is NOT fixable in this repo. What
  IS fixable here is client-side resilience so the daemon doesn't hang
  forever waiting for a response that may never come.
- `packages/acp/src/client/index.ts:285-315` (`prompt()` method) — calls
  `connection.prompt()` (the ACP client SDK call), then `.then()` enqueues a
  synthetic `turn-end` `StreamEvent` mapping `stopReason`:
  `"cancelled"`→`"cancelled"`, `"max_turns"`→`"max_turns"`,
  default→`"completed"`. **Confirmed: this `.then()` is fire-and-forget
  (`void promise`, line ~327) with NO timeout wrapping it.** If hermes never
  sends the JSON-RPC response, `connection.prompt()`'s promise never
  resolves, and this `.then()` simply never runs.
- `packages/acp/src/client/index.ts:340-361` (`makeIterator()`) — the async
  iterator the caller drains waits indefinitely via `new Promise(resolve =>
  state.resolveNext = resolve)` — no timeout here either.
- `packages/runtime/src/sessions.ts:927` (`runAgentTurn`) — `for await (const
  evt of rt.agentSession.send(wrapped))` blocks forever if the iterator
  never yields.
- `sessions.ts:930, 944-984` — `turnCompleted = true` and the
  `session:turn-end` bus emission both only happen AFTER the drain loop
  exits, which never happens in the hang case.
- **Confirmed: no timeout/watchdog exists anywhere in the direct stdio ACP
  client path.** (Contrast: `packages/acp/src/tunnel/client.ts:199-204` has
  a 30s default timeout for TUNNEL-relayed ACP requests — a precedent
  pattern exists in this codebase, just not applied to the direct-stdio
  client.)

## What to build

A watchdog timeout in the ACP client (`packages/acp/src/client/index.ts`)
that force-synthesizes a `turn-end` event (with a new, honest stop reason —
e.g. `"watchdog-timeout"`, distinct from `"completed"`/`"cancelled"`/
`"max_turns"` so callers can tell the difference between a real completion
and an inferred one) if the underlying adapter goes silent for too long
during a turn.

**Compose with the session-liveness plan, don't duplicate it**: that plan
(already written, `_agentproto-worktrees/session-liveness/PLAN.md`)
proposes an `onActivity` callback threaded through
`AcpClientOptions`/`AgentCliConnectOptions` that fires on ANY incoming ACP
`session/update` notification or outbound RPC call — precisely the signal
needed to reset a watchdog timer correctly (so the timeout is "N seconds of
TRUE silence," not "N seconds since the turn started," which would
false-positive on hermes's genuinely-long tool-call chains). **If
session-liveness's `onActivity` plumbing lands first, build the watchdog on
top of it. If this lands first, build the minimal activity-tracking needed
for the watchdog now, and note in a comment that session-liveness's fuller
`lastActivityAt` descriptor field should eventually read from the same
underlying signal** (don't build two separate activity-tracking mechanisms).

1. Add a configurable idle timeout to `AcpClientOptions` (e.g.
   `turnIdleTimeoutMs`, default something generous like 300_000ms / 5min —
   this must NOT fire during legitimate long tool-call chains, only on true
   silence; pick a default conservatively and make it clearly overridable).
2. In the `prompt()` method (`client/index.ts:285-315`), start a timer
   alongside `connection.prompt()`. Reset the timer on every activity signal
   (incoming `session/update`, per the `onActivity` composition point
   above). If the timer fires before `connection.prompt()` resolves,
   synthesize the `turn-end` event with `stopReason: "watchdog-timeout"` and
   let the iterator complete — but do NOT abandon the underlying
   `connection.prompt()` promise silently; if it DOES eventually resolve
   after the synthetic turn-end was already emitted, log it (don't crash,
   don't emit a second turn-end for the same logical turn).
3. Thread `turnIdleTimeoutMs` up through `AgentCliConnectOptions` →
   `AgentCliRuntimeSession` construction, similar to how other per-adapter
   options flow, so it's overridable per-adapter-manifest (hermes may want a
   different default than claude-code, which doesn't have this bug at all
   per today's live observations — claude-code sessions correctly complete
   turns).
4. Emit the watchdog firing as an observable event (reuse
   `session:turn-end` with the new stop reason — don't invent a parallel
   event type) so existing consumers (`policy_attach` gates,
   `session_monitor`) see it naturally as a turn completing, just with a
   stop reason that signals "this was inferred, not a real completion" for
   anyone who wants to distinguish it.

## Explicitly out of scope

- Fixing hermes's own ACP server (outside this repo, upstream Nous Research
  project — not reachable from here).
- Automatically killing/restarting the underlying hung process when the
  watchdog fires — this plan only unblocks the DAEMON's bookkeeping (so
  `policy_attach`/`session_monitor`/etc. stop waiting forever); the
  underlying hermes process may still be alive and could theoretically send
  a late response after the fact (handle gracefully per point 2 above, don't
  crash).
- Applying the watchdog to adapters other than hermes by default — scope
  the default timeout conservatively, and confirm whether claude-code/other
  adapters need this at all before turning it on broadly (today's evidence
  only shows hermes hanging).

## Verification

1. `pnpm check-types` + full test suite for `packages/acp`,
   `packages/driver/agent-cli`, `packages/runtime` — clean.
2. Unit test: a mock ACP connection whose `prompt()` never resolves —
   confirm the watchdog fires after the configured timeout and a
   `session:turn-end` event is emitted with `stopReason:"watchdog-timeout"`.
3. Unit test: activity events (`onActivity` calls) reset the timer — a
   "slow but active" mock (activity pulses every N seconds, total turn
   duration exceeds the timeout, but gaps between pulses never do) must NOT
   trigger the watchdog.
4. Live test if reproducible: the exact scenario from today (hermes hitting
   its internal max-tool-iterations cap) — confirm the session no longer
   hangs forever and `turn-end` fires within the configured timeout window.
   If not reliably reproducible live, the unit tests above are the
   verification bar — say so explicitly rather than claiming live
   verification that didn't happen.

## Critical files

- `packages/acp/src/client/index.ts` — `AcpClientOptions`, `prompt()`,
  `makeIterator()`, the watchdog timer itself
- `packages/driver/agent-cli/src/protocol/acp-client.ts` — thread
  `turnIdleTimeoutMs` through `AcpProtocolOptions`
- `packages/driver/agent-cli/src/types.ts` — `AgentCliConnectOptions`
- `packages/driver/agent-cli/src/define-agent-cli.ts` — pass the
  adapter-manifest-declared timeout (if any) through to connect options
- `adapters/hermes/src/index.ts` — consider declaring a
  `turnIdleTimeoutMs` in the manifest if the mechanism supports
  per-adapter defaults
- Reference/compose with (don't duplicate):
  `_agentproto-worktrees/session-liveness/PLAN.md`'s `onActivity` plumbing

## Report back

Whether you built on top of session-liveness's `onActivity` plumbing or had
to stub minimal activity-tracking (and why), unit test results, and honest
live-reproduction status.
