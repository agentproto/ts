# @agentproto/acp

## 0.5.0

### Minor Changes

- 0ea6fc1: Add cross-session permission-hold inbox: permissions ls|approve|deny, MCP tools, REST routes
- 6d4aa4b: Add E2E pairing: daemon identity, pair/v1 handshake, wrapE2E AEAD channel
- 60792f1: Add E2E daemon pairing: rendezvous broker, pair CLI, daemon registry
- 8a4d5d5: Add opt-in E2E encryption for the serve --connect tunnel (tunnel-e2e/v1)

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- a32bb69: Bump test timeouts on subprocess/IO-heavy tests that flake under parallel load
- c8198c6: Fix dropped tool-call arguments from non-terminal ACP tool_call_update frames
- Updated dependencies [7b53b8c]
  - @agentproto/define-doctype@0.1.1

## 0.4.0

### Minor Changes

- 80ca385: Add per-session usage observability: cost + tokens, live via MCP + durable
- fdb8ea1: Add credentialRef + headers to AcpMcpServer for brokered child-MCP auth at spawn time

### Patch Changes

- 6a5c41c: Make model set_config_option non-fatal; fix claude-code stale model list
- b65ca15: Fix opencode adapter crash when mode/model set via ACP config, not CLI flags

## 0.3.0

### Minor Changes

- 83aa850: Add session liveness tracking: pid, lastActivityAt, processAlive on SessionDescriptor
- 872226b: Add per-turn silence watchdog to ACP client to fix hermes hang-without-turn-end
- 79a209a: Add structured per-session transcript capture and daemon-events export source

### Patch Changes

- 3ab696d: Render tool calls/results informatively instead of the generic `[tool] view` line

## 0.2.0

### Minor Changes

- 6587000: Honor model and add effort to start_agent_session for claude-code adapter

### Patch Changes

- c6a90e2: Fix effort set_config_option rejection swallowed so spawn never fails
- 4baab31: Fix mcpServers wire shape for session/new — map {transport,ref} to ACP {type,url}
