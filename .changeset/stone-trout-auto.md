---
"@agentproto/driver-agent-cli": patch
"@agentproto/adapter-codex": patch
"@agentproto/runtime": patch
---

Codex now starts inside an app boundary. Adapters can declare a `stateHome`; an OS-confined spawn gets an isolated per-session home (the session's adapter config dir) with only the declared login files linked back from the real one. Codex declares `CODEX_HOME` / `.codex` sharing `auth.json`, and the codex transcript exporter reads a confined session's rollouts from its own home.
