# @agentproto/runtime

## 0.4.0

### Minor Changes

- 8d1191e: Rename all MCP tool verbs to family-first taxonomy (agent*\*, session*_, terminal\__, command*\*, file*_, directory\__, browser*\*, policy*_, routine\__, tunnel\_\*), split agent tools into a dedicated `agent-tools.ts` module, and fix harness call-sites.
- 16d52cd: Add WorkflowRunner primitive, deferred tool gateway, structured awaiting-input, and agent_start mode wiring
- 17aff95: Add durable cron scheduler with MCP tools, REST routes, and CLI verb
- 5c207ca: Add scriptable session/policy wait — REST endpoints and CLI subcommand
- 83aa850: Add session liveness tracking: pid, lastActivityAt, processAlive on SessionDescriptor
- 872226b: Add per-turn silence watchdog to ACP client to fix hermes hang-without-turn-end
- 5616041: Add session_restart MCP tool and extract shared resume decision tree
- 111a599: Add prompt-session cron action to re-prompt a live session
- 29d9c55: Add REST parity for routines, workflows, and policies HTTP routes
- 4f1565b: Share agent_start spawn logic between MCP tool and HTTP route via spawnAgentSession
- 3ab696d: Render tool calls/results informatively instead of the generic `[tool] view` line
- caab49e: Add AgentStep kind and AgentSessionHost; wire WorkflowRunner onto the interpreter
- 79a209a: Add structured per-session transcript capture and daemon-events export source
- 3cfe18a: Add outputSchema/maxRetries to AgentStep with validate-and-retry loop
- 887ea34: Add run-level cost ceiling (maxTotalCostUsd) and AgentSessionHost.readCostUsd
- 4b76485: Add opt-in journal cache for cacheable steps — replay unchanged outputs on re-invocation
- e27fc94: Add GET /sessions/:id/events for incremental polling; fix mastra tool_start args

### Patch Changes

- f89be1f: Default-mount daemon MCP gateway for hermes agent_start spawns; fix orchestrator merge-line bug
- fb1e5f0: Thread daemonMcpUrl into scoped orchestrator gateway to fix hermes zero-tool spawns
- a648994: Fix processAlive returning undefined from findByIdOrName on live sessions
- 71c52eb: Fix policy_attach gates throwing "cwd escapes workspace" for worktree sessions
- 3812f01: Don't duplicate a salient arg already baked into a curated tool title
- 8ce517b: Fix silent prompt-delivery failures for dead and busy sessions
- 837967a: Fix transcript-writer stripping newlines from text-delta/thought events
- Updated dependencies [83aa850]
- Updated dependencies [872226b]
- Updated dependencies [3ab696d]
- Updated dependencies [caab49e]
- Updated dependencies [79a209a]
- Updated dependencies [3cfe18a]
- Updated dependencies [887ea34]
- Updated dependencies [987db7b]
- Updated dependencies [4b76485]
- Updated dependencies [a5c4701]
  - @agentproto/acp@0.3.0
  - @agentproto/workflow-runtime@0.2.0

## 0.3.0

### Minor Changes

- 7a310ff: Add model-catalog package, provider-key store, and `agentproto models` command

## 0.2.0

### Minor Changes

- ea9be98: Wire the browser CLI verb into the router and register browser MCP tools (start_browser / list_adapter_browsers) in the gateway.
- e33d99a: start_browser no longer blocks the MCP request during a cold start — heavy services (chromium/bureau) register immediately as `starting` and converge to healthy in the background; opt-in via BrowserProcessSpec.initialWaitMs, default behavior unchanged.
- 593b0fc: Wire RoutineRunner into root gateway and persist runs to disk
- 358949b: Expose optional per-session notifyUrl on start_agent_session tool
- 79149d5: Add InboundWatcher — poll agentpush and spawn agents on inbound events
- fc6fd0b: Add session cost/cap, wait:true one-shot, clean output, model echo, wait_for_any cursor
- 250f474: Migrate tunnel providers onto a slug-keyed adapter-kit registry; ngrok now creatable end-to-end; third-party providers pluggable
- dc870cf: tool: toolFromManifestOnly + optional inputSchema/outputSchema; runtime: session lifecycle events on bus + completion-policy supervisor MVP
- 3e348e3: Add WP3 policy persistence: boot reload, re-arm, and session-absent cancellation for CompletionPolicySupervisor
- 5c2063e: Thread mcpServers through spawn to ACP newSession/loadSession; add named Cloudflare tunnel provider
- 0022b2a: Thread mcpServers through spawn to ACP newSession/loadSession (orchestrator WP1)
- a15acc4: Add fan-in completion policy (WP4): attach_policy accepts sessionIds[] for all-of groups
- 618d424: Add orchestrator sub-gateway WP2–WP4: scoped MCP endpoint, scope-token registry, recursion guardrails
- 452b751: Add agents-overview + bureau-sessions MCP App panels and summarize_session tool
- 9cacd25: Add WP6 subtree-scoped supervisor composition for child orchestrators
- 6587000: Honor model and add effort to start_agent_session for claude-code adapter
- 6738ef9: Surface adapter manifest (location/install/config) over MCP; add binPath to start_browser
- ec769ab: Extract daemon helpers, add POST /sessions/browser route, fix stop_browser return shape
- 0d3b8f9: Add @agentproto/adapter-kit and migrate tunnel/browser/CLI adapter families onto it
- 7a89e37: Surface exportAgentSession via export_session MCP tool and sessions export CLI
- 1b8ae4e: Add browser_screenshot MCP tool — base64 frame proxy for live agent-browser view
- e6c9b80: Routine runner, orchestration tools, session event bus, event ring, transcript export.

  Adds `RoutineRunner` for scheduled / event-triggered routine execution, `SessionEventBus` for typed intra-session pub-sub, `EventRing` as a bounded circular buffer for session events, `orchestration-tools` (run-routine, list-routines AIP tools), and `exportTranscript` for full-session transcript serialisation. Also extends `sessions.ts` with `awaitingInput` state and browser-session fields (non-breaking additions).

- 405ea4d: Add MCP Apps adapter and agentproto_sessions panel (AgnoMcpApp)
- cfbeb8f: Browser-as-adapter stack: adapter-browser, browser-process primitive, `agentproto browser` CLI

### Patch Changes

- 0c7ced0: Fix bureau /mcp dispatch: add text/event-stream to Accept header to prevent HTTP 406
- 4277e54: Fix RoutineRunner fast-session race and honour start_routine cwd
- 8e540c3: Update browser session label on idempotent registerBrowser hit
- 7542339: Fix hermes model selection (apply:"command") + wait_for_any fast-turn race
- 43f9c8a: Add central daemon registry so CLI discovers a daemon from any cwd
- c938b78: Fix JSON-stringified union/object MCP params being rejected by zod (cowork client compat)
- 1769728: Fix attach_policy MCP schema to expose judge-gate variant alongside shell gate
- 7fec1bc: Add multi-field makeSetupTool variant; migrate cloudflare-named to SetupField[]
- 979d01a: Make ngrok check() env-independent via injectable probeBinary; fixes CI
- b86264b: fix(browser): HTTP route and registerBrowser cloud/local parity
- Updated dependencies [c6a90e2]
- Updated dependencies [250f474]
- Updated dependencies [4baab31]
- Updated dependencies [6587000]
- Updated dependencies [0d3b8f9]
- Updated dependencies [7fec1bc]
- Updated dependencies [4b2c9ec]
- Updated dependencies [2186e9e]
  - @agentproto/acp@0.2.0
  - @agentproto/adapter-kit@0.1.0
  - @agentproto/mcp-server@0.2.1

## 0.1.1

### Patch Changes

- 1fc1750: Add loadAgent, updateManifestSet, self_inspect MCP tool, and extends-chain validation
- 1fc1750: Add loadAgent, validateExtendsChain, updateManifestSet, and self_inspect MCP tool
- Updated dependencies [1fc1750]
- Updated dependencies [1fc1750]
  - @agentproto/agent@0.2.0
  - @agentproto/manifest@0.2.0
  - @agentproto/mcp-server@0.2.0

## 0.1.0

### Patch Changes

- 44192c9: Add self_inspect MCP tool, extends-chain validation, driver MCP verb, and atomic manifest writes
- Updated dependencies [44192c9]
  - @agentproto/agent@0.1.0
  - @agentproto/manifest@0.1.0
  - @agentproto/mcp-server@0.1.0
