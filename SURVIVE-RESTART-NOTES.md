# SURVIVE-RESTART-NOTES — sandbox session survival audit (branch wt/sandbox-session-survive-restart)

Question: **what can stop SEVERAL boxes in the same second, and can any of
those paths stop a box that has live attachedSessions or unpushed work?**

## Every caller of provider stop/kill / `recordSandboxState(..., "stopped")`

1. **`SandboxAgentSessionProxy.close()`** — `sandbox-agent-session-proxy.ts:1180`
   (`host.stop()` / `pauseFn()` at the end of the `finally` chain; remote
   session kill at `:1157`). Callers through `sessions.ts`:
   - `reapIdle()` `sessions.ts:12737` — **automatic** idle-reap close
     (`{ idleReap }`): since commit 92fe2f0e it pauses the box whenever the
     final checkpoint did not prove the work delivered (no checkpoint
     configured, checkpoint failed, timed out, push nor bundle both failed).
     The refcount loser (`recordSessionDetach`, ledger
     `attachedSessions`) still protects survivors. Reaps ALL reapable rows in
     one sweep, sequential — **this is the "two unrelated boxes stopped in the
     same second" actor** (one pass, two thrifty `pushed`/`unchanged`
     checkpoints, two stops).
   - `kill()` `sessions.ts:12581` — explicit `agent_kill`/UI stop: teardown is
     intended (kill/pause per `sandboxTeardown`), refcount-guarded.
   - `closeWithOutcome()` `sessions.ts:12650` — steward close, same policy.
   - `markCrashedInternal()` `sessions.ts:8194` and
     `markSandboxExpiredInternal()` `sessions.ts:8249` — transport/watchdog
     death: the box daemon is presumed dead; plain `close()` (box teardown)
     is the intended cleanup and the watchdog already ran a last checkpoint.
   - daemon shutdown `sessions.ts:13798` — `close({ daemonShutdown: true })`
     is only reachable for sessions that have NO `detach` surface (device /
     local): provider-box sessions are DETACHED there (`sessions.ts:13779`).
   Also directly from `session-spawn.ts` (all failure branches):
   `:6024, :6051` (workspace/tar setup failure), `:6223` (`agent_start` on the
   box failed), `:6260` (app serve failure) — every one goes through
   `detachOnBootFailure()` first and tears the box only when no survivor is
   attached.
2. **`reapGcEntry()`** — `sandbox-gc.ts:143` (kill) / `:142` (pause), only
   reachable through the manual CLI `agentproto sandbox gc --apply`
   (`cli/src/commands/sandbox.ts:581`). It skips rows whose `originSessionId`
   is unknown, rows already `stopped`, and (AIP-36) any row whose remaining
   attachés are not all dead (`sandbox-gc.ts:56-65`). Manual + guarded.
3. **Boot reattach pass** — `sandbox-reattach.ts:401` (`state.session.close()`
   when the box or its session is gone/ended) — justified; the `failed`
   deadline path `releaseAttempt()` (`:183-190`) never stops anything.
4. **Boot ledger reconcile** — `serve.ts:1181 → reconcileSandboxLedger`
   (`sandbox-reconcile.ts`): read-only liveness probing, may stamp `gone`
   through `recordSandboxLiveness` (`sandbox-ledger.ts:341-363`), never calls
   a provider's stop/pause.
5. **Provider-internal cleanup on a failed reconnect** — `@agentproto/sandbox`
   reaps the box itself on a failed host boot (`SandboxHostBootFailedError.cleanedUp`,
   stamped via `markFailedBootLedger` `session-spawn.ts:5936`). Known sharp
   edge, out of scope here: the package-level cleanup for a fresh (non-reuse)
   shared boot kills the box; a destroy-mode boot is a solo box by
   construction, so no survivor is stranded unless a reuse raced it (reuse
   failure path records the detach first, `session-spawn.ts:5924-5935`).
6. **Shutdown (SIGTERM/SIGINT/SIGHUP + interactive TUI quit + the
   `process.on("exit")` net)** — `cli/src/commands/serve.ts:1246-1276, :1325-1329`
   call only `gateway.stop()`; `runtime/src/index.ts:4676` detaches every
   provider-box session (`sessions.detachSandboxSessions()`) AND the
   `sessions.shutdown()` net detaches again sync (`sessions.ts:13779`),
   never reaching a teardown. **Proven by test**
   (`sandbox-detach-reattach.test.ts`: shutdown of a sandboxTeardown:'kill'
   session detaches, never closes/stops).

## Bugs found and fixed

### B-1 — a re-attached session stopped the box under its survivors (- fixed)

`sandbox-reattach.ts:344` built the reattach proxy with
`ledger: { sandboxId, provider }` and **no `sessionId`**. The proxy's
shared-box refcount requires `ledger.sandboxId && ledger.sessionId`
(`sandbox-agent-session-proxy.ts:1172-1174`), so `survivorsLeft` was
hardcoded `false` for every re-attached session: its close() ran a "solo
teardown" — `host.stop()` + a `recordSandboxState(.., "stopped")` that also
wiped the ledger row's `attachedSessions` — even while another live session
of the same box existed, and never recorded its own detach (stale attaché →
`sandbox gc` then skipped that box forever). Fixed by passing
`sessionId: desc.id`; test "a re-attached session participates in the
shared-box refcount" asserts the box stays connected with the survivor.

### B-2 — no code path was fixed beyond B-1

With B-1 closed, every automatic path (idle reap, crash, boot, shutdown,
spawn-failure) now detaches-or-pauses and honors the on-disk refcount; only
explicit user actions (`agent_kill`, `sandbox gc --apply`, steward close)
still destroy boxes, by design.

## Audit-only observations (documented, not changed)

- Two daemons on different HOMEs have **independent ledgers**; the refcount
  is per-HOME. A box attached by a session of daemon A cannot see daemon B's
  attaché — acceptable, on the shared-bucket model each daemon only serves
  its own workspace buckets and never touches the other's sessions.
- The idle-reaper sweep (`runtime/src/index.ts:4329`) has no `isServed`
  cross-process gate (the eager/continue/reattach passes have one). Two
  daemons on the SAME `HOME`+workspace cannot coexist (`bootGatewayIdempotent`
  defers an EADDRINUSE boot to the live daemon), so the missing gate is not
  exploitable today; document if a multi-process supervisor ever reuses
  `runIdleReapPass` directly.
- The ledger's `attachedSessions` can go stale after a crash/SIGKILL death
  (documented in `sandbox-ledger.ts:71-77`); `sandbox gc` is then
  conservatively silent. Suggested follow-up: a boot-time sweep pruning dead
  attaché ids against the loaded registry.

## Zombie-box accounting ("stopped"-by-gossip)

`reapGcEntry` also stamps "stopped" when the provider's connect reports the
box missing (`sandbox-gc.ts:133-135`) — that honest be-careful case marks a
row dead because reality already did, not because we stopped it.

## Box-lifetime renewal while a session is busy (e2b 60-minute cap)

Verified 2026-10-18: renewal is ALREADY in place, no change needed.

- The RUNTIME proxy owns it (the provider is stateless on this axis):
  `sandbox-agent-session-proxy.ts` calls `host.extendTimeout(lifetimeMs)` on
  every prompt dispatch + streamed box event (throttled by
  `BOX_RENEW_THROTTLE_MS`), and a `BOX_ACTIVE_RENEW_INTERVAL_MS` (10 min)
  heartbeat fires as long as a turn is in flight, event or not. Ahead of the
  known deadline the guard renews once more (turn in flight) or runs a final
  checkpoint (`BOX_DEADLINE_GUARD_LEAD_MS`).
- The e2b provider implements it as `sandbox.setTimeout(min(ms, 1h))`
  (`packages/sandbox-e2b/src/provider.ts:641`), which resets the countdown
  from now. Boot sets it at `DEFAULT_SANDBOX_TIMEOUT_MS` (45 min).
- Hard limit: on Hobby/Base plans e2b caps CONTINUOUS runtime at ~1h from box
  CREATION regardless of renewals — nothing the daemon does can extend a busy
  box past start+60min there. Such a death is classified
  `endedReason: "sandbox-expired"` (clean end, work delivered), not `crashed`.
- Tests: `sandbox-proxy-renew.test.ts` (dispatch/event/throttle/idle
  discipline), `sandbox-proxy-deadline.test.ts` (heartbeat cadence + guard).

Integration proof of the whole restart chain on the fake provider lives in
`packages/runtime/src/__tests__/sandbox-restart-integration.test.ts`.
