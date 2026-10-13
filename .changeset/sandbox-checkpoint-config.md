---
"@agentproto/runtime": minor
---

Make the sandbox checkpoint safety net configurable instead of one env var: `defaults.sandbox.checkpoint` (`enabled`, `on: ["turn-end","teardown"]`, `refPrefix`, `minIntervalMs`, `timeoutMs`) in config.json, overridable per spawn via `agent_start({ sandboxCheckpoint: false | {...} })`. The spawn's override is kept on the session descriptor so a restart or a boot-time re-attach resolves the same policy. `"teardown"` absent from `on` reverts the teardown delivery to only counting uncommitted files. A checkpoint's commit message and record now carry the turn number it was taken after, and a session whose box ended with uncommitted work in it now sends its parent an explicit notice naming the rescue branch and a `git fetch` command, instead of only writing it into its own transcript. `AGENTPROTO_SANDBOX_CHECKPOINT_INTERVAL_MS` keeps working as the fallback for `minIntervalMs`.
