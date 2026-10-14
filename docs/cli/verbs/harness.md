# `agentproto harness`

```text
agentproto harness outdated [--json]                        read-only freshness report
agentproto harness check <slug> [--json]                    ACP smoke probe
agentproto harness upgrade (<slug>…) | --all [--dry-run] [--force] [--json]
```

Freshness and safe upgrades for the **harness** — the agent CLI binary an
adapter spawns (`opencode`, `gemini`, `copilot`, …). This is a different
registry from [`adapters`](./adapters.md): `agentproto adapters outdated`
reports on the adapter *packages* (`@agentproto/adapter-*`), while this
verb reports on the thing those packages spawn.

Every probe here is time-bounded and degrades to "unknown" rather than
guessing: an offline machine reports `unknown`, never "behind", and the
read-only verbs still exit 0. See
[the harness-upgrades guide](../guides/harness-upgrades.md) for the
pinned-npx rule, the range guard, rollback, and the weekly-report
recipe.

## `outdated`

```bash
agentproto harness outdated
agentproto harness outdated --json
```

One row per installed (resolvable) adapter: the installed harness
version, the latest published version, and a verdict.

```text
SLUG          INSTALLED  LATEST   STATUS    NOTE
gemini        0.1.2      0.1.3    behind    run `agentproto harness upgrade gemini`
claude-code   1.0.12     1.0.31   pinned    pinned — bump the pin in adapters/claude-code
opencode      1.18.18    1.18.18  current
```

| Status | Meaning |
|--------|---------|
| `current` | Installed matches the latest published version. |
| `behind` | A newer version is published. |
| `pinned` | The adapter runs through a pinned `npx -y <pkg>@<x.y.z>` — the pin itself is the effective version; bump it via a PR, not an installer. |
| `unknown` | A probe failed (offline, `version_check` broken, adapter unresolvable) — never a guess. |

The installed version comes from the adapter's AIP-45 `version_check`
presence probe; the latest version from its `upgrade.latest` declaration
(`npm view`, or the newest GitHub release). `--json` emits the row array:
`{ slug, installed, latest, status, inRange, upgradable, pin?, note? }`,
where `inRange` is `latest` against `version_check.range` and
`upgradable` is true only when `harness upgrade <slug>` would actually
act (declared upgrade + behind + in range).

`outdated` is strictly read-only and always exits 0 — it is safe to run
from cron (see the [weekly report recipe](../guides/harness-upgrades.md#weekly-report-recipe)).

## `check`

```bash
agentproto harness check opencode
agentproto harness check opencode --json
```

ACP smoke probe: spawns the installed harness the same way the driver
does (`bin` + `bin_args`, a fresh temp cwd), runs the two-call ACP
handshake over stdio JSON-RPC —

1. `initialize` — the harness must negotiate a protocol version
   agentproto speaks,
2. `session/new` — the harness must return a real session id for that
   cwd,

then tears the whole process tree down. Deliberately **no
`session/prompt`**: the handshake proves the protocol and a usable
session without spending a single token, which is what makes this safe to
run after every upgrade.

```text
opencode: ACP ok (protocolVersion 1, loadSession)
```

Exit codes: `0` compatible (or skipped: a non-ACP protocol —
`proprietary`/`print` — has no handshake to answer and is reported as
skipped, not failed); `1` incompatible or the probe could not run. The
whole probe is bounded at 30s — a harness that never answers fails the
probe, it never hangs the verb. `--json` emits
`{ slug, protocol, ok, protocolVersion?, loadSession?, error? }`.

## `upgrade`

```bash
agentproto harness upgrade opencode
agentproto harness upgrade opencode gemini
agentproto harness upgrade --all
agentproto harness upgrade opencode --dry-run
agentproto harness upgrade opencode --force --json
```

Runs the adapter's declared `upgrade.cmd` in place (argv, inherited
stdio — you watch it happen), re-reads the installed version, re-runs the
ACP smoke probe, and when the probe fails, runs the declared rollback
with the previously installed version substituted for `{version}`.

Guards — each refuses with a reason **before anything runs**, and each
is bypassable with `--force`:

- no `upgrade` declared (pinned-npx and curl-only harnesses are bumped
  in this repo instead),
- latest version unresolvable (offline), or installed version unreadable,
- latest outside `version_check.range` — bump the range first,
- a live daemon session of that adapter exists (checked against
  `GET /sessions?onlyAlive=true` on the discovered daemon).

Outcomes, and what they mean for the exit code:

| Outcome | Exit | Meaning |
|---------|------|---------|
| `upgraded` | 0 | cmd ran, new version read back, probe passed. |
| `current` | 0 | already at the latest version — nothing ran. |
| `dry-run` | 0 | printed the command, ran nothing. |
| `refused` | 1 | a guard tripped (reason printed); nothing ran. |
| `rolled-back` | 1 | probe failed, the declared rollback restored the previous version. |
| `failed` | 1 | probe/upgrade failed and could NOT be undone — the error names the previous version. |

`--all` upgrades every installed adapter that declares an `upgrade.cmd`
(pinned/curl-only ones declare nothing and are skipped). `--json` emits
the per-slug result array.

## See also

- [Harness upgrades guide](../guides/harness-upgrades.md) — pinned-npx
  rule, range guard, rollback, weekly report recipe
- [`agentproto adapters outdated`](./adapters.md#outdated) — the
  adapter *packages*, not the harness binaries
- [`agentproto cron`](./cron.md) — scheduling the weekly report
