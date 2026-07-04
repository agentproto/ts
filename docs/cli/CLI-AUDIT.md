# CLI Rationality Audit

Audit of `packages/cli/src/commands/` as of 2026-06-30.
Findings ordered by severity.

## Command Inventory

| Command | Subcommands | Key Flags | Purpose |
|---------|-------------|-----------|---------|
| **auth** | login, status, logout, provider | --host, --token, --label, --no-browser | OAuth2 device flow host binding + provider API keys |
| **browser** | install, start, stop, list, status | --port, --camofox-port, --force, --dry-run, --json | Browser service session management (Camofox, Bureau) |
| **chat** | — | --model, --cwd, --workspace, --label, --keep, --no-color | Interactive multi-turn REPL on daemon-hosted agent session |
| **chat-tui** | — | --model, --cwd, --workspace, --label, --system, --keep | TUI variant of chat (Ink/React split-pane) |
| **config** | show, path, get, set, unset, edit | --json | Manage `~/.agentproto/config.json` |
| **daemon** | install, uninstall, start, stop, status, logs | --dry-run, --lines | Service lifecycle (launchd/systemd wrapper) |
| **install** | — | --force, --dry-run, --skip-setup | Install adapter binary + run setup pipeline |
| **mcp-bridge** | — | (stdio, no flags) | Stdio MCP proxy to daemon `/mcp` endpoint |
| **models** | — | `[adapter]`, --json | List runnable models + provider-key status |
| **plugins** | list, show, install, uninstall, enable, disable | --json, --skip-npm, --local | Manage runtime plugins |
| **run** | — | --cwd, --prompt, --resume, --json | One-shot: spawn adapter, dispatch turn, stream events, exit |
| **run-swarm** | — | --manifest, --once, --interval, --verbose | Run swarms from manifest |
| **serve** | — | --workspace, --port, --bind, --connect, --token, --allow-origin, --interactive | HTTP gateway + MCP server + session registry |
| **sessions** | start, stop, terminal, export, mirror, restart | --watch, --attach, --cwd, --workspace, --model, --prompt, --label, --json | Session browser & control |
| **setup** | — | --force, --dry-run, --only | Run AIP-29 setup pipeline (post-install) |
| **tunnel** | create, list, stop, status | --port, --provider, --name, --hostname, --json | Manage public tunnels (Cloudflare, Ngrok) |
| **workspace** | add, list, remove, use | --slug, --label, --json | Manage workspaces registry |

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

### P3 — `run` has no `--model` flag

`chat --model <id>` and `sessions start --model <id>` both accept a model override. `run` does not — the model is baked into the adapter's ACP session config. Since `run` is the primary scripting surface, add `--model <id>` for symmetry, forwarded as a `session/set_config_option` call on the spawned adapter.

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
