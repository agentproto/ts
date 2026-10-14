# claude-code-cloud — ACP wire profile

AIP-44 ACP profile for the AIP-66 managed cloud agent adapter. The agent
side is implemented in `src/acp-server.ts` against
`@agentclientprotocol/sdk`'s `AgentSideConnection`, spawned over stdio
(`agentproto-claude-code-cloud-acp`). Unlike every other Claude Code
adapter, this one runs NO harness locally: the vendor owns the machine and
the harness (Anthropic's Claude Code cloud sessions), and this server
relays the vendor's own client + sessions API onto ACP.

## Lifecycle

| Method                 | Behaviour                                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize`           | Returns `PROTOCOL_VERSION` + `agentCapabilities.loadSession=false` (re-attach is via the persisted vendor session id, AIP-66 §5).                                                |
| `authenticate`         | No-op. Auth is the user's claude.ai login inside the claude CLI (keychain); preflighted per turn (`claude auth status` — api_key auth and not-logged-in are refused).          |
| `session/new`          | Validates `cwd` per AIP-66 §3 BEFORE any vendor side effect: a git checkout, clean working tree, an `origin` remote, and a HEAD contained in some `origin/*` ref. Refuses `mcpServers` (AIP-66 §4). |
| `session/prompt`       | First prompt → `claude --cloud "<prompt>"` under a PTY (start; answers the first-run folder-trust prompt), later prompts → `claude -p "<text>" --cloud <session id>` (send-only). Then polls `GET /v1/code/sessions/{id}/events` (2s, backing off to 10s) until a NEW `result` event arrives. |
| `session/cancel`       | UNSUPPORTED — the vendor exposes no interrupt verb; the call throws (AIP-66 §6). The in-flight cloud turn is not aborted and is never reported cancelled.                        |
| `session/set_config_option` | Empty configurable set (no model menu — the vendor picks the model).                                                                                                       |

## Message mapping

Vendor events (Claude Code stream-json payloads) reuse the
`@agentproto/adapter-claude-sdk` mappers — the payloads ARE stream-json SDK
messages:

| Event / payload                          | ACP `session/update`                                |
| ---------------------------------------- | --------------------------------------------------- |
| `assistant` → `text` block               | `agent_message_chunk`                               |
| `assistant` → `tool_use` block           | `tool_call` (in_progress)                           |
| `user` → `tool_result` block             | `tool_call_update`                                  |
| `user` → prompt echo (any non-tool text) | dropped — never replayed as a chunk                  |
| `result` (with usage)                    | `usage_update` (tokens + `total_cost_usd`)          |
| `result` (error)                         | error text as `agent_message_chunk`; stop `refusal` |
| first turn after start                   | session URL as an `agent_message_chunk` (inspectable) |

A turn ends ONLY on the vendor's own `result` event (AIP-66 §6) — never on
a timer or on poll silence. Stop reason: `end_turn` for a success result,
`refusal` when `is_error` or `subtype != "success"`. Transient event-read
failures (HTTP 5xx, network) are retried with the poll backoff — a read
failure never ends a turn — until 5 consecutive ones fail the prompt.

## Usage telemetry

When the `result` event carries `total_cost_usd` and/or `usage`, it is
mapped to ACP `usage_update` (`cost` USD, `tokensIn`/`tokensOut` extension).
When it carries neither, NO usage update is emitted — usage is unmeasured,
never a fabricated zero (AIP-66 §7).

## Session identity

One ACP session = exactly one vendor cloud session (AIP-66 §5). The vendor
id (`session_<id>`, API spelling `cse_<id>`) is returned by the start path
and kept for every later turn; the host is expected to persist it on the
session descriptor (`meta.cloud = { vendor, sessionId, url }`) and re-attach
rather than start a new vendor session after a restart.

## Re-attach (AIP-66 §5)

The vendor id only exists AFTER the first prompt reaches the vendor, so the
handoff from relay to host is a side file plus a poll, and the re-attach
itself rides the ordinary ACP `session/load` resume path:

- **Meta-file handoff.** At spawn the host sets
  `AGENTPROTO_CLOUD_SESSION_META_FILE` to a path inside the session's
  isolated config dir. Whenever the relay learns the vendor id — after
  `claude --cloud` prints it, or when `session/load` adopts an id handed
  back by the host — it writes exactly the three §5 fields
  `{ vendor, sessionId, url }` there (`src/meta-file.ts`, atomic
  temp-file + rename, best-effort: a failed write never sinks the turn,
  and a re-attach preserves an existing `url` for the same id). The file
  is the ONLY channel: no credential, keychain material, or bearer token
  ever enters it, the descriptor's `meta.cloud`, logs or events (AIP-66
  §8) — it is byte-scoped to those three fields.
- **The host's watch.** The runtime polls that file every 2s (timers
  unref'd, NO fixed timeout) and stamps the learned mapping onto the
  session's `meta.cloud` the moment it appears; the watch stops on learn
  or when the session ends.
- **`session/load`.** A restart or re-attach hands the relay the vendor id
  persisted on `meta.cloud.sessionId` through the standard ACP
  `session/load`. The relay validates it against the repo source first
  (an id that isn't `session_`/`cse_`, or whose repo no longer matches,
  fails closed), ADOPTS it — never starting a replacement vendor session —
  pre-marks the vendor's existing events so only the next turn's own
  `result` can end it, and resumes through `sendPrompt`
  (`claude -p --cloud <id>`).
- **The resume fallback.** The spawn-time watch dies with a daemon
  restart, so every resume point first reads `meta.cloud.sessionId`; when
  the descriptor never learned one, the runtime falls back to reading the
  relay's meta file inside the row's own config dir
  (`cloudSessionMetaFilePath`) and stamps the found mapping back onto the
  descriptor before resuming. Only when both sources are empty does the
  resume fall back to the ordinary ACP uuid, which fails closed at the
  vendor.

## Repo source (AIP-66 §3)

The cloud runs the user's REPO from its git remote — never an uploaded
working tree. `session/new` refuses: a non-git cwd, a dirty tree, a missing
`origin` remote, and an unpushed HEAD. Commit and push before spawning.

## Refused spawn fields (AIP-66 §4)

`sandbox`, `worktree`, `commandSandbox`, `mcpServers`, `daemonMount`,
`bundles`, `browser`, `appServe`, `inference` have no meaning for a
vendor-owned harness. The host MUST refuse a cloud spawn that sets any of
them; this adapter's ACP server also refuses `mcpServers` at `session/new`
as a fail-closed backstop. `model` / `effort` / `mode` are not exposed: the
CLI's cloud path accepts no model flag, and the vendor picks the model.

## Auth / secrets

The credential is the user's claude.ai OAuth login, owned by the claude CLI
(macOS keychain service `Claude Code-credentials`; org uuid from
`~/.claude.json`). The adapter reads it only to call the sessions API
(`Authorization: Bearer`, never logged or persisted) and never copies it
into descriptors, events or transcripts (AIP-66 §8). Every claude child
process gets `ANTHROPIC_API_KEY` and the Bedrock/Vertex/Foundry/… redirect
toggles DELETED from its env so the CLI cannot authenticate another way.
A CLI authenticated by API key, or not logged in, is refused with a pointer
to `claude auth login`.

## Surfaces

| Verb    | Vendor mapping                                                        |
| ------- | --------------------------------------------------------------------- |
| start   | `claude --cloud "<prompt>"` (requires a TTY)                          |
| prompt  | `claude -p "<text>" --cloud <session id>` (send-only, no TTY)         |
| observe | `GET https://api.anthropic.com/v1/code/sessions/{id}/events`          |
| state   | `GET /v1/code/sessions/{id}` (`status_bucket`, `worker_status`, …)    |
| list    | `GET /v1/code/sessions`                                               |
| pull    | `claude --teleport <session id>` (host-level; not wired here)         |

Observed with Claude Code CLI 2.1.296–2.1.299 (2026-10-14). These are
undocumented vendor surfaces and may change — the version gate pins the
floor at 2.1.296.
