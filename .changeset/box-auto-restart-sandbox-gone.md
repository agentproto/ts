---
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

feat(runtime): restartPolicy can move a box session to a fresh box when its box is gone

`restartPolicy.on` gains a third value, `"sandbox-gone"`. A box session
(`agent_start.sandbox`) that dies WITH ITS BOX GONE — lifetime cap reached,
provider reclaim, unrecoverable unreachability — can no longer be revived
in place, so a policy listing `"sandbox-gone"` schedules the same fresh-box
move `session_restart` takes (`restartAgentSession` → `spawnOnFreshBox`:
re-clone the workspace remote, re-check the `wt/` work branch out, restore
the last checkpoint) instead, after the same exponential backoff and under
the same `maxRetries`/`windowMs` crash-loop cap. The replacement session is
prompted once to continue the original task from where the pushed work
stops; a blocked move (no workspace remote, no tarball checkpoint, provider
missing) leaves the session dead with a single `[sandbox-gone]` notice and
never loops.

Box-gone detection reuses evidence the daemon already has — the reattach
pass's `endedReason:"sandbox_gone"`, recorded proxy/provider death messages,
the sandbox ledger's `gone` state, and one provider liveness probe — with no
new polling loop. Off unless a session's `restartPolicy.on` lists
`"sandbox-gone"`; classic `crashed`/`error` in-place revival is unchanged,
and non-box sessions never consult the probe.

New daemon config `daemon.sandboxGoneRestartDefault` (off unless set) applies
that policy to box sessions spawned with no explicit `restartPolicy`, so an
executor box can opt in once instead of per spawn; an explicit per-session
policy still wins, and turning it on also arms the restart sweep at 30s when
`daemon.restartSweepIntervalMs` is unset. Nothing changes for anyone who has
not set it.
