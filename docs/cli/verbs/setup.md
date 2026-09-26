# `agentproto setup`

```text
agentproto setup [--yes] [--dry-run] [--json] [--only <step>...] [--skip <step>...]
agentproto setup <slug> [--force] [--dry-run] [--only <stepId>]...
```

Two modes, told apart by whether a slug is given:

- **No slug — the onboarding wizard.** Takes a machine from zero to a
  working install. Described first, below.
- **`setup <slug>` — adapter setup.** Re-runs one adapter's AIP-29 setup
  pipeline. Unchanged; see [Adapter setup](#adapter-setup-setup-slug).

`agentproto onboard` is an alias of the wizard ([`onboard.md`](./onboard.md)).

## The onboarding wizard

For each step the wizard runs the same read-only checks as
[`agentproto doctor`](./doctor.md), proposes only what is missing,
applies what you accept **through the existing verbs** (never a
re-implementation), then re-checks the step and shows the result.

| Step | Proposes | Default | Runs |
|------|----------|---------|------|
| `preflight` | Node too old ⇒ **stops** with the fix. Outdated CLI ⇒ update | no | `npm i -g @agentproto/cli@latest` |
| `workspace` | No workspace ⇒ register the cwd (slug from the dir name, editable) | yes | `workspace add` |
| `daemon` | macOS: install the launchd service, then start it. Installed but down ⇒ start. Stale PATH / other version ⇒ restart. Linux: a detached `serve` (service support is coming) | yes (restart: no) | `daemon install` + `daemon start` / `daemon restart` / `install-mcp`'s serve fallback |
| `agents` | Multiselect of catalog harnesses not installed. Nothing pre-selected if one works, else claude-code | — | `install <slug>` |
| `auth` | Multiselect of discovered, not-imported credentials (all pre-selected). Then an optional API key (provider + masked input). Prints runnable models per harness | yes / no | `auth profile import` / `auth provider set` |
| `clients` | Multiselect of detected clients without the MCP server (pre-selected). Wrong port ⇒ update | yes | `install-mcp --agent … --yes` / `install-mcp --update` |
| `skills` | Missing or stale skill pack ⇒ install it | yes | `install skill/agentproto-pack --force` |
| `local-models` | Checks each configured local/LAN model endpoint (`~/.agentproto/llm-endpoints.json`, plus `forge` from `FORGE_BASE_URL`) answers `/models`; warns if not. Manage them with [`llm endpoints`](./llm.md) | — | nothing |
| `first-run` | A 20-second test session on your best harness: spawn, one prompt, stream the reply, stop | yes | daemon `/sessions/agent` |

Claude Code can't load a plugin headlessly: after the skills step the
wizard prints the `/plugin marketplace add …` command to run inside
Claude Code. It ends with a full doctor run and "Next" hints (the
Control Center URL, `agentproto remote enable --qr` for your phone,
`agentproto pair offer`, `agentproto sandbox list`). It never opens a
remote tunnel.

### Flags

| Flag | Purpose |
|------|---------|
| `--yes`, `-y` | Apply every default without prompting. Actions that need a secret (the API key) are never applied. |
| `--dry-run` | Show what would be proposed, with defaults; change nothing (no ledger write either). |
| `--json` | Print the final report on stdout: the doctor JSON after setup plus `applied` (`{ step, action, title, status, detail?, selected? }`). The UI goes to stderr. |
| `--only <step>` / `--skip <step>` | Repeatable step filters. |

Without a terminal, `--yes` or `--dry-run` is required; otherwise the
wizard exits `78` with a hint.

### Resume

Progress is recorded in `~/.agentproto/setup/_onboarding.json`
(`{ startedAt, steps: { <id>: { status, at, actions } } }`). Re-running
resumes naturally: a step whose checks are already fine is shown as one
`✓` line and skipped. A passed first-run test isn't offered again.

### Output

Each step is either one `◆` line (already fine), or its open checks, the
actions taken, and the re-checked result:

```text
┌  agentproto setup
│
◆  Preflight
│
◇  Coding clients (MCP)
│  ! Windsurf  detected, agentproto MCP server not registered
│      → fix: agentproto install-mcp --agent windsurf
│
◇  Register the agentproto MCP server with your coding clients — registered with windsurf — restart those clients to pick it up
│
│  ✓ Cursor  registered in ~/.cursor/mcp.json
│  ✓ Windsurf  registered in ~/.codeium/windsurf/mcp_config.json
│
◆  Local model (optional)  none configured — point FORGE_BASE_URL at an OpenAI-compatible server (vLLM, Ollama…) to use one
│
└  30 ok · 1 warn · 0 missing · 0 broken
```

A failing action is reported (with its verb's last output lines) and the
wizard moves on; it never aborts later steps.

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Done, and the closing doctor run has no required step missing/broken. |
| `1` | A required step is still missing/broken, the wizard was stopped (e.g. Node too old), or cancelled. |
| `2` | Usage error (unknown flag or step id). |
| `78` | No terminal and neither `--yes` nor `--dry-run`. |

### Examples

```bash
agentproto setup                          # guided
agentproto setup --dry-run                # what would it do?
agentproto setup --yes --skip first-run   # unattended, no test session
agentproto setup --only clients --only skills
```

## Adapter setup (`setup <slug>`)

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

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Setup completed (or all steps skipped). |
| `2` | Usage error, e.g. missing slug. |
| `78` | An interactive setup step needed a TTY but `stdin` was not one. Programmatic hosts can key off this code to offer a real terminal. |
