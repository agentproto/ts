# `agentproto mcp`

```text
agentproto mcp migrate-secrets [--apply]
agentproto mcp mount-default <adapter> <importId...>
```

Maintenance for **imported MCPs** — the MCP server pointers recorded in
`~/.agentproto/imported-mcps.json` (see [`settings.md`](./settings.md), which
carries them between machines). Both subcommands operate on local files only
and need no running daemon.

Not to be confused with [`mcp-bridge`](./mcp-bridge.md) / [`mcp-app`](./mcp-app.md),
which are stdio MCP servers, or [`install-mcp`](./install-mcp.md), which registers
the daemon's own MCP server with coding CLIs.

`agentproto mcp`, `agentproto mcp --help`, `-h` and `help` print the usage text
and exit `0`. An unknown subcommand prints the usage to stderr and exits `2`.

## `migrate-secrets`

Moves literal header and env values in `imported-mcps.json` behind OS-keychain
references (`secretRefs`), so the file no longer holds the secrets in clear.

| Flag | Default | Description |
|------|---------|-------------|
| `--apply` | off (dry run) | Actually store the values and rewrite the file. Without it nothing is written. |

Never automatic — you run it, per machine.

**Dry run** (default) lists what *would* move, by key name only — values are
never printed:

```text
Would move to keychain (dry run — nothing written; pass --apply):
  github: headers.Authorization
  my-server: env.API_KEY, env.OTHER_TOKEN
```

When nothing is literal: `No literal header/env values to move.`

**`--apply`** works per key: the keychain write happens first and is read back
to verify; only then is the value in the snapshot replaced by the
`<secretRef>` marker. The file is rewritten **once**, atomically, at the end.
A key that fails verification stays literal and is reported as a
`warning:` on stderr. Ends with `<n> value(s) moved.`

Any other argument exits `2` (`unexpected argument`).

| Exit | Meaning |
|------|---------|
| `0` | Dry run, nothing to move, or every value moved. |
| `1` | `--apply` finished with at least one warning (some key stayed literal). |
| `2` | Bad arguments / unknown subcommand. |

## `mount-default`

```text
agentproto mcp mount-default <adapter> <importId...>
```

Makes every **future** spawn of `<adapter>` mount the given imported MCPs
natively (a real `mcpServers` entry), instead of only being reachable through
the daemon gateway. It:

1. creates the bundle `harness-<adapter>` with the given ids as its
   `mcpImports`, or appends the new ids to it if it already exists;
2. lists that bundle in `defaults.adapters.<adapter>.bundles` in
   `~/.agentproto/config.json` (if not already listed).

| Argument | Description |
|----------|-------------|
| `<adapter>` | Adapter slug, lowercase kebab-case (`^[a-z0-9][a-z0-9-]*$`). |
| `<importId...>` | One or more ids from `imported-mcps.json`. Every id must already be imported; unknown ids are rejected with the list of valid ones. |

Opt-in per adapter — nothing is mounted natively by default. Repeat the
command to add more ids. If `harness-<adapter>` already exists as a wildcard
bundle (`mcpImports: "*"`), it is left unchanged.

```text
bundle harness-codex: created (+github, linear)
defaults.adapters.codex.bundles: linked
New 'codex' spawns mount these natively; running sessions are unchanged.
```

The first line reads `created`, `updated` (ids added) or `unchanged`; the
second reads `linked` or `already linked`. Running sessions are not affected.

| Exit | Meaning |
|------|---------|
| `0` | Bundle and config are in the desired state. |
| `1` | Rejected input (bad adapter slug, unknown import id) or a failed write. |
| `2` | Missing `<adapter>` / `<importId...>`, or an argument starting with `-`. |

## See also

- [`settings.md`](./settings.md) — exports/imports imported-MCP pointers between machines
- [`install-mcp.md`](./install-mcp.md) — registers the daemon's MCP server with coding CLIs
- [`mcp-bridge.md`](./mcp-bridge.md) — stdio proxy to the daemon `/mcp` endpoint
