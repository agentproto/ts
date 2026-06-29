# @agentproto/acp

## 0.2.0

### Minor Changes

- 6587000: Honor model and add effort to start_agent_session for claude-code adapter

### Patch Changes

- c6a90e2: Fix effort set_config_option rejection swallowed so spawn never fails
- 4baab31: Fix mcpServers wire shape for session/new — map {transport,ref} to ACP {type,url}
