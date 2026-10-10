# session_list

List the sessions the daemon tracks. A busy daemon holds hundreds, mostly
noise (review lanes, workflow stages, finished one-shot commands), so narrow
server-side before reading. All filters are optional and AND together; rows
come back newest-activity first (`lastActivityAt`, falling back to
`startedAt`) and `total` is the size of the filtered set, before `limit`.

The same names work on `GET /sessions` (query params) and the CLI
(`agentproto sessions --q … --exclude-noise …`).

```json
{ "q": "checkout", "excludeNoise": true, "limit": 10 }
```

## filters

| Filter | Meaning |
|---|---|
| `q` | case-insensitive substring over id, name, label, title and cwd |
| `label` | only sessions whose label equals this (case-insensitive exact match) |
| `cwd` | only sessions whose cwd is this path or lives under it (boundary-aware prefix) |
| `excludeNoise` | preset, see the `excludeNoise` topic |
| `excludeLabelPrefix` | drop sessions whose label starts with any of these (string or list) |
| `excludeLabels` | drop sessions whose label equals any of these exactly (`session_follow`'s `exclude.labels`) |
| `excludeKinds` | drop `terminal` / `agent-cli` / `command` |
| `rootOnly` | only sessions with no parent (`session_follow`'s `selector.rootOnly`) |
| `parentSessionId` | only direct children of this session (id or name) |
| `updatedSince` | last activity (else start) at/after an ISO-8601 time or relative age `30m`, `24h`, `7d`, `2w` |
| `startedSince` | started at/after, same formats |

A malformed `updatedSince` / `startedSince` returns an error result (HTTP 400
`invalid_filter`), never a silently empty list.

## cold history (`includeCold`)

`HISTORY_CAP` bounds how many sessions the registry holds after a restart;
older ones keep their `index.json` sidecar and `events.jsonl` transcript on
disk but are invisible to the live list. `includeCold: true` merges them back
in, and a `q` that matches NOTHING live falls back to them automatically —
an empty page is a worse answer than the session you remember.

Cold rows are terminal records: `pid: null`, `alive: false`, flagged
`cold: true`. They are not promptable or attachable (use `conversation_read`
to read one). Rows the registry already holds always win, they honour every
filter above exactly like live rows, and a subtree-scoped caller never sees
them (a cold row's parent chain can't be verified).

## excludeNoise

Drops exactly:

1. sessions labelled `review:*` or with origin `review`;
2. sessions labelled `wf:*` or with origin `workflow`;
3. ended (`exited` / `killed`) one-shot runs: `kind: "command"`, or a
   `terminal` with no agent adapter (`bash -lc …`, `node script.mjs`).

Keeps live sessions, errored ones, every other agent session (ended ones
included) and agent TUIs such as `claude`. Default false.

## stats and memory

`stats: true | "full"` adds per-live-session RSS, %CPU, process count and the
top commands by RSS (normalized: `pnpm install`, `vitest`, `tsc`, `git`, …)
under each row's `stats`; `"full"` also lists every process (pid, ppid,
command, RSS, CPU, elapsed). Sampled on demand and cached ~3s; rows with no
live process carry no `stats`. `withMemory: true` adds `rssBytes` (summed RSS
of the process tree via `ps`, one spawn per call). For the host-level view
(daemon / provisioning / orphan buckets, load, free memory) use
`session_stats`.

## output

Compact projection by default (id, kind, name, label, status, command, cwd,
model, busy, awaitingInput, blockedOn, lastActivityAt, depth,
parentSessionId, continuedFrom, lastTurnErroredAt, interrupted);
`interrupted: true` marks a session a daemon restart cut off mid-turn (see
`session_continue_interrupted`). `fields:[…]` keeps only some keys per row
(honoured with or without `limit`), `full:true` returns the whole descriptor.
`kind:"command"` rows are hidden unless asked for (`kind:"command"` or
`includeCommands:true`). For ranked text search over past sessions' index
sidecars use `session_search`.
