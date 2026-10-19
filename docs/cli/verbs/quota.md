# `agentproto quota`

```text
agentproto quota status --profile <ref> [--refresh] [--json]
```

Live **provider** quota for a named auth profile — "how much of this key's
rate limit / balance is left right now?" — read through the daemon's
`quota_status` MCP tool (AIP-67), which dispatches the profile's endpoint to
`@agentproto/model-intel`'s `QuotaReaderRegistry`.

## Why this exists

`agentproto usage rollup` ([`usage.md`](./usage.md)) estimates what
agentproto **spent** from its own local snapshots. `quota status` is the
other half: what the **provider** currently reports is left on that key,
fetched live on every call — `basis` is always `provider`, never a local
estimate. A profile with no registered reader, or a reader that returns
nothing (bad credential, unreachable provider, a response with no usable
figures), is an explicit error — never a fabricated `0%`.

## `status --profile <ref>`

```bash
agentproto quota status --profile my-moonshot-key
agentproto quota status --profile my-openrouter-key --json
agentproto quota status --profile my-moonshot-key --refresh
```

| Flag | Purpose |
|------|---------|
| `--profile <ref>` | **Required.** Auth-profile id (an id from `agentproto auth profile list`). Unlike the MCP tool itself, the CLI has no "calling session" to fall back to. |
| `--refresh` | Documented hint only — passed through to the tool, which has no cache yet; every call already reads live. |
| `--json` | Emit the raw `QuotaStatus` instead of the human-readable summary. |

Exit codes: `0` success, `1` no daemon found / tool returned an error
(`profile_not_found`, `no_reader`, `reader_returned_nothing`), `2` missing
`--profile` / unknown subcommand.

### Example output

```text
profile: my-moonshot-key
basis:   provider
  window 5h: 62% remaining, resets 2026-10-20T00:00:00.000Z
credits: 12.40 USD
```

## See also

- [`usage.md`](./usage.md) — the local spend-estimate twin of this verb
- [`auth.md`](./auth.md) — `auth profile list` to find a `--profile` id
