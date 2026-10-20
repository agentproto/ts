---
"@agentproto/runtime": minor
"@agentproto/routine": patch
"@agentproto/apps": patch
---

Bind AIP-41 routine `target.workflow` targets to the routine's own workspace: relative `file` paths resolve against the workspace root, the dispatched `workflow_run_file` call runs with `cwd` set to it, and `input.repoRoot` defaults to it (an explicit `repoRoot` still wins). Adds an exported `RoutineTargetOptions` type and an optional third parameter to `routineTargetToToolCall`; documents the behavior in the routine README and the repo-maintenance ROUTINE manifests.
