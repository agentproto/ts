# @agentproto/acp

## 0.7.3

### Patch Changes

- f0c51a7: Weekly dependency bump: update 9 minor/patch dependencies to latest versions.
  - @anthropic-ai/claude-agent-sdk 0.3.241 → 0.3.251
  - @ast-grep/napi 0.45.2 → 0.45.3
  - @earendil-works/pi-tui 0.84.2 → 0.84.4
  - @tanstack/react-query 5.102.2 → 5.102.8
  - @testing-library/react 16.3.2 → 16.3.3
  - e2b 2.45.0 → 2.46.1
  - tsx 4.23.12 → 4.23.13
  - turbo 2.10.11 → 2.10.12
  - zod 4.4.3 → 4.5.4

  No code changes; pnpm-lock.yaml updated to reflect new dependency versions.

## 0.7.2

### Patch Changes

- 64088e0: Refuse to run a derived-from-model adapter on its default model when the requested model was not applied. Launching opencode with an id its server can't resolve (e.g. a claude-code-style `…@openrouter` suffix) used to warn on the daemon's stderr and silently run — and bill — the server's default `anthropic/claude-sonnet-4-5` instead; hermes had the same hole one strategy over (its spawn-time `/model <id>` control turn's result was ignored), and jcode a protocol over (its CLI silently falls back to its own default on an unknown `--model` id — observed live: `--model totally-bogus-xyz` → started on `gpt-5.6-sol`/OpenAI). Three guards now share one contract for `routeSelection:"derived-from-model"` adapters: the ACP client records a connect-time model rejection structurally (`AcpClientSession.modelApplyRejection`) and the driver refuses the spawn on a rejected `set_config_option` (opencode-style `apply:"config"`) or an unacknowledged/failed `/model` control turn (hermes-style `apply:"command"`); the print arm aborts a turn whose jcode-ndjson `start` line reports a model contradicting the requested one (basename compare, `@route`-suffix/`provider/`-prefix tolerant). Every refusal names the requested id and the concrete reason. Free/fixed-routing adapters keep the agentproto#186 warn-and-continue behavior unchanged; pi errors properly on its own (`Model not found`) and needs no guard.
- baf8570: Surface ACP's `available_commands_update` notification instead of silently dropping it. `translateSessionUpdate` now maps it to a new `available-commands` StreamEvent, `transcript-writer` persists it to `events.jsonl`, and the daemon mirrors the latest command list onto `SessionDescriptor.availableCommands`, exposed read-only via `GET /sessions` / `GET /sessions/:id`.

## 0.7.1

### Patch Changes

- b5ec52b: Add optional title field to plan events, displayed in VS Code conversation UI. Titles are safely threaded through ACP client translation, runtime event stream, and conversation presenter, supporting both immediate titles and late-binding (title added in subsequent plan updates).

## 0.7.0

### Minor Changes

- 5ba2032: Add rawInput field propagation through permission-hold system. The tool call's raw input (e.g. Bash command string) now flows from requestPermission RPC → agent-prompt event → PendingPermission object → HTTP/MCP APIs, surfacing in the CLI `permissions ls` table as a truncated preview for enhanced transparency in permission request review.

### Patch Changes

- b3e1648: Fix a false-green where an un-authenticated agent turn reported success. The ACP client mapped any non-`cancelled`/`max_turns` `stopReason` — including `refusal`, which claude-sdk returns after a 401 auth failure — to a `completed` turn-end. Because the adapter also emits a `[claude-sdk error]` chunk, the turn is not empty, so the existing empty-turn guard missed it and the workflow step reported `done`. The ACP client now maps `refusal` and any unknown/missing `stopReason` to `reason: "error"` — while routing the budget-cap reasons (`max_tokens`, `max_turn_requests`) to the non-failing `max_turns` bucket so a legitimate long turn isn't misfired as an error — and the workflow agent-host fails a step whose turn ends with `reason: "error"` (not only empty turns), so an auth-failed reviewer run reports `failed` and falls back instead of passing blind.

## 0.6.0

### Minor Changes

- a021138: Add ACP capability read-surface (configOptions/modes) and live setSessionMode

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
