# `agentproto preset`

```bash
agentproto preset list [--json]
agentproto preset show <id> [--json]
agentproto preset resolve <id> [--harness <slug>] [--json]
agentproto preset add <id> --label <label> [axis flags]
agentproto preset delete <id>
```

Manage user-owned, saved spawn configurations. A preset stores any subset of
the adapter, model, route, auth-profile, posture, effort and context axes in
`~/.agentproto/presets.json`; omitted axes keep the adapter default.

`--posture` accepts the portable canonical values. For an adapter-specific
native posture, use `--mode-id <id>` instead (for example `--mode-id architect`);
the two flags are mutually exclusive.

Other axis flags: `--base-url <url>` (custom gateway URL — requires
`--gateway`) and `--context <profile>` (`full`, `lean`, or an
adapter-specific context profile).

Discovery and composition axis flags (AIP-46):

| Flag | Description |
|------|-------------|
| `--tag <tag>` | Discovery tag (repeatable). |
| `--extends <id>` | Apply another preset first (repeatable, left to right). |
| `--default-for <slug>` | Make this the default preset for a harness. |
| `--allow-list <id>` | Model list this preset allows (repeatable). |
| `--block-list <id>` | Model list this preset blocks (repeatable). |

`resolve` prints every resolved axis with the layer that produced it
(`manifest`, `host`, `definition`, `harness-preset`, `preset:<id>`,
`preset-default:<id>`, `request`). The same resolution runs at spawn time.

This is not a provider preset. Static gateway definitions such as OpenRouter
and Moonshot are listed with `agentproto provider-preset list`.

```bash
agentproto preset add fast-deepseek --label "Fast DeepSeek" \
  --adapter hermes --model deepseek/deepseek-v4-pro --gateway openrouter \
  --profile openrouter-api --posture bypass --effort high \
  --tag fast --allow-list zero-cost
agentproto preset resolve fast-deepseek --harness hermes
```
