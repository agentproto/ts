# @agentproto/driver-agent-cli

## 0.4.0

### Minor Changes

- 6b8b023: Add bin_args_prepend, plumb options map, and declare lean modes on agent-CLI adapters
- 7142f1c: Add per-mode support status (active|noop|planned) to AIP-45 agent-CLI manifest
- 3a76562: Add models.deny to agent-CLI manifest; reserve Anthropic for claude-code
- a28bebc: Add provider-presets catalog listing and AIP-45 presets manifest field

### Patch Changes

- 6f867e1: Fix print-arm ENOBUFS crash by draining stdout independently of downstream
- 6c83622: Emit usage_update transcript events for hermes and mastracode adapters
- b65ca15: Fix opencode adapter crash when mode/model set via ACP config, not CLI flags
- 7f8b45a: Export missing AgentCliPresetDeclaration type from package index
- Updated dependencies [80ca385]
- Updated dependencies [6a5c41c]
- Updated dependencies [fdb8ea1]
- Updated dependencies [b65ca15]
  - @agentproto/acp@0.4.0

## 0.3.0

### Minor Changes

- 06132bc: Implement the AIP-45 `protocol: "proprietary"` arm end to end: `createProprietaryProtocolArm` now dynamic-loads an adapter's `createAgentCliClient` factory and `createAgentCliRuntime` skips the subprocess spawn for it. Ship `@agentproto/adapter-mastracode-inprocess`, a new adapter driving Mastra Code in-process via its SDK (`createMastraCode` + `runMC`) instead of spawning the CLI, with a composite `resourceId:threadId` session id that verifiably survives a process restart. Register the new `mastracode-inprocess` slug in the CLI's adapter catalog.

  Fix `resolveAdapter` to rewrite a `protocol: "proprietary"` handle's `adapter` field to a fully-resolved absolute path before handing it off — `createProprietaryProtocolArm` re-imports that field a second time from `@agentproto/driver-agent-cli`'s own module location (which deliberately depends on no specific adapter), so a bare package-name specifier that resolved fine during discovery could fail to resolve at session-start. Applies to every proprietary adapter, not just this one.

- 2d1434a: Add mastra-jsonl print-arm schema, AgentCliPrintConfig, and adapter-mastracode
- 83aa850: Add session liveness tracking: pid, lastActivityAt, processAlive on SessionDescriptor
- 872226b: Add per-turn silence watchdog to ACP client to fix hermes hang-without-turn-end
- 06132bc: Implement AIP-45 proprietary protocol arm; ship adapter-mastracode-inprocess

### Patch Changes

- 1bf295b: Fix claude-code plan/accept-edits/bypass-permissions modes via CLAUDE_CONFIG_DIR override
- 78d09e6: Fix plan-mode sessions silently auto-approving their own exit-plan-mode escalation
- 559cff3: Fix mastracode print arm: wrong flag, fragile thread capture, mismarked resume
- c2b6779: Fix mcpServers/orchestrator mounting silently no-op'ing on mastracode and mastracode-inprocess adapters
- e27fc94: Add GET /sessions/:id/events for incremental polling; fix mastra tool_start args
- 837967a: Fix transcript-writer stripping newlines from text-delta/thought events
- Updated dependencies [83aa850]
- Updated dependencies [872226b]
- Updated dependencies [3ab696d]
- Updated dependencies [79a209a]
  - @agentproto/acp@0.3.0

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
