---
"@agentproto/app": minor
"@agentproto/cli": patch
"@agentproto/operator": minor
"@agentproto/runtime": minor
---

The daemon's /mcp gateway now registers the `exposes.tools` of every installed app as `<prefix>_<name>` tools, right after `app_install` and without a restart. `access: read` tools are visible to every caller; `write` and `approve` tools only to a session whose AGENT.md lists the exact MCP name in an `{ kind: mcp, server: agentproto, allow: [...] }` entry (`exposedToolOptIn`, carried across restart and continue-fresh). Exposed tools go through the same deny gate and `?denyTools` filters as the built-in ones. `defaults.apps.exposedTools` (`read` default, `off`, `all`) is the kill-switch, read per request and honored by `POST /apps/:appId/tool-call` too. `app_install` refuses a prefix already held by another app or reserved by a daemon tool family (reinstalling the same appId is allowed); `exposes` is persisted in the app registry. `approval*` ids are never exposed. The transitional rule that every exposed id must be in `ui.tools` is lifted. `mcp-app` now warns on an unknown `--access` value instead of failing, and a malformed or empty `exposes.tools` no longer silently falls back to the legacy behavior.
