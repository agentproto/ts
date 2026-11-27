# `/mcp` in MCP 2026-07-28: what the gateway serves

The daemon's root `/mcp` endpoint is dual-era. A request whose `MCP-Protocol-Version` header (and `_meta`) says
`2026-07-28` is served by the stateless modern core; everything else keeps the `2025-11-25` transport. Both eras
build the same per-request tool server, so the tool catalog, its filters (`?denyTools=`, `?allowTools=`,
`?deferred=1`, `?profile=`, `?surface=`) and the caller identity are the same on both. The normative text is
[AIP-77](https://github.com/agentproto/agentproto/blob/main/specs/aip-77.mdx) (gateway, Skills binding, human
input over MRTR) and [AIP-78](https://github.com/agentproto/agentproto/blob/main/specs/aip-78.mdx) (one session turn
as an MCP task). What is checked against a live server, method by method, is in
[`mcp-conformance-matrix.md`](./mcp-conformance-matrix.md).

The Events extension (`events/*`, `events/stream`, `notifications/events/*`) is described in
[`mcp-events-integration.md`](./mcp-events-integration.md) and is not repeated here.

## What a modern request gets

- **`server/discover`** answers `supportedVersions: ["2026-07-28", "2025-11-25"]` (the second is advertised for
  clients that fall back, it is never accepted on the modern path), the server's `capabilities` without
  `listChanged` (no `subscriptions/listen` is served), `capabilities.extensions` for every extension switched on,
  `_meta["io.modelcontextprotocol/serverInfo"]`, `ttlMs` and `cacheScope`.
- **Methods**: `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`,
  `prompts/list`, `prompts/get`, the Events methods, and, while their extension is on, `tasks/get`,
  `tasks/update`, `tasks/cancel`, `skills/list`, `skills/get`. Any other method, including the removed
  `initialize`, `ping`, `logging/setLevel`, `tasks/result` and `tasks/list`, is HTTP 404 `-32601`.
- **Headers**: `MCP-Protocol-Version` must equal `_meta["io.modelcontextprotocol/protocolVersion"]`, `Mcp-Method`
  must equal the method, and `Mcp-Name` must equal `params.name` (`tools/call`, `prompts/get`), `params.uri`
  (`resources/read`) or `params.taskId` (`tasks/*`). A mismatch is HTTP 400 `-32020`. `skills/get` carries no
  `Mcp-Name`. A version the core does not accept is HTTP 400 `-32022` with `data.supported` and `data.requested`.
- **`_meta`**: `protocolVersion` and `clientCapabilities` are required (HTTP 400 `-32602` otherwise);
  `clientInfo` is optional. Request `_meta` is never echoed into a result.
- **Results** always carry `resultType`: `complete`, `input_required` (human input, below) or, for a client that
  declared the Tasks extension, `task`. The cacheable operations (`server/discover`, the four lists,
  `resources/read`, `skills/list`, `skills/get`) carry `ttlMs` and `cacheScope`; the default policy is
  `ttlMs: 0`, `cacheScope: "private"` (never cached). `tools/call`, `prompts/get`, `events/*` and `tasks/*` carry no
  `cacheScope`; a task's `ttlMs` is its retention, not a cache hint.
- **Transport**: POST only (other verbs are 405 with `Allow: POST`), `Accept` must allow `application/json`
  (406), `Content-Type` must be `application/json` (415), one JSON-RPC request per body (a batch or a response is
  400 `-32600`). A notification is 202 with no body. `Mcp-Session-Id` is ignored and never returned.

## Flags and how to roll back

Every flag is read on each request from the daemon config, so `config_set` takes effect on the next call, with no
restart. All default to `true`.

| Flag | Turns off | When off |
|---|---|---|
| `mcp.modernEra` | the whole modern era of `/mcp` | every `/mcp` request takes the `2025-11-25` transport |
| `mcp.humanGate` | every human-input surface below | tools answer their ordinary result, never `input_required` |
| `mcp.humanGateApprovals` | the approval surface alone | `approval_get` / `approval_wait` answer as before |
| `mcp.humanGateRuns` | the run surface alone | `workflow_status` answers as before |
| `mcp.tasks` | the Tasks extension | not announced in `server/discover`, `tasks/*` are 404 `-32601`, `agent_start` / `agent_prompt` answer as before |
| `mcp.extensions.skills` | the Skills extension | not announced, `skills/*` are 404 `-32601`, no `skill://` resource |
| `mcp.eventsExtension` | `events/poll` and the Events extension declaration | see the Events page (`mcp.eventsStream` is its push switch) |

The Tasks extension has its own settings besides its switch: `mcp.tasksTools` (`both`, `agent_start` or
`agent_prompt`), `mcp.tasksTtlMs` and `mcp.tasksMaxTtlMs` (retention of a finished task), `mcp.tasksMaxPerPrincipal`
and `mcp.tasksResultMaxChars`.

## Human input over MRTR

When work is parked on a human, a modern client that declared `elicitation` can be asked directly: the tool call
answers an `InputRequiredResult` carrying one `elicitation/create` request and a signed `requestState`, and the
client retries the same call with `inputResponses` and that `requestState`. This is a transport only: the judge of
each primitive still decides. The question format is [AIP-45](https://github.com/agentproto/agentproto/blob/main/specs/aip-45.mdx)
("MCP transport of a question", added by agentproto/agentproto#183).

| Surface | Observed on | Mode | Who is asked |
|---|---|---|---|
| Held permission | `permissions_list`, `session_monitor`, `tasks/get` of the session's turn | `form` | the operator, or a session resolving one of its own descendants |
| Session question | same | `form` | same |
| Pending approval | `approval_get`, `approval_wait` | `url` | the caller |
| Run waiting for input | `workflow_status` | `form` | the operator only |

What always holds:

- A surface is projected only to a client that declared the matching mode; otherwise the tool's ordinary result.
- A form is built only from the flat schema subset, and never for a field that asks for a secret, a credential or
  payment data: such a request is not projected and stays answerable through the host's own tools.
- A session is never asked to resolve its own permission or question.
- The `requestState` binds the caller, the tool, a hash of the arguments, the entity and an expiry, and is single
  use. A retry whose state is altered, expired, already used, or presented by another caller is `-32602`. A
  missing or incomplete answer gets a fresh `InputRequiredResult`, not an error.
- Approval and run tokens survive a daemon restart; permission and question tokens do not
  (`-32602`, `data.reason: "input_unavailable"`).
- An `accept` on an approval only says the page was shown: it neither decides nor consumes the approval.

What is not projected (limits, by design today):

- A run waiting on an `escalate` policy: it carries neither a question nor a schema, and its position lives only in
  the runner's memory.
- A run whose input schema is not flat: there is no console page to send it to, so no `url` either.
- `workflow_run_file` and `approval_request`: `workflow_status` and `approval_get` are the observers.
- A single choice that also allows free text loses its `choices` in the form (the flat subset cannot say "one of
  these, or any text"); a typed choice is still matched back on the answer.

### `approvals.uiBaseUrl`

The approval surface needs a page to send the human to: `approvals.uiBaseUrl`, to which the approval id is added
as `?approval=<id>`. It has no default. While it is not set, no approval elicitation is produced at all. A base
that could carry a credential (userinfo, a fragment, or a query key such as `token`, `api_key`, `session-id`) is
refused, and the daemon logs the reason once, never the URL. The daemon ships no standalone page at such an
address: the human surfaces for an approval remain the MCP Apps card (`ui://agentproto/approval/<id>`) and the
Telegram link.

## Tasks (one turn as a task)

For a client that declared `io.modelcontextprotocol/tasks`, `agent_start` (with a prompt) and `agent_prompt`
answer a `CreateTaskResult` (`resultType: "task"`) instead of their ordinary result; the server decides, no
parameter can force or suppress it. The task is written to disk before the session hears of the prompt.
`tasks/get` answers `resultType: "complete"` with `working`, `input_required` (a parked permission or question,
with its `inputRequests` for a client that declared elicitation), `completed` (the turn's text under `result`),
`failed` (for instance a turn lost to a daemon restart, with a JSON-RPC `error`) or `cancelled`. `tasks/update`
and `tasks/cancel` answer an empty acknowledgement; cancelling acts on that turn only and never on a later one.
An unknown, expired or foreign `taskId` is the same HTTP 400 `-32602`, and a client that did not declare the
extension gets HTTP 400 `-32021` naming it. The session outlives its tasks.

## Skills

While `mcp.extensions.skills` is on, `server/discover` declares the Skills extension and `resources`.
`skills/list` and `skills/get` serve the imported-skills registry only, by skill name (never a display alias),
with the frontmatter as written and a manifest of every file (`sha256` over the raw bytes, and the size). Files are
read as `skill://<name>/<path>` through `resources/read`. A path with `.`, `..` or an encoded separator, a file
outside the manifest, or a symbolic link leaving the skill folder is `-32602`. A skill above 512 files or 16 MiB
is not served. `resources/directory/read` is not served.

## Conformance

[`mcp-conformance-matrix.md`](./mcp-conformance-matrix.md) lists every replayed case per method, generated from the
`_conformance` blocks of the fixtures under `packages/runtime/src/__tests__/fixtures/` by
`node scripts/mcp-conformance-matrix.mjs` (`--check` fails when the committed page is stale). One command replays
the gateway, human input, tasks and skills:

```sh
pnpm --filter @agentproto/runtime test mcp-conformance mcp-modern mcp-skills
```

Known defects are listed at the end of the matrix: today a refused MRTR retry and the Skills errors answer
`-32602` with HTTP 200, where AIP-77's error mapping gives HTTP 400.
