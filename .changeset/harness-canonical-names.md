---
"@agentproto/runtime": minor
"@agentproto/cli": minor
"@agentproto/worktree": minor
---

`harness` is the canonical name of the agent CLI a session runs, everywhere `adapter` was accepted. Additive and non-breaking: every old name still works and returns a dated warning ("`adapter` is deprecated and will be removed in the next major of @agentproto/runtime; use `harness`").

- New MCP tools `harness_models` and `harness_install` (argument `harness`), twins of `adapter_models` / `adapter_install`, which now warn. `harness_list` returns its rows under `harnesses`, with `adapters` kept as a deprecated duplicate; `adapter_list` warns.
- New HTTP routes `GET /harnesses` and `POST /harnesses/:slug/install`; `POST /sessions/agent` (and `/sessions/chat`) take `harness`; `GET /sessions/:id/export` and `GET /catalog/models` take `?harness=`. The `/adapters` routes and the `adapter` field keep working, with a warning.
- `harness` is the documented field and `adapter` the deprecated alias on `agent_start` (the old inversion is fixed), `session_continue_fresh` / handoff, `app_run` (and AGENT.md `metadata.harness` first), `catalog_models`, `agent_export`, `user_preset_save`, `POST /user-presets`, `workflow_start` steps, `inbound_watcher_start`, judge gates (`judge.harness`), decision workflow `profileOptions.escalation.harness` and the egress-health probe. Resolution is `harness ?? adapter ?? preset.harness ?? preset.adapter`; a warning rides the tool result's `warnings` and, for spawns, `session:harness-warning`.
- The session descriptor always carries `harness` when it carries `adapterSlug` (including rows persisted before the field existed, and summary/compact/tree projections); `adapterSlug` stays as a deprecated duplicate. Saved presets mirror `harness` and `adapter`.
- Config: `defaults.harnesses.<slug>.*` and `daemon.harnessCacheRetentionDays` are read first, with the old `defaults.adapters.<slug>.*` / `daemon.adapterCacheRetentionDays` as a fallback (a field under `defaults.harnesses` wins) and a once-per-content warning. The daemon never rewrites your config file. `config_get` lists the new keys and flags the old ones with `deprecated: { replacedBy, message }`.
- CLI: `--harness` on `cron add`, `preset add`, `auth provider set`, `sandbox egress-health`, `sessions export` / `story`, and `worktree-agent run`; `--adapter` keeps working and prints the deprecation on stderr. `auth provider set`, `install` and `mcp mount-default` now write under `defaults.harnesses`.
- New exports: `harnessDefaultsFor`, `harnessDefaultsMap`, `adapterDeprecation`, `resolveHarnessAlias`, `ADAPTER_FIELD_DEPRECATION`, `HARNESS_ALIAS_REMOVAL` (and `harnessConfigDeprecations`, `harnessCacheRetentionDays` from `@agentproto/runtime/config`).
