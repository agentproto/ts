---
"@agentproto/runtime": minor
"@agentproto/cli": patch
"@agentproto/apps": patch
"@agentproto/skill-pack-agentproto": patch
---

A harness preset can omit `profileRef` and `defaultModel`. No `profileRef` means the harness bills on its own login (`claude-code-cloud`, or `claude-code`/`codex` logged in): a spawn through that default passes no `access`, exactly like an `agent_start` without `access`. No `defaultModel` means the vendor picks its own default (no model sent). An explicit `profileRef` keeps the existing exists/enabled/allowlist checks. `harness_preset_create`, `harness_preset_list`, default resolution at spawn, `agentproto preset resolve`, reviewer preset resolution and the config UI handle the absent fields.
