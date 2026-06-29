# @agentproto/driver-agent-cli

## 0.2.0

### Minor Changes

- adf4583: Add print-arm protocol driver, AIP-52 harness schema, and agentproto SKILL.md
- 5c2063e: Thread mcpServers through spawn to ACP newSession/loadSession; add named Cloudflare tunnel provider
- 0022b2a: Thread mcpServers through spawn to ACP newSession/loadSession (orchestrator WP1)
- 6587000: Honor model and add effort to start_agent_session for claude-code adapter
- 04c9a5a: Add `print` protocol arm: new AgentCliProtocol member, createPrintSession export, skill/ publish

### Patch Changes

- 04c9a5a: Wire `print` protocol arm: add `"print"` to `AgentCliProtocol` + schema enum, short-circuit in `createAgentCliRuntime.start()` to call `createPrintSession` directly (the print arm spawns per-turn, not a long-lived `AgentCliClient`), export `createPrintSession`/`PrintArmOptions` from the package index, and publish the `skill/` directory from `@agentproto/cli`.
- c6a90e2: Fix effort set_config_option rejection swallowed so spawn never fails
- 7542339: Fix hermes model selection (apply:"command") + wait_for_any fast-turn race
- Updated dependencies [c6a90e2]
- Updated dependencies [4baab31]
- Updated dependencies [6587000]
  - @agentproto/acp@0.2.0
