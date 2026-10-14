---
"@agentproto/runtime": minor
---

AIP-66 managed cloud agents: `agent_start.cloud` names a vendor (e.g. `cloud: "anthropic"`) that owns the machine and harness; the runtime resolves it to the vendor's cloud adapter (`claude-code-cloud`), refuses the spawn fields a cloud target can never apply (worktree, commandSandbox, mcpServers, daemonMount, bundles, browser, appServe, inference) with a typed `cloud_spawn_refused` error, skips host auth/profile resolution, and persists the learned vendor session id onto `meta.cloud` so restarts and re-attaches resume the vendor's own session.
