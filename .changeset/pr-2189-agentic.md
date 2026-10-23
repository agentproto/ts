---
"@agentproto/usage-presets": minor
"@agentproto/cli": minor
---

Add `@agentproto/usage-presets`, a new package of usage-named spawn presets (`pr-fix`, `explore`, `implement`, `review`, `deploy`) that resolve to a complete `agent_start` configuration, with a sensitive/free-model guard and a place-aware 2-free-local-agents overflow redirect to the sandbox.

Add the `agentproto usage plan <usage>` CLI entrypoint, which counts live free local sessions from the daemon and prints the resolved spawn plan (human or `--json`).
