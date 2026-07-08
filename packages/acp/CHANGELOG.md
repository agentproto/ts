# @agentproto/acp

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
