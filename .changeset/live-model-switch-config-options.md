---
"@agentproto/runtime": minor
---

Live model switch: the daemon now publishes the harness's OWN model vocabulary on the session descriptor.

A mid-session model switch sent the CATALOG model id straight to the agent's ACP `model` config option, and a live agent only accepts the values IT advertises: picking `claude-sonnet-5-5` on a claude-code session answered "Invalid value for config option model: claude-sonnet-5-5" and switched nothing.

- `SessionDescriptor.configOptions` -- a read-time projection (never persisted, like `availableModes`) of the live harness's advertised ACP config options (`session/new` / `session/load_session`), stamped at `list()`/`get()` so `GET /sessions` and `GET /sessions/:id` carry it. The `model` entry is the vocabulary the running agent validates against.
- `POST /sessions/:id/model` (and `agent_set_model`) now sends a value the agent ADVERTISED verbatim, skipping the catalog wire normalization (vendor-prefix stripping) that would otherwise rewrite an already-advertised value into a string the agent does not accept. A value the agent did NOT advertise is normalized exactly as before.
