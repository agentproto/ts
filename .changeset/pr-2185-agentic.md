---
"@agentproto/cli": minor
"@agentproto/runtime": minor
---

Finish cold-start install and provider auth in one command: share the `config.json` helpers, pin global npm installs to the CLI's prefix, enroll adapters from `agentproto install`, write adapter `api-key` defaults from `auth provider set`, and hot-reload stored provider keys in a running daemon via `POST /providers/reload`.
