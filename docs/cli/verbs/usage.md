# `agentproto usage`

```text
agentproto usage rollup --window <w> [--profile <ref>] [--json]
```

A local-derived, provider-agnostic **spend estimate** over a rolling
window — "how much did profile X / model Y / harness Z spend in the last
5h / 7d?". Reads the daemon's `GET /usage/rollup` route, which aggregates
the durable per-session `usage_snapshot` records the daemon writes at
every turn-end and exit.

## Why this exists

`basis` is always `local-estimate`: this is what agentproto priced
locally from the snapshots (adapter-reported cost, or tokens × the in-repo
catalog), **not** the provider's actual bill. Tokens for a model with no
catalog price are surfaced separately as `unpriced` rather than folded
into a fabricated `$0` — the estimate never invents dollars for a model it
can't price.

## `rollup --window <w>`

```bash
agentproto usage rollup --window 7d
agentproto usage rollup --window 5h --profile claude-max
agentproto usage rollup --window P1DT12H --json
```

| Flag | Purpose |
|------|---------|
| `--window <w>` | **Required.** Rolling window `[now − duration, now]`. Shorthand `<int><s\|m\|h\|d\|w>` (`5h`, `7d`, `30m`, `2w`) or ISO-8601 duration (`P7D`, `PT5H`, `P1DT12H`). |
| `--profile <ref>` | Filter to a single auth profile by its `profileRef`. |
| `--json` | Emit the raw rollup JSON instead of the human-readable summary. |

Exit codes: `0` success, `1` no daemon found / request failed, `2`
missing `--window` / usage error.

### Example output

```text
7d · basis: local-estimate · sessions: 3
TOTAL  $18.4210 · 1200000 in / 400000 out tok · 5000 unpriced tok

by profile
  claude-max  $18.4210 · 1200000 in / 400000 out tok · 0 unpriced tok

by model
  claude-sonnet-4-5  $18.4210 · 1200000 in / 400000 out tok · 0 unpriced tok
  totally-unknown-zzz  $0.0000 · 0 in / 0 out tok · 5000 unpriced tok

by harness
  claude-code  $18.4210 · 1200000 in / 400000 out tok · 5000 unpriced tok
```

## See also

- [`sessions.md`](./sessions.md) — `sessions` surfaces per-session usage
  (`costUsd`, tokens, context) that this verb aggregates across a window
- [`serve.md`](./serve.md) — the daemon that owns the `GET /usage/rollup`
  route this verb reads
