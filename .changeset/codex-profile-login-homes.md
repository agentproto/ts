---
"@agentproto/auth": minor
"@agentproto/harness": minor
"@agentproto/quota": minor
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Use two ChatGPT/Codex subscriptions (one per workspace), the same way two Claude profiles work. A Codex profile (`source: "codex"`) can now carry `codexHome`, the directory holding its own `auth.json`, and a `workspace` pin (`subaccount: { kind: "workspace", id }`, the login's account id). A ChatGPT login is bound to one workspace, so use one home per workspace: `CODEX_HOME=<dir> codex login`, then `agentproto auth profile create codex-solo openai --method oauth-bearer --source codex --codex-home <dir> --subaccount workspace:<account id>`.

- Spawn: the home becomes the session's `CODEX_HOME` (also for a confined session and after a resume); the login in it, and its workspace against the pin, are checked before the spawn, fail-loud. A profile without these fields behaves exactly as before.
- `auth reauth`, `auth discover` / `auth profile import`, the box-login bridge and `auth_profile_create` / `auth_profile_update` / `auth_profile_list` (which lists the workspace titles of the login, never a token) all follow the profile's home.
- `quota_status` now reads Codex subscriptions: the 5 h and 7 d windows from the ChatGPT usage endpoint (`probe` basis, undocumented response, parsed defensively).
