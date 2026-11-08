# session_labels

Turns session ids into the name an app UI can show. Read-only: no side
effect, no transcript read, no adapter call.

It exists so an app can list this one tool in its `ui.tools` instead of
`session_list`. Anything in `ui.tools` is reachable by every agent through
`app_tool_call`, and `session_list` would hand them the whole session list
(cwd, prompts, models and more). This tool returns nothing but the fields
below.

```json
{ "ids": ["sess_8ad199ca", "session:3fa91c:sess_77b0e1d2", "sess_gone"] }
```

```json
{
  "labels": [
    { "id": "sess_8ad199ca", "label": "linkedin-scout", "adapter": "claude-code", "state": "idle" },
    { "id": "session:3fa91c:sess_77b0e1d2", "label": "cv-writer", "operatorLabel": "jeremy-cv", "adapter": "codex", "state": "live" },
    { "id": "sess_gone" }
  ]
}
```

## input

`ids`: 1 to 100 strings, each 1 to 256 characters. An empty list, more than
100 ids, or an over-long id is refused with an error result. Two forms
resolve:

- a bare session id (`sess_8ad199ca`);
- `session:<fp>:<sessionId>` (the form a browser tab owner is recorded in):
  the last `:` segment is the session id.

Only ids match. A session name or label is not looked up.

## output

`{ labels: [...] }`, one row per input id, in input order. `id` echoes the id
exactly as sent.

| Field | Meaning |
|---|---|
| `id` | the input id, verbatim |
| `label` | the session's `label` (what the spawner or a `session_rename` set). Absent when it has none. The prompt-derived title is never used |
| `operatorLabel` | the immutable operator-assigned label of a root session, when it has one |
| `adapter` | the adapter slug (`claude-code`, `codex`, ...), when the session has one |
| `state` | `live` (alive and working), `idle` (alive, waiting for input or no turn in flight), `exited` (ended, killed or errored), `unknown` |

An id the daemon does not know gives `{ "id": "..." }` alone, with no
`state`. Optional fields are omitted, never `null`.

## from an app UI

An installed app that lists `session_labels` in its `ui.tools` can call it
through `app_tool_call` / `POST /apps/:id/tool-call`. An app that does not
list it is refused like any other tool. That path calls the tool handler
without the input schema, so the handler validates `ids` itself.
