---
"@agentproto/runtime": minor
"@agentproto/cli": patch
---

`agentproto app validate` (and `catalog verify`) checks an app's `ui.tools` against the daemon's real tool surface instead of a hand-kept list of 21 names, which rejected valid apps such as session-chat. The list is `DAEMON_TOOL_NAMES`, exported as `@agentproto/runtime/daemon-tool-names`, generated from a gateway's `tools/list` with every optional surface wired (`pnpm --filter @agentproto/runtime gen:daemon-tool-names`) and kept exact by a runtime test.
