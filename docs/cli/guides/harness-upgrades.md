# Harness upgrades

An adapter (`@agentproto/adapter-opencode`) is the glue; the **harness**
is the agent CLI binary it spawns (`opencode`, `gemini`, `copilot`, …).
`agentproto adapters outdated` tracks the glue. This guide is about
keeping the binaries current — through three verbs, three guards, and one
rollback story, all on by default report-only.

Status: Stable

## The three verbs

```bash
agentproto harness outdated [--json]     # what's behind? read-only, always exit 0
agentproto harness check <slug> [--json] # does it still speak ACP? exit 1 if not
agentproto harness upgrade <slug…> | --all [--dry-run] [--force] [--json]
```

The full flag reference lives on the
[`harness` verb page](../verbs/harness.md). The short version:

- `outdated` never writes anything. Every probe degrades to "unknown"
  (offline machine, broken `version_check`) instead of guessing, and the
  verb still exits 0 — that is what makes it safe to run on a timer.
- `check` is the ACP smoke probe: `initialize` + `session/new` against
  the installed harness in a temp cwd, then the process tree is torn
  down. No `session/prompt`, so no tokens are spent. Non-ACP protocols
  (`proprietary`/`print`) are reported as skipped, not failed.
- `upgrade` runs the adapter's declared `upgrade.cmd` with inherited
  stdio, re-reads the version, re-runs the smoke probe, and rolls back
  when the probe fails (see [Rollback](#rollback)).

Start with a dry run — it prints the exact argv without running
anything:

```bash
agentproto harness outdated
agentproto harness upgrade opencode --dry-run
agentproto harness upgrade opencode
```

## The pinned-npx rule

Some adapters don't run a globally-installed binary at all: they run
`npx -y <pkg>@<x.y.z>` with the version **pinned in the adapter
itself** (`bin_args`). Today that is `claude-code` and `codex`.

For those, the pin is the truth — what npx will run — so a global npm
install of the same package is irrelevant:

- `harness outdated` reports the pin against the registry and marks the
  row `pinned` with the fix spelled out: bump the pin in
  `adapters/<slug>/`.
- `harness upgrade` refuses them: there is nothing safe for agentproto
  to run on this machine. The upgrade story is a PR to this repo that
  moves the pin, then a release of the adapter package.

Adapters with no global npm install at all (curl-only, or an
experimental npm channel) declare no `upgrade` block either — same
refusal, same reason: agentproto will not improvise an installer.

Currently declaring an in-place `upgrade` block: `opencode`,
`gemini`, `pi`, `mastracode`, `copilot-cli` (npm) and `hermes`
(newest GitHub release + `hermes update`).

## The range guard

Every adapter declares an AIP-45 `version_check.range` — the band of
harness versions this adapter is known to work with. `upgrade` reads the
latest published version and refuses to install it when it falls outside
that band:

```text
gemini: refused — latest 1.0.0 is outside >=0.1.0 — bump version_check.range (or pass --force)
```

This is deliberate: a harness major bump can break the adapter's ACP
expectations, and the range is where that compatibility is declared. The
fix is a PR widening `version_check.range` (after you've verified the
new harness works), not `--force` — though `--force` exists for when you
know what you're doing.

## The live-session guard

Upgrading a harness binary out from under a running session is a good
way to get a half-migrated process. Before running `upgrade.cmd`, the
verb asks the daemon whether any live session of that adapter exists
(`GET /sessions?onlyAlive=true`, matched on `adapterSlug`) and refuses
if one does:

```text
opencode: refused — live session(s) on this adapter — stop them or pass --force
```

Stop the sessions (`agentproto sessions stop <id>`) and re-run, or pass
`--force` if you accept the risk. No reachable daemon is not treated as
evidence of a live session — the check is best-effort, and the rollback
below still covers a bad upgrade either way.

## Rollback

An upgrade isn't done when the installer exits 0 — it's done when the
harness still speaks ACP. So `upgrade` re-runs the smoke probe on the
new version, and when the probe fails it runs the adapter's declared
`rollback` command with `{version}` replaced by the version that was
installed before:

```jsonc
// adapters/opencode (AIP-45 upgrade block)
"upgrade": {
  "latest": { "npm": "opencode-ai" },
  "cmd": ["npm", "i", "-g", "opencode-ai@latest"],
  "rollback": ["npm", "i", "-g", "opencode-ai@{version}"]
}
```

Three outcomes when the probe fails:

| Declared rollback? | Outcome | What you see |
|--------------------|---------|--------------|
| yes, and it restored the version | `rolled-back` | the old version is back; exit 1 so scripts notice |
| no (e.g. `hermes update` — a git updater has no pinned previous version) | `failed` | loud error **naming the previous version** so you can restore it by hand |
| rollback itself failed | `failed` | loud error naming the previous version and why the rollback failed |

An upgrade that succeeds, is already current, or is a `--dry-run`
exits 0; anything that was refused, rolled back, or failed exits 1.

## Weekly report recipe (report-only)

`outdated` is read-only and always exits 0, so the safest useful setup
is a weekly cron job that runs it and leaves the upgrade to you. The
daemon's `--command` jobs run an allowlisted shell command each tick
(see the [cron guide](./cron.md) for the full flag list):

```bash
agentproto cron add --schedule "0 8 * * 1" \
  --command agentproto \
  --args harness \
  --args outdated \
  --args --json \
  --label "harness-freshness-report"
```

Every Monday at 08:00 the daemon runs `agentproto harness outdated
--json`; the job's `lastResult` in `agentproto cron list` carries the
report. Read it with:

```bash
agentproto cron list            # last result per job
agentproto harness outdated     # or just re-run it by hand, any time
```

This is **report-only by default** on purpose: nothing in this recipe
installs, upgrades, or writes anything. When the report shows a harness
you want to move, upgrade it by hand —

```bash
agentproto harness check <slug>
agentproto harness upgrade <slug>
```

— or, if you deliberately want unattended upgrades, replace the job's
`--args` with `harness upgrade --all` and accept that a failed probe
will roll back (or fail loudly) on a machine nobody is watching.

## See also

- [`agentproto harness`](../verbs/harness.md) — full flag reference
- [`agentproto adapters outdated`](../verbs/adapters.md#outdated) —
  adapter *packages*, not the harness binaries
- [Cron jobs](./cron.md) — `--command` jobs, schedules, `lastResult`
