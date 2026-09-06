# CLI Rationality Audit

Audit of `packages/cli/src/commands/` as of 2026-07-18.
Findings ordered by severity.

## Command Inventory

All 29 verbs in the dispatcher's `VERBS` set (`packages/cli/src/cli.ts`).

| Command | Subcommands | Key Flags | Purpose |
|---------|-------------|-----------|---------|
| **acp** | ls, add, rm | --bin, --args, --name, --desc, --env, --resumable, --json | Register generic ACP agents (zero-code ACP CLIs) in config |
| **auth** | login, status, logout, provider | --host, --token, --label, --no-browser | OAuth2 device flow host binding + provider API keys |
| **browser** | install, start, stop, list, status | --port, --camofox-port, --force, --dry-run, --json | Browser service session management (Camofox, Bureau) |
| **chat** | — | --model, --cwd, --workspace, --label, --keep, --no-color | Interactive multi-turn REPL on daemon-hosted agent session |
| **chat-tui** | — | --model, --cwd, --workspace, --label, --system, --keep | TUI variant of chat (Ink/React split-pane) |
| **config** | show, path, get, set, unset, edit | --json | Manage `~/.agentproto/config.json` |
| **conversation** | locate | --json | Locate the native transcript (claude jsonl / hermes row) behind a session, or the session behind a native transcript path — reads the persisted `conversations.jsonl` index |
| **cron** | add, list, remove (delete/rm), run | --schedule, --command, --args, --adapter, --target-session, --prompt, --cwd, --model, --timeout-ms, --label, --once, --json | Durable cron jobs on the daemon (persist to `cron-jobs.json`) |
| **daemon** | install, uninstall, start, **restart**, stop, status, logs | --dry-run, --lines | Service lifecycle (launchd/systemd wrapper) |
| **install** | — | --force, --dry-run, --skip-setup, **--allow-unverified** | Install adapter binary + run setup pipeline; also `skill/*` and `runtime-profile/*` slugs |
| **install-mcp** | — | --agent, --all, --yes, --skip-daemon, --update, --uninstall | Register the daemon's MCP server with detected coding CLIs |
| **mcp-bridge** | — | (stdio, no flags) | Stdio MCP proxy to daemon `/mcp` endpoint |
| **models** | — | `[adapter]`, --json | List runnable models + provider-key status |
| **onboard** | — | --yes, --no-skills, --skills, --agent | First-run umbrella: install-mcp + skill pack |
| **pack** | skill | --manifest, --source, --bump, --dry-run, --out | Generate a versioned skill pack from a manifest |
| **pair** | offer, accept, ls, revoke, exec | --ttl, --rendezvous, --no-qr, --name, --json | End-to-end daemon pairing over an untrusted rendezvous |
| **permissions** | ls, approve, deny | --always, --json | Approve/deny held tool-permission requests (permission-hold inbox) |
| **plugins** | list, show, install, uninstall, enable, disable | --json, --skip-npm, --local | Manage runtime plugins |
| **policy** | attach, status, wait, ack, ls (list), cancel | --session, --sessions, --then, --gate-json, --judge-adapter, --commit-path, --ack/--no-ack, --attach-json, --wait, --timeout, --json | CLI surface for the completion-policy engine (`/policies`) |
| **presets** | list | --json | List provider gateway presets + daemon-side key-env status |
| **rendezvous** | serve | --port, --host | Self-host the untrusted pairing broker |
| **run** | — | --cwd, --prompt, --model, --effort, --resume, --json, --output-schema | One-shot: spawn adapter, dispatch turn, stream events, exit |
| **run-swarm** | — | --manifest, --once, --interval, --verbose | Run swarms from manifest |
| **serve** | — | --workspace, --port, --bind, --connect, --token, --allow-origin, --interactive | HTTP gateway + MCP server + session registry |
| **sessions** | start, stop, terminal, export, story, mirror, restart, prompt, pin, unpin, wait, gc | --watch, --attach, --cwd, --workspace, --model, --prompt, --label, --json | Session browser & control |
| **setup** | — | --force, --dry-run, --only | Run AIP-29 setup pipeline (post-install) |
| **tunnel** | create, list, stop, status | --port, --provider, --name, --hostname, --json | Manage public tunnels (Cloudflare, Ngrok) |
| **workspace** | add, list, remove, use | --slug, --label, --json | Manage workspaces registry |
| **worktree** | ls, new, rm, archive, gc | --repo, --status, --base, --branch, --root, --no-setup, --keep-branch, --discard-untracked, --discard-modified, --apply, --salvage-dirty, --include-detached, --json | Git worktree lifecycle (provision under `worktrees.root`, guarded/salvage removal, gc) |

---

## Findings

### P1 — Flag Semantics: `--workspace` means two different things

**Commands affected:** `chat`, `sessions start` vs. `serve`

- `chat --workspace <slug>` and `sessions start --workspace <slug>` — registered workspace slug, resolved via `~/.agentproto/workspaces.json`.
- `serve --workspace <dir>` — absolute directory path for the daemon root.

Same flag name, different type and meaning. `serve` should use `--workspace-dir` (or `--dir`) to break the conflict.

---

### P2 — `chat` / `chat-tui` presented as sibling top-level commands

`chat-tui` is a rendering variant of `chat`, not a different operation. Users have to know to try both. Options:

- **Preferred:** merge into `agentproto chat [--tui]`. Default is readline; `--tui` launches the Ink renderer.
- **Alternative:** keep both but add `see also: chat-tui` to `chat --help` and vice versa.

If keeping both, document in `verbs/chat.md` (already done) — this is a documentation fix until the flag merge lands.

---

### P3 — `run` has no `--model` flag — **RESOLVED (2026-07-16)**

The original finding: `chat --model <id>` and `sessions start --model <id>` both accepted a model override, `run` did not, and since `run` is the primary scripting surface it should for symmetry.

No longer true. `run` now takes `--model <id>` and `--effort <level>`, applied exactly as `sessions start` does — as manifest-declared AIP-45 options routed through the adapter's own model/effort handling (ACP `set_config_option` for claude-code, a `/model` control turn for hermes). Adapters that don't declare them reject the option rather than ignoring it. `run` also grew `--output-schema <path-or-inline-json>`, which re-prompts on a schema mismatch and can't be combined with `--json`.

Symmetry across `run` / `chat` / `sessions start` is achieved; nothing to do.

---

### P4 — `sessions terminal` is a noun subcommand among verbs

Subcommands: `start`, `stop`, `export`, `mirror`, `restart`, `terminal`. All are verbs except `terminal`, which is a session-kind noun. Should be `sessions spawn-terminal` or `sessions start --terminal-mode` to keep the surface imperative.

---

### P5 — `--skip-setup` (install) vs. `--skip-npm` (plugins) — inconsistent prefix

`install --skip-setup` skips post-install config. `plugins install --skip-npm` skips the npm step. One pattern is `--skip-<noun>`, the other uses the same pattern but on a different noun level. Low friction today but will compound with more skippable steps. Standardize on `--no-setup` (boolean toggle) for skip-style flags.

---

### P6 — `--only <step>` accepts multiple values non-obviously

`setup --only <step>` and `browser install --only <step>` support `--only` as a repeatable flag (`multiple: true` in parseArgs). The standard usage `--only step1 step2` is non-obvious for users expecting `--only step1 --only step2`. Document in help: "Repeatable: `--only step1 --only step2`."

---

### P7 — `browser install` conflates binary install + config (unlike everywhere else)

The pattern across the CLI is: `agentproto install <slug>` (binary) → `agentproto setup <slug>` (config). `browser install <adapter>` does both in one step. The divergence is intentional (browser adapters are config-only, no binary to install), but it surprises users who expect `browser setup`.

**Options:**
- Add `agentproto browser setup <adapter>` as an alias for `browser install`.
- Or document the distinction clearly in `verbs/browser.md` (already done — the doc explains it).

---

### P8 — Missing `--help` on some commands before `parseArgs`

`daemon logs --help` may fail if `--lines` is parsed before `--help` is caught. Ensure all commands check for `args.includes('-h') || args.includes('--help')` before calling `parseArgs`. The majority already do; audit the edge cases.

---

## Non-Issues (raised and dismissed)

- **`status` as a subcommand noun:** accepted convention in CLI tooling (`git status`, `docker status`). No change.
- **Positional vs. flag for primary IDs:** all commands use positionals for primary IDs (`run <slug>`, `tunnel stop <id>`). Consistent and idiomatic — no change.
- **`--json` not available on interactive commands:** correct by design. Chat and chat-tui output to a TTY and don't support `--json`. Document, don't fix.
- **`config path`:** arguably a special case of `config get`, but it's a one-liner convenience that's clearly named. Keep.
