# `agentproto sandbox`

```text
agentproto sandbox list   [--no-probe] [--reconcile] [--json]
agentproto sandbox attach <provider> <sandboxId> [--config-json <json>] [--keep-alive] [--json]
agentproto sandbox rm     <sandboxId|label|id-prefix> [--box] [--yes] [--json]
agentproto sandbox gc     [--apply] [--pause] [--json]
agentproto sandbox checkpoint-gc [--repo <dir>] [--dry-run] [--apply] [--json]
agentproto sandbox exec   <provider> [--sandbox-id <id>] [--cwd <dir>] [--timeout <dur>]
                          [--env NAME=value ...] [--env-profile NAME=<profileId> ...]
                          [--file <local>:<boxPath> ...] [--json] -- <command...>
```

Browse the daemon's **sandbox ledger** (every box the daemon has booted,
reconnected to, or paused — stored in `~/.agentproto/sandboxes.json`), and
connect to already-existing boxes without tearing them down.

Provider credentials are read from `~/.agentproto/sandbox-creds/<slug>.json`
(written by the `setup_sandbox_provider` MCP tool); provider API keys (e.g.
`BOX_API_KEY`, `E2B_API_KEY`) must additionally be set in this process's own
environment.

## Subverbs

### `list`

```bash
agentproto sandbox list
agentproto sandbox list --json
agentproto sandbox list --no-probe
agentproto sandbox list --json --reconcile
```

Prints the sandbox ledger — every box the daemon has booted, reconnected
to, paused, or stopped — with its current state, idle-expiry, and the
origin session that spawned it.

The table includes a **LIVE** column showing the result of a per-row
provider liveness probe (`yes` / `no` / `?` probe-errored / `—`
provider can't probe). The LIVE column is the only reliable signal that
a box still exists on its provider: the STATE column reflects what the
daemon last did and may lag reality (a provider-reaped box still shows
`paused` until probed). Probes are network calls; pass `--no-probe` to
skip them.

This same probe pass is a **reconcile**: any row the provider confirms
gone is flipped to `state: "gone"` in the ledger (never deleted, and the
box itself is never touched — this is read-only against the provider).
Table mode reconciles by default; `--json` does not (a plain `--json` is a
raw, unprobed dump) unless `--reconcile` is also passed, which forces the
same pass and adds a `reconciled: {checked,alive,gone,unknown,skipped}`
summary to the JSON output. The daemon also runs this same reconcile
once at boot (best-effort, logged to stderr) so a stale ledger — dozens of
`paused` rows the provider actually reaped long ago — self-heals without
anyone running `sandbox list` first.

| Flag | Default | Description |
|------|---------|-------------|
| `--no-probe` | `false` | Skip the per-row provider liveness probes (no network calls). The LIVE column shows `—` for every row. Table mode only — `--json` never probes unless `--reconcile` is passed. |
| `--reconcile` | `false` | Force the provider-liveness/reconcile pass even under `--json` (table mode already does this by default), and include the `reconciled` summary in JSON output. |
| `--json` | `false` | Print the raw `{ sandboxes: […] }` JSON instead of the human table. |

### `rm <sandboxId|label|id-prefix>`

```bash
agentproto sandbox rm my-task-label
agentproto sandbox rm bx_abc123 --box --yes
```

Removes the ledger entry for the given box (resolved by exact label, full
`sandboxId`, or unique id prefix). By default the box itself is left
running/paused on the provider — only the local bookkeeping row is dropped.

| Flag | Default | Description |
|------|---------|-------------|
| `--box` | `false` | ALSO stop the box on its provider (destructive — the sandbox and all data inside it is torn down). Without `--yes`, an interactive terminal is asked to confirm. |
| `--yes` | `false` | Skip the interactive confirmation for `--box`. Required in non-TTY environments. |
| `--json` | `false` | Print `{ ok, removed, boxStopped }` as JSON. |

### `attach <provider> <sandboxId>`

Resumes the sandbox, ensures its agentproto daemon is healthy, and exposes
it with a PERSISTENT, token-gated URL (never an ungated one — a provider
that can't gate the port fails the command rather than printing an
insecure URL). Prints the connection descriptor and a paste-ready
`.mcp.json` snippet.

| Flag | Default | Description |
|------|---------|-------------|
| `--config-json <json>` | `{}` | Provider-specific `SandboxSpec.config` overrides, e.g. `'{"port":18790}'`. |
| `--keep-alive` | `false` | Keep the sandbox awake indefinitely for an always-on rendezvous. |
| `--json` | `false` | Print only `{"descriptor":…,"mcpConfig":…}` as JSON. |

### `gc`

```bash
agentproto sandbox gc              # dry run — print what would be torn down
agentproto sandbox gc --apply      # actually kill orphan boxes on the provider
agentproto sandbox gc --apply --pause   # pause instead of kill (stays reattachable)
agentproto sandbox gc --json       # machine-readable plan / outcomes
```

Reaps **orphan** boxes: ledger entries whose origin session ended in a
failure state (`error` / `killed` / `exited`) — the session can never
return to its box, so the box is wasted spend. Dry run by default;
nothing is torn down until `--apply` is passed.

Requires a running daemon to look up origin-session statuses.

| Flag | Default | Description |
|------|---------|-------------|
| `--apply` | `false` | Actually tear down (or pause) the orphan boxes and stamp their ledger rows `stopped`. Without this, the command only prints the plan. |
| `--pause` | `false` | With `--apply`: pause the boxes instead of killing them, keeping them reattachable via `sandbox attach`. Note: a paused e2b box still bills, so the default kill is usually preferable for orphans. |
| `--json` | `false` | Print the plan / outcomes as JSON instead of the human summary. |

### `checkpoint-gc`

```bash
agentproto sandbox checkpoint-gc          # dry run — table of every checkpoint ref
agentproto sandbox checkpoint-gc --repo ~/work/repo
agentproto sandbox checkpoint-gc --json   # machine-readable plan
agentproto sandbox checkpoint-gc --apply  # delete every ref listed SAFE
```

Reaps **stale checkpoint branches**: every
`agentproto-checkpoint/<work-branch>` ref on the remote that a sandbox
session's teardown no longer needs. A box that dies with uncommitted work
leaves its snapshot ref behind forever; this command judges each one SAFE
when the work it rescued is provably elsewhere:

* the PR of `wt/<slug>` is merged or closed on the forge (via the repo's
  forge client, when credentials resolve one);
* the snapshot's tree IS the remote `wt/<slug>` tip's tree or the base
  branch's tree: the content is already there verbatim;
* (clean snapshots only) the snapshot's parent commit is merged into base
  or the work branch, squash-merged (`git merge-tree --write-tree` yields
  exactly the base tree), or patch-merged (`git cherry` maps every commit
  onto an applied patch id).

A snapshot whose tree differs from its parent's carries uncommitted delta;
deleting it can lose that work, so only the PR and tree tiers can mark
those SAFE. Anything else comes back `keep` and stays on the remote.

| Flag | Default | Description |
|------|---------|-------------|
| `--repo <dir>` | cwd | Repo to run in; the remote acted on is its `origin`. |
| `--dry-run` | on | Table or `--json` plan; nothing is deleted. Mutually exclusive with `--apply`. |
| `--apply` | `false` | Delete every ref classified SAFE. Each delete is preceded by a FRESH re-plan, so a stale plan never deletes a ref whose classification changed. |
| `--json` | `false` | Print the plan (`{ refs: [...] }`) or the apply outcomes as JSON. |

The daemon also runs this same classification best-effort when a
sandboxed session exits: that session's OWN ref is deleted once it is
superseded (logged on failure, never blocking teardown). This command
remains the manual, repo-wide tool.

### `exec <provider>`

```bash
# Secret from an auth profile — the daemon reads it, you never hold it
agentproto sandbox exec e2b --env-profile OPENAI_API_KEY=openai-main -- python run.py

# Reuse an existing box, upload a script instead of inlining it
agentproto sandbox exec e2b --sandbox-id sbx_abc \
  --file ./job.sh:/home/user/job.sh --cwd /home/user --timeout 10m -- bash job.sh

# Machine-readable
agentproto sandbox exec e2b --json -- 'uname -a && id'
```

Runs **one command** inside a sandbox — the CLI twin of the `sandbox_exec`
MCP tool. It talks to the **running daemon** (`POST /sandboxes/exec`,
token-gated like every mutating route) so `--env-profile` resolves against
the daemon's keychain and auth profiles; the secret value never reaches the
CLI process, its argv, or its output.

Everything after `--` is the command. One argument is passed verbatim (so
`-- 'a && b'` is a shell snippet); several arguments are shell-quoted and
joined. Without `--sandbox-id` an **ephemeral** box is booted for the command
and always torn down afterwards; with it, the existing box is reused and left
as found.

**Exit code = the box command's exit code** (0-255). A failure that never
produced one — no live daemon, rejected input, unknown/disabled profile,
provider error — exits **125** with the reason on stderr (`--json` still prints
the daemon's `{ok:false, code, message}` body); usage errors exit **2**. The
two overlap if the box command itself exits 125 — read `--json` to tell them
apart.

| Flag | Default | Description |
|------|---------|-------------|
| `--sandbox-id <id>` | ephemeral | Run against this existing box. |
| `--cwd <dir>` | provider default | Absolute working directory **inside** the box. |
| `--timeout <dur>` | none | Per-command wall clock (`500ms`, `30s`, `10m`, `2h`; a bare integer is ms, and `<1000` is rejected as a likely units slip). |
| `--env NAME=value` | — | Literal env var for this command; repeatable. **Don't put secrets here**: the value sits in your shell history and `ps`. |
| `--env-profile NAME=<profileId>` | — | Set `NAME` from the stored credential of auth profile `<profileId>` (list ids with the `auth_profile_list` MCP tool); repeatable. Names a **profile**, never a keychain ref. Sub-account (source-backed) profiles resolve through their `SubaccountProvider`. Unknown or disabled profiles, invalid names, and a `NAME` also given via `--env` are rejected before anything boots. Not supported on `device:` targets. Resolved values are redacted from stdout, stderr and errors (`<redacted>`). |
| `--file <local>:<boxPath>` | — | Upload a local file to the absolute `<boxPath>` **before** the command runs; repeatable. Needs a provider whose boxes can write files (e2b today). |
| `--json` | `false` | Print the daemon's response as JSON instead of streaming stdout/stderr. |

Limits: a command over **16 KB** or an env over **32 KB** (literal + profile
values) is rejected with an actionable error — upload the script with `--file`
and run it by path. Provider errors never echo the full command: it is cut to
~200 characters with a `…(N chars)` marker.

### The always-on model (`--keep-alive`)

`--keep-alive` is for a sandbox meant to stay reachable indefinitely rather
than get reclaimed by the provider's own idle/TTL auto-stop. The documented
Box mechanism for "runs until you stop it" is **no-auto-stop**
(`box extend <id> --no-auto-stop` / `ttlSeconds: null`), and it's **sticky
across resume** — so `--keep-alive` (re-)asserts it on `connect()`,
defensively, even for a box that already defaults to it (e.g. one created
before that default, or with an explicit numeric `ttlSeconds`). It does
**not** start a background heartbeat process — a one-shot CLI invocation
can't cleanly host one, and no-auto-stop has no deadline to begin with, so
none is needed. `--keep-alive` is a no-op for providers with no equivalent
concept (e.g. e2b).

## Examples

```bash
# Browse all boxes the daemon has touched (with liveness probes)
agentproto sandbox list
agentproto sandbox list --json

# Browse without network calls (skip liveness probes)
agentproto sandbox list --no-probe

# Remove a ledger entry (box stays running/paused on the provider)
agentproto sandbox rm my-task-label
agentproto sandbox rm bx_abc123

# Remove ledger entry AND stop the box (destructive)
agentproto sandbox rm bx_abc123 --box --yes

# Dry-run GC — see which orphan boxes would be reaped
agentproto sandbox gc

# Actually reap orphan boxes (sessions that errored/were killed)
agentproto sandbox gc --apply

# Attach to a Box sandbox booted by an earlier agent_start sandbox spawn
agentproto sandbox attach box bx_abc123

# Pin it awake indefinitely for an always-on rendezvous
agentproto sandbox attach box bx_abc123 --keep-alive

# Same, machine-readable
agentproto sandbox attach e2b sbx_abc123 --json

# Override the port the daemon listens on inside the box
agentproto sandbox attach box bx_abc123 --config-json '{"port":19000}'

# Run a command in a fresh box with a secret taken from an auth profile
agentproto sandbox exec e2b --env-profile OPENAI_API_KEY=openai-main -- python run.py
```

Non-JSON output:

```text
sandbox attached  provider=box  sandboxId=bx_abc123
  mcpUrl      https://frazil-pneuma-rallye-18790.on.ascii.dev/mcp
  token       •••••••• (gated)
  allowOrigin https://frazil-pneuma-rallye-18790.on.ascii.dev
  keepAlive   no

Paste into .mcp.json:
{
  "mcpServers": {
    "sandbox-box-bx_abc123": {
      "type": "http",
      "url": "https://frazil-pneuma-rallye-18790.on.ascii.dev/mcp",
      "headers": { "Cookie": "_port_auth=••••••••" }
    }
  }
}
```

The exact auth header is provider-specific and comes straight from the
descriptor's `authHeaders`. Box gates its private hostname on a
`Cookie: _port_auth=<token>` (its port edge ignores `Authorization: Bearer`);
a token-only provider falls back to `Authorization: Bearer <token>`.

## See also

- [`sessions.md`](./sessions.md) — `agent_start.sandbox` / `sessions start --sandbox` boots and drives a
  fresh sandbox; `sandbox list`/`attach`/`rm` operate on already-existing boxes
- [`auth.md`](./auth.md) — credential storage conventions
