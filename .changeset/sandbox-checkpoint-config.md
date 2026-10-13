---
"@agentproto/runtime": minor
---

Make the sandbox checkpoint safety net (`sandbox-box-death-recovery`) configurable instead of one env var: `defaults.sandbox.checkpoint` (`enabled`, `on: ["turn-end","teardown"]`, `refPrefix`, `minIntervalMs`, `timeoutMs`) in config.json, overridable per-spawn via `agent_start({ sandboxCheckpoint: false | {...} })`. `"teardown"` absent from `on` reverts the teardown delivery to only COUNTING uncommitted files instead of snapshotting them, for anyone who wants the pre-checkpoint behaviour back. A checkpoint's commit message and record now carry the turn number it was taken after, and a session whose box died with uncommitted work left in it now also sends its PARENT an explicit notice naming the rescue ref and a `git fetch` command to recover it, instead of only writing the notice into its own (now-dead) transcript. `AGENTPROTO_SANDBOX_CHECKPOINT_INTERVAL_MS` keeps working as the ultimate fallback for `minIntervalMs`.
