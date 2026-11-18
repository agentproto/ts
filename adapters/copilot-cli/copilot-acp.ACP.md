# copilot-cli — ACP wire profile

AIP-44 ACP profile for GitHub Copilot CLI's first-party ACP server. The agent
side is the `copilot` binary itself, spawned as `copilot --acp --stdio`
(NDJSON JSON-RPC 2.0 over stdio; the same server also runs over TCP via
`copilot --acp --port N`). Docs:
<https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server>.

ACP support was added in **0.0.397** (2026-01-28). Verified on CLI **1.0.113**
(`protocolVersion` 1, 2026-11-18); `initialize` advertises `loadSession`, MCP
`http`+`sse`, `promptCapabilities {image: true, audio: false, embeddedContext:
true}`, `sessionCapabilities {list, close}` and no `_meta.steering`.

## Lifecycle

| Method            | Behaviour                                                        |
| ----------------- | --------------------------------------------------------------- |
| `initialize`      | Standard ACP handshake; returns `agentCapabilities` / `authMethods`. |
| `authenticate`    | The server requires a Copilot login before `authenticate` returns success (0.0.7x changelog); auth is normally satisfied by the spawn env (see `SECRETS.md`). |
| `session/new`     | Creates a session for the requested `cwd` + `mcpServers`; returns a session id. |
| `session/load`    | Supported (0.0.410+, 2026-02-14) — backs this harness's `native-resume` continuation. |
| `session/prompt`  | Streams the turn as ACP `session/update` notifications (agent message chunks, tool calls, usage). |
| `session/cancel`  | Cancels the in-flight turn. |
| `session/close`   | Supported (closeSession request). |

## Session config options

The server advertises config options via the `configOptions` API (verified on
1.0.113):

- **model** — the active Copilot model; can be changed during a session. This
  harness applies it via `session/set_config_option` (`configId:"model"`).
  `session/new` also returns `models.availableModels` (17 ids on the tested
  account, with a `copilotUsage` cost multiplier).
- **reasoning_effort** — reasoning effort (`low`/`medium`/`high`/`xhigh`/`max`).
  The id is **`reasoning_effort`, not `effort`**: `set_config_option` with
  `configId:"effort"` fails with "Unknown config option 'effort'". The ACP
  client resolves the id from the advertised options (`effort`, then
  `reasoning_effort`, then category `thought_level`). The server also accepts
  `--effort`/`--reasoning-effort` at start.
- **mode** — three session modes, ids
  `https://agentclientprotocol.com/protocol/session-modes#agent`, `#plan` and
  `#autopilot` (allow-all, experimental). Surfaced as the session's available
  modes.
- **agent** — custom-agent selection.
- **allow_all** — unrestricted permissions.

## Concurrent prompts (no steering)

`initialize` carries no `_meta.steering`. A second `session/prompt` sent while a
turn is running makes the first end `stopReason: cancelled` and the second run
(`end_turn`): a replace, not an injection. Hence `steering: false` is correct;
the daemon queues a follow-up prompt FIFO instead of sending it concurrently.

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

## Multimodal

`promptCapabilities.image` is `true`. Verified on 1.0.113 by sending a
`session/prompt` with a PNG `image` content block (a solid red square): the
agent answered "Red". `capabilities.multimodal` is therefore `true`; audio is
not supported.
