# `agentproto install-mcp`

```text
agentproto install-mcp [--agent <name>...] [--all] [--yes]
                       [--skip-daemon] [--update] [--uninstall]
agentproto install-mcp --app <appId> [--agent <name>...] [--yes]
```

Register the daemon's MCP server with the coding-CLI agents installed on this
machine. Detects which agents are present, ensures the daemon is running (or
starts it), then writes the right MCP entry into each agent's own config file.

What it registered is tracked in `~/.agentproto/install-state.json`, so
`--update` and `--uninstall` act precisely on agentproto's own entries and
never clobber MCP servers you added yourself.

## Agents

| Name | Label | Transport | Config written |
|------|-------|-----------|----------------|
| `claude` | Claude Code | HTTP | `claude mcp add --transport http --scope user`, falling back to `./.mcp.json` |
| `cursor` | Cursor | stdio | `~/.cursor/mcp.json` |
| `codex` | Codex CLI | stdio | `[mcp_servers.agentproto]` in `~/.codex/config.toml` |
| `claude-desktop` | Claude Desktop | stdio | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS only) |
| `aider` | Aider | stdio | `mcp_servers` in `~/.aider.conf.yml` |
| `windsurf` | Windsurf | stdio | `~/.codeium/windsurf/mcp_config.json` |
| `hermes` | Hermes | HTTP | `mcp_servers.agentproto` in `~/.hermes/config.yaml` |

An agent counts as detected when its binary is on `PATH` **or** its config
file/dir exists (windsurf, like cursor, has no relevant CLI binary — detection
is config-path-only). stdio registrations run `agentproto mcp-bridge` (see
[`mcp-bridge.md`](./mcp-bridge.md)); they only carry an `AGENTPROTO_MCP_URL`
env var when the daemon isn't on the default port `18790`.

Hermes is edited surgically — a real hermes config carries sibling MCP servers
under `mcp_servers:`, so the entry is upserted in place and the file is backed
up to `config.yaml.bak` first. If `~/.hermes/config.yaml` doesn't exist yet,
the step is skipped rather than synthesised: run hermes once, then re-run.

## `--app <appId>`: scoped registration for a book/library app

By default this verb registers the **full daemon** (`agentproto mcp-bridge`,
every tool). `--app <appId>` instead writes `agentproto mcp-app <appId>` — the
curated, one-app proxy (see [`mcp-app.md`](./mcp-app.md)) — for an app that
declares the book/library contract (`category: "book"` or a non-empty
`library.books` in its `APP.md`, see `@agentproto/app-kit`'s `defineApp`).
The app must already be installed (`agentproto app install <dir>`).

Only agents whose config format can hold multiple named MCP entries
side-by-side support `--app`: **cursor, codex, claude-desktop, windsurf**.
`claude`/`hermes` register over HTTP through a different mechanism, and
`aider`'s writer assumes agentproto is its only MCP entry (a full-file
remove-and-replace, not a surgical per-key edit) and would silently drop
siblings — all three are refused: an explicitly-requested unsupported agent
(`--agent claude --app <id>`) exits `2`; with no `--agent` (all detected),
unsupported ones are silently skipped with a note.

A scoped entry is written under its own key
(`agentproto-app-<appId>`/`[mcp_servers.agentproto-app-<appId>]`, appId
sanitized to `[A-Za-z0-9_-]`), distinct from the full-daemon `agentproto` key
— the two can coexist for the same client, and `--update`/`--uninstall` track
them separately (the tracked state entry carries an `appId`).

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--agent <name>` | *(all detected)* | Target one agent; repeatable. Unknown names fail with exit `2`; known-but-undetected ones exit `1`. |
| `--all` | — | Target every detected agent — which is already the default. Accepted for explicitness, but it changes nothing: with `--agent` also present, `--agent` wins and `--all` is ignored. |
| `--app <appId>` | — | Scoped mode — see above. Requires the app to be installed and declare the book/library contract; exits `1` otherwise. |
| `--yes` | `false` | Non-interactive. Also authorises the background `agentproto serve` fallback when the daemon can't be started via `daemon start`. |
| `--skip-daemon` | `false` | Skip daemon discovery/start; take the port from `~/.agentproto/config.json` (`daemon.port`, default `18790`). |
| `--update` | `false` | Re-run registration for previously-registered agents — e.g. after a port change. Agents no longer detected are skipped, not removed. |
| `--uninstall` | `false` | Remove only the entries listed in `install-state.json`, then clear it. |

## Daemon bootstrap

Unless `--skip-daemon` is passed, the verb resolves a live daemon before
writing any config, since the port it registers has to be the real one:

1. Discover via `~/.agentproto/runtime.json` and probe `/health`.
2. Otherwise try `agentproto daemon start` (launchd/systemd) and poll `/health` for 5s.
3. With `--yes` only, spawn a detached `agentproto serve` and poll `/health` for 10s.

If none of those land, nothing is registered and the verb exits `1` telling you
to run `agentproto serve` manually.

## Examples

```bash
# Wire every detected agent, non-interactive
agentproto install-mcp --yes

# Just Claude Code and Codex
agentproto install-mcp --agent claude --agent codex

# Re-point existing registrations after `config set daemon.port 18791`
agentproto install-mcp --update

# Back out everything agentproto added
agentproto install-mcp --uninstall

# Scope a buyer-facing entry to one installed book app instead of the full daemon
agentproto install-mcp --app my-book --agent cursor --yes
```

Restart your CLI agent(s) afterwards to pick up the change — the verb reminds
you when it registered or removed anything.

## See also

- [`onboard.md`](./onboard.md) — first-run umbrella: this verb plus the skill pack
- [`mcp-bridge.md`](./mcp-bridge.md) — the stdio proxy the full-daemon registrations invoke
- [`mcp-app.md`](./mcp-app.md) — the stdio proxy `--app` registrations invoke
- [`serve.md`](./serve.md) — the daemon hosting `/mcp`
- [Use agentproto as an MCP server inside coding CLIs](../guides/mcp-in-coding-cli.md) — doing it by hand
