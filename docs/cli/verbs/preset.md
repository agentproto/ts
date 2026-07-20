# `agentproto preset`

```bash
agentproto preset list [--json]
agentproto preset show <id> [--json]
agentproto preset add <id> --label <label> [axis flags]
agentproto preset delete <id>
```

Manage user-owned, saved spawn configurations. A preset stores any subset of
the adapter, model, route, auth-profile, posture, effort and context axes in
`~/.agentproto/presets.json`; omitted axes keep the adapter default.

This is not a provider preset. Static gateway definitions such as OpenRouter
and Moonshot are listed with `agentproto provider-preset list`.

```bash
agentproto preset add fast-deepseek --label "Fast DeepSeek" \
  --adapter hermes --model deepseek/deepseek-v4-pro --gateway openrouter \
  --profile openrouter-api --posture bypass --effort high
```
