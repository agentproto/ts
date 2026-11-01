---
"@agentproto/runtime": patch
---

Keep an `external` session's AIP-46 inbox deliverable after its liveness window lapses: `sendMessage` no longer raises `session_not_alive` for an `external` row that is merely `exited` with no end reason and is not retired, so sentinel and workflow notices reach the inbox that `agentproto hook inbox` drains. A killed or retired external row is still refused. (The PR already ships an equivalent changeset; this records the reviewer's confirmation.)
