# session_commands

List the slash-commands a session's harness advertises — the `/…` commands
and skills the agent answers to — PAGE BY PAGE.

The list used to travel inside every `agent_start` answer (60 entries weigh
~10 KB, and the answer also carried the AGENTS.md body). `agent_start` now
answers with a COMPACT descriptor: `availableCommandsCount` (how many
commands there are) and a `commandsRef` pointing at this tool. The list
itself is read here, one page at a time.

## Addressing

`sessionId` (canonical), `idOrName` or `slug` — the same three handles every
session-addressing tool takes.

## limit / cursor

`limit` (1..200, default 50) and `cursor` (the `nextCursor` of the previous
page) walk the list. The page envelope is `{ items, nextCursor?, total }`.
Walking with a small `limit` until `nextCursor` is absent covers the whole
list exactly once — the cursor is keyed on the command NAME, so it stays
stable across calls.

A call with NO `limit`/`cursor` answers the first 50 rows under the legacy
`{ commands: [...] }` wrapper, plus `{ total, truncated, nextCursor }` when
the list is longer — so a harness advertising hundreds of commands never
answers with an unbounded list.

## name

Keep only the commands whose name starts with this prefix — `"/sk"` for the
`/skill-*` family. Applied BEFORE the pagination, so `total` reflects the
filtered list.

## scope

Keep only the commands with this exact scope — the harness' own scope label
(`"user"`, `"project"`, …). Applied before the pagination too.

## fields

Per-row allowlist: keep only the named keys of each row. The row keys are
`name`, `description`, `hint` and `scope`.

## full

`full: true` adds the harness' own `input` and `_meta` blobs back to every
row (the raw ACP command entry); the default rows are compact
(`name`/`description`/`hint`/`scope` — the fields the UI reads).

## Row shape

```json
{ "name": "/skill-0", "description": "…", "hint": "/skill-0 [args]", "scope": "user" }
```

`hint` is the harness' input hint (`input.hint`), `scope` its scope label
(`_meta.scope`). Both are absent when the harness did not advertise them.
