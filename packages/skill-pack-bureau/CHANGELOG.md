# @agentproto/skill-pack-bureau

## 0.3.0

### Minor Changes

- 5284213: Relocate local-browser skill into skill-pack-bureau. Consolidates skill distribution into the dedicated skill pack; plugin functionality and TypeScript API remain unchanged. Users should install the skill via `agentproto install skill/local-browser --pack bureau-plugin` instead of from the plugin package.

### Patch Changes

- 99fb2fb: Accuracy pass on skill documentation and AGENTS.md. Fixes ~20 tool names in skill documentation to match current runtime API (agent*output, command_log_tail, file*_, terminal\__, etc.). Corrects permissions_respond schema documentation. Removes diverged duplicate SKILL.md file from packages/cli/skill/ (never imported by code but shipped in npm tarball). Updates reference documentation paths and line numbers.
- b941fd1: Translate French skill documentation to English. Includes supervisor-session, durable-supervision, agent-session-orchestration-agentproto, nested-orchestration, light-coder-orchestration, hermes-headless-background, adapter-setup-kit, and bureau quickstart. Preserves all API names, commands, JSON, paths, and code examples verbatim. Also applies bundled API reference fixes: execute_command → command_execute, read_file/write_file → file_read/file_write, get_agent_session_output → agent_output, create_tunnel → tunnel_create.

## 0.2.0

### Minor Changes

- c271e80: Add skill-pack packages and extract shared zip helper with path fix
