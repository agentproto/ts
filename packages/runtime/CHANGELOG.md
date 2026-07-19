# @agentproto/runtime

## 1.1.0

### Minor Changes

- ed0c269: Add terminal input endpoint and UI toggle for conversation/terminal view switching.
  - HTTP endpoint `POST /sessions/:id/terminal/input` for writing raw input to PTY sessions (FIX 2)
  - DaemonClient method `writeTerminalInput` for terminal input requests
  - VSCode UI: Conversation⇄Terminal segmented toggle for sessions with both representations
  - Routing: Terminal sessions now use `writeTerminalInput` instead of `prompt` endpoint
  - View toggle logic for agent-cli and native-conversation PTY sessions

- 4632ec7: Session management feature set: terminal input routing via POST /sessions/:id/terminal/input, session renaming via PATCH /sessions/:id and session_rename MCP tool, explicit --title flag for spawn, and structured↔terminal view toggle for dual-representation sessions. Includes code-point-aware name truncation, field-independent rename operations, and comprehensive test coverage.

### Patch Changes

- ee4ab3f: Fix linked git worktree session workspace resolution: sessions spawned in linked worktrees now group under their base repo's registered workspace instead of falling back to "default". Also adds symlink-aware path comparison to handle macOS `/tmp` → `/private/tmp` aliases.
- a4239ff: Repair two `WorkspaceEntry` test literals that predated the AIP-34
  `addedAt`/`updatedAt` fields becoming required, restoring `check-types` green.
- Updated dependencies [3edb7a7]
- Updated dependencies [a0b94fd]
- Updated dependencies [cc00682]
  - @agentproto/workflow-loader@0.1.1
  - @agentproto/auth@0.2.0
  - @agentproto/driver-agent-cli@2.0.1
  - @agentproto/secrets@0.2.1
  - @agentproto/acp@0.6.0
  - @agentproto/sandbox@0.1.5

## 1.0.0

### Major Changes

- 8e99f17: Fix session-bucket clobber on registry-read failure or skewed reload; readRegisteredSlugs now returns {slugs, ok}

### Minor Changes

- cc84da6: Fix claude-code project-slug encoding and add persisted conversation index + `conversation locate` verb
- 40cd699: Add archivable terminal sessions: session_archive/session_unarchive MCP tools + list({includeArchived})
- b16bb83: Add SessionConfig axes type + decomposeMode/composeMode shim (SPEC §3.1)
- b331539: Add read-only GET /catalog/models + catalog_models MCP tool (SPEC §5)
- 40036de: Add canonical-posture layer (native mode resolution + prompt-injection fallback)
- 7441a7d: Add descriptor config-axis echo fields (effort/posture/route/contextProfile/accessProfile) + AuthMethod export
- 57d1499: Route sandboxed agent-step spawns through spawnAgentSession; e2b installPackages boot option
- d4d515e: Add axis-generic session:config-changed event, emitted from setModel alongside session:model-changed
- 48c55d5: Add live effort + live posture verbs and a model↔route switch guard
- 39ace5f: Add restart-with-override: axis overrides on session_restart + POST /sessions/:id/restart

### Patch Changes

- 1411e36: Don't engage native Anthropic billing-auth when a gateway base_url is set without an auth_token
- 6453ff6: Persist session_restart's resumedFrom/resumeVia on the stored descriptor
- 336c49c: Expose real agent-step ids/session ids in file-based workflow runs and fail a step on an empty (no-op) turn
- 92c1c51: Narrow AgentCliMode.kind to "context"; drop posture/route modes from claude-code, codex, opencode
- c3bfaea: Fix catalog_models 500 on router-prefixed OpenRouter model ids
- 3d403d7: Fix e2b sandbox timeout issues and add poll resilience.

  Root cause: e2b's per-command timeout defaults to 60s (even for `background: true` commands), killing the daemon mid-turn; sandbox lifetime defaults to 5min, reaped during long turns. Native reviewer failed on every PR, triggering fallback double-reviews.

  Changes:
  - **harness**: Increase MCP request timeout to long-poll window + 60s grace (client was aborting at 60s while server held 49s windows, leaving ~11s headroom)
  - **runtime**: Add poll resilience — retries transient failures up to 6x; make output pulls best-effort (offset-diff safe)
  - **sandbox-e2b**: Set `timeoutMs: 0` on serve command (disables per-command timeout); default sandbox lifetime to 45min (overridable); re-arm timeout on reconnect
  - **ci**: Add postcheck gate (prevent duplicate reviews when native lane posts then errors post-post); add verify gate (confirm review row exists on GitHub API); integrate Langfuse tracing (soft-fail when creds absent)

- Updated dependencies [9e30ad2]
- Updated dependencies [5c99163]
- Updated dependencies [1411e36]
- Updated dependencies [b16bb83]
- Updated dependencies [a021138]
- Updated dependencies [9fab1ad]
- Updated dependencies [92c1c51]
- Updated dependencies [57d1499]
- Updated dependencies [48c55d5]
- Updated dependencies [e3bacf3]
  - @agentproto/model-catalog@0.6.0
  - @agentproto/provider-presets@0.4.1
  - @agentproto/driver-agent-cli@2.0.0
  - @agentproto/acp@0.6.0
  - @agentproto/workflow-runtime@0.5.0
  - @agentproto/mcp-server@0.2.3
  - @agentproto/providers-store@0.3.1
  - @agentproto/sandbox@0.1.4
  - @agentproto/eval-reporters@0.2.3
  - @agentproto/telemetry-langfuse@0.2.2

## 0.8.0

### Minor Changes

- a4d091d: Add policy-driven git-worktree isolation on agent_start
- 2f8ba2d: Stop misdirecting zero-credential agent-cli users to buy a subscription

### Patch Changes

- f392877: Sync docs with latest release features (interrupt, conversation_read, WORKTREE column, llm:context-windows, duration flags)
- 9c2cec0: Add Requesty gateway preset and fix openrouter's double-/v1 base URL bug
- Updated dependencies [719771e]
- Updated dependencies [9c2cec0]
- Updated dependencies [9c2cec0]
- Updated dependencies [2f8ba2d]
  - @agentproto/model-catalog@0.5.0
  - @agentproto/providers-store@0.3.0
  - @agentproto/provider-presets@0.4.0
  - @agentproto/provider-kit@0.3.0
  - @agentproto/sandbox@0.1.3
  - @agentproto/eval-reporters@0.2.2

## 0.7.0

### Minor Changes

- 0d74b1e: Add SessionDescriptor.title derived from first prompt text
- 8aec010: Add ConversationStore abstraction, hermes attach support, and conversation_read MCP verb
- e5d55a7: Record worktreePath and worktreeId on SessionDescriptor at spawn time
- 8778b9d: Add optional sessionId filter to policy_list, GET /policies, and policy ls
- 98bbebf: Partition session state per workspace (AIP-46 §State partitioning)
- bbc5070: Add interruptSession registry method, POST /sessions/:id/interrupt route, and agent_interrupt MCP verb

### Patch Changes

- 7b80d00: Add last-known-good fallback so a rebuilding adapter isn't reported as uninstalled
- a571bf9: Fix flaky command-log tests by polling instead of a fixed 20ms sleep
- 45ee7ef: Stop test gateways persisting fake session rows into the real ~/.agentproto/
- 5d2b869: Redact client slug from fixtures and drop machine-specific comment framing
- e0b4b85: Widen interrupt-settle timeout to 60s to avoid false timeouts on slow adapters
- Updated dependencies [b531fd1]
  - @agentproto/model-catalog@0.4.0
  - @agentproto/providers-store@0.2.1
  - @agentproto/sandbox@0.1.2

## 0.6.0

### Minor Changes

- 1bdc055: Add xAI provider support and session options passthrough (base-url/auth-token/options-json)
- ed52691: Surface empty (zero-output, zero-tool) turns with empty:true on session:turn-end
- 7b6c8d0: Add daemon.authToken config field and --auth-token flag for persistent gateway bearer token
- 049c2fe: Add generic ACP agent support: curated catalog, config-defined agents, acp verb
- 0ea6fc1: Add cross-session permission-hold inbox: permissions ls|approve|deny, MCP tools, REST routes
- 386a573: Add deterministic auth spawn mode (subscription vs api-key) for claude-code
- c036f59: Explicit credential selection + verifiable auth mode for claude-code spawns
- 60792f1: Add E2E daemon pairing: rendezvous broker, pair CLI, daemon registry
- d425044: Add catalog-sourced billing-credential resolver for all adapters
- 6894d2e: Add named terminal presets via terminalPresets in config.json
- 6aafd13: Auto-detect workspace from cwd when no workspaceSlug is provided
- 3639abd: Default pair offer to the hosted rendezvous broker when nothing is configured
- ed241b8: Add GET /sessions/:id/events/stream SSE endpoint with exactly-once replay→live handoff
- a63b4bc: Add worktree new verb, worktrees.root config, and provision provenance marker
- eec7b5d: Add opt-in idempotencyKey to agent_start for retry-safe process spawning
- ea44602: Add sessions story subcommand and expose runtime/session-story subpath export

### Patch Changes

- 410271d: Accept `id` alias on drive tools; coalesce session_monitor arg shapes
- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- 8a4d5d5: Add opt-in E2E encryption for the serve --connect tunnel (tunnel-e2e/v1)
- af7ab1f: Fix transcript-writer seq collision after daemon restart; add structured VS Code conversation rendering
- 031735e: Fix workspaceSlug derivation from cwd on terminal and raw spawn paths
- 33f5fa4: Fix sendPrompt silently dropping interrupt on the blocking prompt arm
- 769f75f: Re-resolve billing auth on session_restart to prevent silent credential fallback
- d85e129: Clear frozen in-flight flags on already-terminal ghosts at snapshot load
- 475249b: Clear frozen in-flight flags on forced session termination (daemon-restart path)
- 8e7353a: Extract providers-store into a leaf package; fix llm-endpoint boot to inject stored provider keys
- 40fb9e8: Reject out-of-window contextUsed values instead of surfacing impossible occupancy figures
- a32bb69: Bump test timeouts on subprocess/IO-heavy tests that flake under parallel load
- 1549bdd: Close read-path gap for stale out-of-window contextUsed (#364 follow-up)
- ff4617c: Fix blockedOn latching when a tool fails (error event now releases it)
- c8198c6: Fix dropped tool-call arguments from non-terminal ACP tool_call_update frames
- Updated dependencies [1b282ab]
- Updated dependencies [1bdc055]
- Updated dependencies [afbf5c4]
- Updated dependencies [7b53b8c]
- Updated dependencies [0ea6fc1]
- Updated dependencies [6d4aa4b]
- Updated dependencies [60792f1]
- Updated dependencies [8a4d5d5]
- Updated dependencies [d425044]
- Updated dependencies [c430b9f]
- Updated dependencies [d924e95]
- Updated dependencies [94a7e90]
- Updated dependencies [3639abd]
- Updated dependencies [8e7353a]
- Updated dependencies [a32bb69]
- Updated dependencies [e0fbccc]
- Updated dependencies [c8198c6]
  - @agentproto/provider-presets@0.3.0
  - @agentproto/model-catalog@0.3.0
  - @agentproto/acp@0.5.0
  - @agentproto/agent@0.2.1
  - @agentproto/eval-reporters@0.2.1
  - @agentproto/manifest@0.2.1
  - @agentproto/mcp-server@0.2.2
  - @agentproto/provider-kit@0.2.1
  - @agentproto/redaction@0.2.1
  - @agentproto/sandbox@0.1.1
  - @agentproto/secrets@0.2.0
  - @agentproto/telemetry-langfuse@0.2.1
  - @agentproto/workflow-loader@0.1.0
  - @agentproto/workflow-runtime@0.4.0
  - @agentproto/workflow@0.1.0
  - @agentproto/providers-store@0.2.0

## 0.5.0

### Minor Changes

- 6b8b023: Add bin_args_prepend, plumb options map, and declare lean modes on agent-CLI adapters
- 99a5c60: Add agentproto_session_story MCP app — per-session story panel with buildStory heuristic
- 80ca385: Add per-session usage observability: cost + tokens, live via MCP + durable
- 7142f1c: Add per-mode support status (active|noop|planned) to AIP-45 agent-CLI manifest
- 7f1584d: surface blockedOn (subagent|command) on SessionDescriptor
- af10521: add display-mode toggle (fullscreen/pip) to all ui:// panel bridges
- 517fe8c: Add agentproto_terminal MCP App: live PTY over WebSocket with CSP connectDomains
- e231d80: Add spawn-time role profiles (executor/supervisor) with hard delegation-tool gate
- 7ba7e06: expose eval-reporter MCP tools on the daemon gateway
- ec70cda: Add interrupt flag to agent_prompt for soft Ctrl-C mid-turn redirect
- 4b93900: Add role registry, privilege-lattice spawn gate, and role_list MCP tool
- e73dae1: Add enter and b64 options to terminal_input for reliable TUI key submission
- a7ccd54: Add langfuseSessionTracer and extract shared createIngestionClient with atomic-drain flush
- 2d23f82: Add filterSessionObserver and opt-in Langfuse tracing per session
- 1813814: Add command_execute JSONL audit log and command_log_tail MCP tool
- b3921a9: Add WorkflowRunner.startFromFile and workflow_run_file MCP tool
- fdb8ea1: Add credentialRef + headers to AcpMcpServer for brokered child-MCP auth at spawn time
- 1c69f14: Add sandbox provider family: list_sandbox_providers + setup_sandbox_provider MCP tools
- e029a35: Wire agent_start.sandbox: boot box + proxy session via SandboxAgentSessionProxy
- afe2541: Add daemon_health MCP tool for cheap in-process liveness probing
- 553597a: Add sandbox reconnect/reuse and AIP-36 lifecycle pause support
- a28bebc: Add provider-presets catalog listing and AIP-45 presets manifest field
- b588e36: Add a `defaults` block to `~/.agentproto/config.json` — global and per-adapter `skills`/`options` auto-applied to every `agent_start` spawn. A normalized `skills: string[]` is folded into the resolved adapter's native option shape (e.g. hermes' comma-joined `--skills a,b`); adapters with no declared `skills` option are a no-op.

### Patch Changes

- ba74049: Guarantee a terminal turn-end for every agent turn (exited/error/aborted)
- 6c83622: Emit usage_update transcript events for hermes and mastracode adapters
- c4873a2: fix MCP Apps panels: forward resources/\* through mcp-bridge + spec-correct ui/initialize handshake
- 94740f9: Fix session-story panel rendering Markdown as literal text instead of HTML
- 2532d33: Scrub ambient Anthropic key under gateway base_url; provider-driven bearer auth
- e2388e8: fix(tunnel): redirect cloudflared stdio to file to prevent pipe back-pressure wedge
- 665903e: keep agent_output visible during tool-busy turns; never drop tool errors
- 863d6d9: fix(runtime): stop provider default credentialsFile shadowing named tunnel creds
- 48f658c: Extract SessionObserver seam for pluggable per-session transcript taps
- e5389c9: Trust cli.agentproto.sh origin so the panel PTY terminal connects
- 7bb147c: Forward trace flag through POST /sessions/agent HTTP route
- 973b553: terminal_input: send enter CR as isolated write for paste-safe submit
- bd4d7a0: Add value-scan redactor and secrets slug; bump runtime default tracer to secrets
- b77a552: Rename adapter-kit → provider-kit; add adapter-kit@0.2.0 compatibility shim
- 13991da: Harden role dispositions to explicitly prohibit native CLI subagent/Task-tool delegation
- 5747d5f: Trim session-story execute() payload when sessionId is known; add full-panel deep-link
- b1ce54c: De-flake command-log test by returning the write promise instead of a fixed delay
- fad8300: Fix claude-sdk idle watchdog false-abort and frozen ring on long thinking turns
- 16c85e7: Fix cron prompt-session resilience: skip if busy, auto-resume if dead, fix daemon shutdown hang
- 2d6aead: Fix session_restart resuming wrong conversation via fs-probe sibling leak
- 6cc9e25: Dedupe sandbox capability constant, drop redundant author guard + unused token-env export
- 6bbd6cd: Sessions panel: turn-aware status badge for agent-cli sessions. A running agent-cli process now shows `working` (turn in flight), `waiting` (awaiting input), or `idle` (process alive, no turn running) instead of a flat `running`, reading the `busy`/`awaitingInput` descriptor fields.
- Updated dependencies [f8ebe41]
- Updated dependencies [80ca385]
- Updated dependencies [6a5c41c]
- Updated dependencies [7aaf24a]
- Updated dependencies [126f7c6]
- Updated dependencies [aa70df9]
- Updated dependencies [310de1a]
- Updated dependencies [d9726d3]
- Updated dependencies [5b9b5ec]
- Updated dependencies [a7ccd54]
- Updated dependencies [bd4d7a0]
- Updated dependencies [b77a552]
- Updated dependencies [6a0d8fe]
- Updated dependencies [2154ed5]
- Updated dependencies [fdb8ea1]
- Updated dependencies [b65ca15]
- Updated dependencies [e029a35]
- Updated dependencies [553597a]
- Updated dependencies [abb49cf]
- Updated dependencies [34cfcb5]
- Updated dependencies [2adc163]
  - @agentproto/workflow-runtime@0.3.0
  - @agentproto/acp@0.4.0
  - @agentproto/sandbox@0.1.0
  - @agentproto/telemetry-langfuse@0.2.0
  - @agentproto/eval-reporters@0.2.0
  - @agentproto/redaction@0.2.0
  - @agentproto/provider-kit@0.2.0
  - @agentproto/provider-presets@0.2.0

## 0.4.0

### Minor Changes

- 8d1191e: Rename all MCP tool verbs to family-first taxonomy (agent*\*, session*\_, terminal\__, command*\*, file*_, directory\__, browser*\*, policy*_, routine\_\_, tunnel\_\*), split agent tools into a dedicated `agent-tools.ts` module, and fix harness call-sites.
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
