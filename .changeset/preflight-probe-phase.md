---
"@agentproto/runtime": patch
---

Replace sandbox preflight's boolean `runsWithSpawnAuth` with an explicit `phase: "prelaunch" | "postlaunch"`. `prelaunch` (the default for config probes) runs before the agent starts and always runs, authed spawn or not; `postlaunch` needs the session's credentials and is skipped with a warning on an authed spawn. The built-in `model-answers` probe is `postlaunch`. `runsWithSpawnAuth` is still accepted as a deprecated alias (`true` maps to `prelaunch`, `false` to `postlaunch`). Behaviour change: a config probe that set neither field was previously skipped on an authed spawn; it now defaults to `prelaunch` and runs.
