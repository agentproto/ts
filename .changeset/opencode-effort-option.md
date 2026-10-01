---
"@agentproto/adapter-opencode": minor
---

Add a spawn-time `effort` option to the opencode adapter. It fixes
`agent_start({ effort })` / any generic model+effort passthrough dying with
`[unknown_option at config.options.effort] Option 'effort' is not declared by
manifest 'opencode'`. Declared as a free-form string (the accepted vocabulary is
model-dependent) and applied via ACP `session/set_config_option(configId:
"effort")` after the session is created — opencode's ACP server advertises an
`effort` config option only for models with a reasoning axis, and rejects an
unsupported label best-effort (never fatal).
