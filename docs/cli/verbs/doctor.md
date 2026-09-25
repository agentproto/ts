# `agentproto doctor`

```text
agentproto doctor [--json] [--only <step>...] [--skip <step>...]
```

Read-only health check of an agentproto install. Walks the onboarding
checklist, prints one line per check with the exact command that fixes it,
and changes nothing: no file writes, no process starts, no prompts.

| Step | Required | Checks |
|------|----------|--------|
| `preflight` | yes | Node.js ≥ 20.9.0 · OS (darwin/linux) · CLI version vs npm latest · `~/.agentproto` writable |
| `workspace` | yes | At least one registered workspace · cwd inside one |
| `daemon` | yes | `/health` on the configured port (version + uptime, vs this CLI) · macOS: launchd plist installed + loaded, plist PATH fresh vs your login shell |
| `agents` | yes | Each catalog adapter: package resolvable + its `version_check` presence probe passes. At least one needed |
| `auth` | no | Auth profiles (count, enabled) · credentials `auth discover` finds that aren't imported yet |
| `clients` | no | Each detected coding client: agentproto MCP server still present in its config, pinned URL matches the daemon port |
| `skills` | no | Each skill-capable adapter: agentproto skill pack installed and current |

Secrets are never read into the report — `auth` lists only origin, endpoint
and method.

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | `false` | Print `{ version, platform, steps, summary }` instead of the human report. Attach it to bug reports. |
| `--only <step>` | *(all)* | Run only this step; repeatable. |
| `--skip <step>` | *(none)* | Skip this step; repeatable. |
| `-h`, `--help` | | Usage. |

An unknown step id exits `2`.

## Output

```text
agentproto doctor — v0.21.5 · darwin/arm64

Daemon
  ✓ Daemon /health  v0.21.5, up 11m18s at http://127.0.0.1:18790
  ! launchd service  not installed (a foreground `agentproto serve` also works)
      → fix: agentproto daemon install

Skills (optional)
  ! claude-code  plugin v0.5.0 is older than the pack v0.8.3
      → fix: agentproto install skill/agentproto-pack --force

25 ok · 9 warn · 0 missing · 0 broken
Run `agentproto doctor --json` and attach it to bug reports.
```

Glyphs: `✓` ok · `!` warn · `✗` missing/broken · `-` skipped. Colour only
when stdout is a TTY and `NO_COLOR` is unset.

A check that couldn't run (offline npm, a failed login-shell probe, a step
over its time budget) reports `warn` with `not checked: <reason>` — never
`broken`. A step that throws becomes a single `broken` check and the rest
still run.

## Exit code

`1` when a required step (`preflight`, `workspace`, `daemon`, `agents`) has a
`missing` or `broken` check, `0` otherwise. `warn` never fails.

## Examples

```bash
# The whole checklist
agentproto doctor

# Just the daemon, as JSON
agentproto doctor --only daemon --json

# Skip the slower adapter probes
agentproto doctor --skip agents
```

## See also

- [`onboard.md`](./onboard.md) — wire MCP + skills in one pass
- [`daemon.md`](./daemon.md) — the `daemon` step's fixes
- [`install-mcp.md`](./install-mcp.md) — the `clients` step's fixes
- [`auth.md`](./auth.md) — `auth discover` / `auth profile import`
