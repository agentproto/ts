---
"@agentproto/runtime": patch
---

Persist the sandbox session holder on the session descriptor and replay it on both re-attach paths (`session_restart` and the boot-time reattach pass). Sandbox spawns now send the agentproto session id to the provider as `config.sessionHolder`, and no secret is persisted.
