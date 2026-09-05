# __APP_NAME__ — data plane

The app owns a durable, app-scoped store reached from the UI and the
`__APP_SLUG__-agent` agent via `app_data_read` / `app_data_write` /
`app_data_list`. Keys are path-safe strings; values are JSON. The run-state
ledger (`data/state/events.jsonl`, written by the runner) lives beside them
and is READ-ONLY to agents and the UI — never hand-edit it.

## Keys

| Key | Shape | Written by |
| --- | --- | --- |
| `example` | `unknown` — replace with the app's first real record shape | agent / UI |

Add one row per key the app actually persists: the key, the shape of its
value, and who writes it. This file is the key dictionary the UI and agents
code against — keep it true.
