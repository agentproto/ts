# `agentproto mcp`

```text
agentproto mcp migrate-secrets [--apply]
agentproto mcp mount-default <adapter> <importId...>
agentproto mcp login <alias|importId> [--url <url>] [--scope "a b"] [--no-open]
agentproto mcp logout <alias|importId>
```

Maintenance for **imported MCPs** — the MCP server pointers recorded in
`~/.agentproto/imported-mcps.json` (see [`settings.md`](./settings.md), which
carries them between machines). `migrate-secrets` and `mount-default` operate
on local files only and need no running daemon; `login`/`logout` manage the
OAuth credential for a remote import.

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

## `login` / `logout`

```text
agentproto mcp login <alias|importId> [--url <url>] [--scope "a b"] [--no-open]
agentproto mcp logout <alias|importId>
```

Remote (http/sse) MCPs that accept no API key or static header can
authenticate with OAuth 2.1 (RFC 9728 resource-metadata discovery, RFC 7591
dynamic client registration, PKCE). `login` runs the whole consent:

1. discovers the server and registers a client;
2. prints the authorization URL and the requested scopes, then waits on a
   one-shot `127.0.0.1` loopback listener (opens a browser unless
   `--no-open`);
3. stores the client + tokens as **one OS-keychain item per import** — never
   in `imported-mcps.json`;
4. verifies with `tools/list`, and only then records
   `auth: { type: "oauth" }` on the import.

| Flag | Default | Description |
|------|---------|-------------|
| `--url <url>` | — | Create a manual http import when the alias is unknown. |
| `--scope "a b"` | server default | Space-separated OAuth scopes to request. |
| `--no-open` | off | Print the URL without opening a browser. |

The import must already be a remote (http/sse) MCP, or be creatable via
`--url`. Stored state is bound to the server origin, so a live-repointed
import never receives tokens.

The daemon refreshes tokens on its own and never starts an interactive flow:
when credentials are missing or revoked it fails with
`oauth login required … run: agentproto mcp login <alias>`.

`logout` forgets the stored OAuth state (the keychain item) for the named
import; the import entry itself is left in place.

```text
Logged in: qonto (manual:cli:qonto) — import created
Granted scopes: accounts
3 tool(s): list_accounts, get_balance, …
```

| Exit | Meaning |
|------|---------|
| `0` | Login verified (or logout completed). |
| `1` | Consent failed, verification failed, or the import is not a remote MCP. |
| `2` | Missing `<alias\|importId>` / a flag needs a value / unexpected option. |

## See also

- [`settings.md`](./settings.md) — exports/imports imported-MCP pointers between machines
- [`install-mcp.md`](./install-mcp.md) — registers the daemon's MCP server with coding CLIs
- [`mcp-bridge.md`](./mcp-bridge.md) — stdio proxy to the daemon `/mcp` endpoint
