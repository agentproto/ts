---
"@agentproto/runtime": patch
"@agentproto/sandbox": patch
"@agentproto/sandbox-e2b": patch
"@agentproto/sandbox-computer": patch
"@agentproto/sandbox-box": patch
---

fix(sandbox): never lose work to a box that outlives its welcome — bounded pre-deadline checkpoints, host-side rescue push on a wedged low-disk session, release dead-session boxes, capacity-free teardown

- A session's end-of-turn checkpoint raced the provider's reaper: the box
  hit its E2B lifetime mid-turn ("sandbox not found") and the periodic
  checkpoint had pushed nothing. The deadline-near checkpoint is now
  BOUNDED to the remaining lifetime minus a safety margin (it never runs
  past the deadline), and a renewal while a turn is in flight is retried
  instead of falling through to the checkpoint branch after one failure.
- Low disk + a wedged session (ENOSPC never settles after interrupt):
  when a forced low-disk checkpoint does not secure the box's work, the
  proxy runs a HOST-side rescue push — `git add -A` + `commit
  --no-verify` + force-push to a `rescue/<session>` branch, executed via
  `sandbox exec`, and emits the rescue outcome as an agent warning.
- A session that DIED (crashed / killed / errored) used to leave its box
  paused and RAM-held (the computer provider kept answering "capacity
  exhausted (available 511)"). The watchdog-driven death now ends with
  `close({ deathRelease: true })`: checkpoint → notify → REALLY release
  the box (kill/stop, never a memory-holding pause).
- Teardown and `sandbox rm --box` never need capacity: `SandboxProvider`
  gains an optional `remove(sandboxId)` that destroys the box on the
  control plane WITHOUT connecting to it (which used to RESUME a
  suspended computer just to delete it, needing free RAM first).
  `sandbox gc` / reaping prefers `remove`; a periodic automatic
  `sandbox gc` runs on the daemon (1 h cadence,
  `AGENTPROTO_SANDBOX_GC_INTERVAL_MS` overrides / disables) reaping
  boxes whose origin session is dead.
