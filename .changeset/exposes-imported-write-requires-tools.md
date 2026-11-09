---
"@agentproto/app": minor
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Apps expose imported MCP tools at write and approve access, and `requires.apps[].tools` grants provider tools to the consumer's own agents.

- `exposes.tools` accepts an `imported:<alias>/<tool>` entry at `access: write` or `approve`, with the same visibility as a bundled entry: hidden in mode `read`, visible in mode `all`, to an AGENT.md opt-in, or through a grant. The caller session reaches the imported server.
- The gateway re-checks `exposes.tools` per entry (`checkExposedTools`): an invalid entry is skipped and logged on its own, the app's other tools stay.
- `POST /apps/:appId/tool-call` runs a `write` or `approve` exposed tool only for a caller session with an opt-in, a grant or mode `all`; reads work as before. It applies the gateway's deny rules to every exposed tool, reads included: the caller's tool deny grants and the request's `?denyTools=` / `?allowTools=`, through the same check `/mcp` uses. `agentproto mcp-app` forwards `$AGENTPROTO_SESSION_ID` as the caller.
- `requires.apps[].tools` (AIP-53 Requirements) lists provider tool MCP names (`bureau_navigate`). Sessions the daemon runs from the consumer's own AGENT.md files (`app_run`, or a manifest path the app declares) get them at the provider's access class. An unexposed name refuses the consumer's install; a missing or unmet provider is reported as `unmetRequires` (`not-installed`, `version-mismatch`, `tool-not-exposed`) by `app_install` and `app_list` and grants nothing. The loader refuses a non-MCP-name `tools` entry, two `apps` entries with the same id, and an unknown `requires` key.
