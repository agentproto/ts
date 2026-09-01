# @agentproto/skill-pack-agentproto

## 0.8.0

### Minor Changes

- 0259d5f: Rewrite the agentproto-plugin skill pack as a 3-layer family: an L0 master map (`agentproto`), 18 L1 primitives (`ap-*`) that each teach one daemon action, 4 L2 groupers that route to primitives without duplicating mechanics, and 6 L3 end-to-end playbooks (`pb-*`). Removes the old flat set (adapter-setup-kit, agent-session-orchestration-agentproto, durable-supervision, hermes-headless-background, light-coder-orchestration, nested-orchestration, supervisor-session). Keeps `agentproto-apps` (app-dir anatomy / `app serve` UI bridge / `app_data_migrate` / smoke-test recipe are not covered by the new primitives) and `agentproto-llm-endpoint` (its CLI `--base-url`/`--auth-token` guidance matches the current CLI; the rewrite's copy claims those flags don't exist). Ported from the already-reviewed rewrite in agentik-studio (agentik-studio#86).

## 0.6.1

### Patch Changes

- 99fb2fb: Accuracy pass on skill documentation and AGENTS.md. Fixes ~20 tool names in skill documentation to match current runtime API (agent*output, command_log_tail, file*\_, terminal\_\_, etc.). Corrects permissions_respond schema documentation. Removes diverged duplicate SKILL.md file from packages/cli/skill/ (never imported by code but shipped in npm tarball). Updates reference documentation paths and line numbers.
- b941fd1: Translate French skill documentation to English. Includes supervisor-session, durable-supervision, agent-session-orchestration-agentproto, nested-orchestration, light-coder-orchestration, hermes-headless-background, adapter-setup-kit, and bureau quickstart. Preserves all API names, commands, JSON, paths, and code examples verbatim. Also applies bundled API reference fixes: execute_command → command_execute, read_file/write_file → file_read/file_write, get_agent_session_output → agent_output, create_tunnel → tunnel_create.

## 0.6.0

### Minor Changes

- 5cfe945: Add agentproto-apps skill for building and operating AIP-42 agent apps

## 0.5.3

### Patch Changes

- ab0c2e5: Documentation: add Preflight section to supervisor-session skill (load target repo's agent-instructions, validate auth profile + adapter list before spawn); add Brief Contract section containing operational discipline block (gate = exit code not piped output, truth = disk not report, foreground waits, wedged-session recovery, auth-by-profile-method) meant to be copied verbatim into every executor/supervisor brief. Add cross-references to Brief Contract from nested-orchestration, light-coder-orchestration, agent-session-orchestration-agentproto, and durable-supervision skills.
- ff9c348: Fold RoutineRunner into AIP-15 workflow; routine\_\* verbs become deprecated workflowRunner aliases
- 1cbb910: Remove deprecated RoutineRunner aliases and workflow shim (Phase B3 cleanup).

  The imperative RoutineRunner engine was removed in Phase B2; this PR eliminates the 4 deprecated MCP verbs (`routine_start`, `routine_status`, `routine_cancel`, `routine_escalation_resolve`), their HTTP run routes, and the thin `routine-workflow-shim.ts` that backed them. Preserves AIP-41 routine tools (`routine_list`, `routine_trigger`, `routine_reconcile`) and the `GET /routines` registrar listing route.

## 0.5.2

### Patch Changes

- a97108b: Add CI review/fix lanes and skill-authoring reference guides to the agentproto skill

## 0.5.1

### Patch Changes

- a7599f4: Add inbound + edge/WAF access gates and fix /v1 pack-path normalization
- 98cb3a7: Document edge token layer, print-waf-rule, and public model discovery in the agentproto-llm-endpoint skill's SKILL.md
- 76a6537: Prescribe native agent_start({worktree}) over manual git worktree add in supervisor skills

## 0.5.0

### Minor Changes

- c271e80: Add skill-pack packages and extract shared zip helper with path fix
