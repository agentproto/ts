---
"@agentproto/runtime": minor
"@agentproto/workflow-runtime": minor
"@agentproto/cli": minor
"@agentproto/apps": minor
---

Model role presets: switch the repo-maintenance reviewers between five named model sets with one key.

- `@agentproto/runtime`: `MODEL_ROLE_PRESETS` (`opus`, `sonnet`, `haiku`, `go-free`, `free-sonnet`) and a new `modelRolePreset` config key (hot), a layer between the daemon's `models` and the built-in defaults. `model_roles` takes a per-call `preset`, reports the preset in effect and each role's required `adapter` (`opencode/…`/`opencode-go/…` → `opencode`, `claude-*` → `claude-code`, via `adapterForModelId`).
- `@agentproto/workflow-runtime`: an `entry.mjs` agent step may pass `adapter` as a run-time selector; a selector that returns undefined keeps the agent ref's adapter.
- `@agentproto/apps`: the `maintain` workflow takes `reviewPreset` and spawns each reviewer on the adapter its model needs, so an OpenCode Go free model runs on opencode instead of claude-code.
- `@agentproto/cli`: `agentproto maintain --review-preset <name>`.
