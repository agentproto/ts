# `agentproto setup`

```text
agentproto setup <slug> [--force] [--dry-run] [--only <stepId>]...
```

Re-runs an adapter's post-install configuration pipeline (steps the
adapter manifest declares under `setup[]`). Same engine
`agentproto install` invokes automatically after a successful install
— this verb is for re-running setup on an already-installed adapter
(adding a new step, fixing a broken one, re-running after
`--skip-setup`).

## Step kinds

| Kind | Status | Notes |
|------|:--:|-------|
| `cmd` | ✓ | Shell command. Optional `skip_if` short-circuit + `persist` (stdout → env / secret / pipe to a config cmd). |
| `prompt` | ✓ | Interactive prompt — `text`, `boolean`, `select`, `secret`. `select.options` may be a literal list or a dynamic `cmd` (one option per stdout line, `value\tlabel` form). |
| `external` | ⚠ | Opens a URL via `open` / `xdg-open` and waits for the user to paste the redirect param back. Callback-server flow not yet wired. |
| `oauth` | ✗ | Placeholder — needs a SECRETS.md driver in the host. Raises a clear "not implemented" error. |

## Idempotency

Three layers, in order:

1. **Manifest `version_check`** — applied by `install` before setup
   even runs.
2. **Per-step `skip_if.cmd`** — asks the live system. Matching exit
   code (default `0`) skips the step. Works on fresh machines without
   local state. Step is still ledger-recorded as
   `skippedViaSkipIf: true`.
3. **Ledger** at `~/.agentproto/setup/<slug>.json` (mode 0600) —
   records every successful (or `skip_if`-skipped) step with
   timestamp + `persistedTo` slot. Re-runs short-circuit
   ledger-known steps with `✓ already completed`.

`--force` ignores both `skip_if` and the ledger and re-runs every
step. `--dry-run` prints the would-be steps without executing.

## Flags

| Flag | Purpose |
|------|---------|
| `--force`, `-f` | Re-run every step regardless of `skip_if` / ledger. |
| `--dry-run` | Don't spawn / prompt — just log what would happen. |
| `--only <stepId>` (repeatable) | Run only the named step ids, in their declared order. |

## Persist slots

Each step's `persist` block (if any) decides where the captured value
lands. Exactly one of:

- **`env: <NAME>`** — stored in the ledger's `envValues` (mode 0600).
  `agentproto run` lifts these onto the spawn env so adapters that
  read from env (CLAUDE_API_KEY, OPENAI_API_KEY, …) pick them up.
- **`secret_slug: <slug>`** — recorded in the ledger as a slot name
  only. The value is **never** stored locally. The host's secrets
  backend is expected to receive it out-of-band; the local CLI prints
  a reminder to do so.
- **`cmd: <shell>`** — the cmd is run with `${value}` substituted
  (shell-escaped) into it. Used for piping into vaults, `gcloud
  secrets versions add`, etc.

The ledger never stores the value itself for `cmd` or `secret_slug`
slots, and never echoes it for any kind.

## Examples

```bash
# Run setup for a freshly-installed adapter
agentproto setup openclaw

# Re-run a single step (e.g. a token expired)
agentproto setup openclaw --only configure-token

# Force everything (clears caches, re-prompts secrets)
agentproto setup openclaw --force

# Preview what would happen without spawning
agentproto setup openclaw --dry-run
```

## Output

```text
[1/4] cmd/check-credentials ✓ skip_if matched — skipping.
[2/4] prompt/api-key  Enter your API key
[2/4] prompt/api-key  $ <prompt — masked>
[3/4] cmd/save-config $ openclaw config set token <value>
[4/4] external/oauth-grant  opening https://…
agentproto: setup for 'openclaw' complete.
```

Errors halt the pipeline:

```text
[2/4] cmd/check-network ✗ failed: cmd exited 7: connection refused
```

The ledger is saved incrementally — already-completed steps stay
recorded across a failure, so the next `agentproto setup <slug>` (or
`--only <next-step>`) doesn't re-prompt for what already worked.
