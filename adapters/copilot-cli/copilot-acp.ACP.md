# copilot-cli — ACP wire profile

AIP-44 ACP profile for GitHub Copilot CLI's first-party ACP server. The agent
side is the `copilot` binary itself, spawned as `copilot --acp --stdio`
(NDJSON JSON-RPC 2.0 over stdio; the same server also runs over TCP via
`copilot --acp --port N`). Docs:
<https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server>.

ACP support was added in **0.0.397** (2026-01-28) and is in public preview.

## Lifecycle

| Method            | Behaviour                                                        |
| ----------------- | --------------------------------------------------------------- |
| `initialize`      | Standard ACP handshake; returns `agentCapabilities` / `authMethods`. |
| `authenticate`    | The server requires a Copilot login before `authenticate` returns success (0.0.7x changelog); auth is normally satisfied by the spawn env (see `SECRETS.md`). |
| `session/new`     | Creates a session for the requested `cwd` + `mcpServers`; returns a session id. |
| `session/load`    | Supported (0.0.410+, 2026-02-14) — backs this adapter's `native-resume` continuation. |
| `session/prompt`  | Streams the turn as ACP `session/update` notifications (agent message chunks, tool calls, usage). |
| `session/cancel`  | Cancels the in-flight turn. |
| `session/close`   | Supported (closeSession request). |

## Session config options

The server advertises config options via the `configOptions` API, including:

- **model** — the active Copilot model; can be changed during a session. This
  adapter applies the `model` option via `session/set_config_option`.
- **effort** — reasoning effort (`low`/`medium`/`high`/`xhigh`/`max`). Applied
  via `session/set_config_option`; the server also accepts
  `--effort`/`--reasoning-effort` at start.
- **agent** — custom-agent selection.
- **allow_all** — unrestricted permissions.

## Server-start options

Some settings are fixed when the server starts and inherited by every session
they create or load, because `session/new` does not carry them:

| Flag | Effect |
| ---- | ------ |
| `--available-tools=TOOL ...` | Restrict the session to the listed tools. |
| `--excluded-tools=TOOL ...` | Remove the listed tools. |
| `--effort=LEVEL` / `--reasoning-effort=LEVEL` | Initial reasoning effort. |

## Permissions

Over ACP the server raises `session/request_permission` for tool use; the
agentproto ACP client auto-answers by default (`permissionHold` off), so tool
execution proceeds. The interactive CLI's `--allow-all-tools` /
`--allow-tool` / `--deny-tool` flags are a separate, launch-time surface.

## Not surfaced

- **Subagents**: the server reports subagent ids/activity to its client, but
  that is the agent's internal delegation, not an AIP-45 `sub_agents` surface.
- **Multimodal**: the ACP `promptCapabilities` are not documented; declared
  `false` conservatively. (The interactive CLI accepts pasted images, but that
  is not an ACP content-block channel.)
