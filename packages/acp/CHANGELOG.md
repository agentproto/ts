# @agentproto/acp

## 0.13.0

### Minor Changes

- 0e0fd10: Adopt the AIP-45 `mode-changed` stream event and typed `agent-prompt` requests (agentproto/agentproto #121).

  `@agentproto/acp`: `StreamEvent` gains the `mode-changed` variant (`modeId`, `previousModeId`, `cause: "caller" | "agent"`, `reason?`) and the `agent-prompt` event gains `request?` (`tool-permission | question | plan-approval`, absent reads as `tool-permission`) with the `question` and `planApproval` payloads (new `AgentPromptRequestKind`, `AgentPromptQuestion`, `AgentPromptPlanApproval` types). The ACP client turns a `current_mode_update` into `mode-changed`: `cause: "caller"` when it echoes the caller's own `setSessionMode`, `"agent"` otherwise, with `previousModeId` from the tracked mode. A `setSessionMode` the agent does not echo is reported once it is applied; when the agent reports another mode during the call, that report stands. No-op updates are not reported.

  `@agentproto/harness`: `capabilities` accepts `mode_events` and `typed_prompts` (booleans, the `HARNESS.schema.json` fields), and re-exports the new acp types.

  `@agentproto/adapter-mastra-controller`: a controller mode switch is a `mode-changed` event instead of the `thought` notice (`cause: "agent"`, `reason: "plan approved"` after an approved plan), and the host's own `setSessionMode` is reported with `cause: "caller"`. Prompts carry `request`, with a `question` payload (choices, or free text on the `answer` option) or a `planApproval` payload (plan text, `planRef`, target mode, approve and reject option ids). Declares `mode_events` and `typed_prompts`. Deprecated: the `_meta` keys `mastra-controller/request`, `mastra-controller/plan` and `mastra-controller/transitionsTo` (and the `META_REQUEST`, `META_PLAN`, `META_TRANSITIONS_TO` exports) are kept for one release as aliases of the typed fields.

  `@agentproto/runtime`: the pending-permission inbox (`GET /permissions`, `permissions_list`) and the session transcript carry `request`, `question` and `planApproval` unchanged; `mode-changed` is recorded in the transcript, relayed from sandbox sessions, exported, and shown as a `[mode]` output line.

  `@agentproto/cli`: `permissions ls` renders a plan from the typed `planApproval` first, falling back to the `_meta` aliases.

- dd134f4: Retry transient model re-assert on resume and enforce profile allowlists
- dd134f4: Retry transient model re-assert on resume and enforce profile allow-lists.

  - `@agentproto/acp`: add optional `AcpClientOptions.modelApplyRetry` to bound the re-assert retry after a connect-time model-apply failure, retrying only transient (429/rate-limit) rejections.
  - `@agentproto/harness`: expose `AgentCliRuntimeSession.modelApplyRejection` so hosts can see a rejected model apply instead of assuming the requested model.
  - `@agentproto/runtime`: fold per-profile model curation into spawn eligibility (ordered `profileRefs` fall through to the next model-eligible profile), share one canonical identity rule between the catalog read path and the spawn/live `set_model` write paths, and stop the descriptor from claiming a rejected/unknown model.

## 0.12.0

### Minor Changes

- d3dd524: Align `SPEC_NAME` with the canonical AIP-70 names registry, add the `defineAuth` alias for `defineAuthProvider`, and point the runtime approval request at the accepted AIP-7.

### Patch Changes

- 5ab8114: Switch the workspace dependents of the deprecated `@agentproto/define-doctype` shim to the canonical `@agentproto/doctype` package. Update dependency keys, import specifiers, tsup externals, and generated scaffolds; keep the shim and changelogs untouched.
- 5ab8114: Switch the workspace dependents of the deprecated `@agentproto/define-doctype` shim to the canonical `@agentproto/doctype` package: dependency keys, import specifiers, tsup externals, the lockfile, and the generated AIP scaffold. The shim itself and per-package changelogs are retained unchanged.
- Updated dependencies [8d8c10c]
- Updated dependencies [c6e0daa]
- Updated dependencies [f18edbc]
- Updated dependencies [c6e0daa]
- Updated dependencies [f18edbc]
  - @agentproto/doctype@0.2.0

## 0.11.3

### Patch Changes

- 305199d: AIP-66 cloud spawn model + error detail.

  The `claude-code-cloud` manifest now declares a free-form string `model` option (applied via `ANTHROPIC_MODEL` env on the relay's claude children — the same channel the local `claude-code` adapter uses), so `agent_start { cloud: "anthropic", adapter: "claude-code-cloud", model: "claude-opus-5-5" }` no longer fails with `[unknown_option at config.options.model] Option 'model' is not declared by manifest 'claude-code-cloud'. Known options: (none)`. Omitting `model` still leaves the vendor's own default in place; no curated `models` menu is added (the vendor bills its own models, AIP-66 §4).

  The ACP client no longer swallows the cause of a refused spawn/turn behind a bare "Internal error": the SDK maps a server-side handler throw to a JSON-RPC `-32603` whose message is just "Internal error" and keeps the real reason only in `error.data.details` (a missing claude.ai credential, an unpushed checkout, a vendor API error, …). `newSession` / `loadSession` / prompt turn errors now surface that detail in the message (carrying the `-32603` code through), so the host shows the actual refusal.

- 305199d: AIP-66 cloud spawn `model` option + richer ACP error detail.

  `claude-code-cloud` now declares a free-form string `model` option, applied via the `ANTHROPIC_MODEL` env var on the relay's claude children (the same channel the local `claude-code` adapter uses), so `agent_start` naming a model no longer fails with `unknown_option`. Omitting it leaves the vendor's own default in place and no curated `models` menu is added (the vendor bills its own models, AIP-66 §4).

  The ACP client now surfaces the cause of a refused spawn/turn hidden behind a bare JSON-RPC `-32603` "Internal error": `newSession` / `loadSession` / prompt-turn errors include the human-readable `error.data.details` in the message while carrying the `-32603` code through, so a host that reads only `error.message` shows the real refusal (missing credential, unpushed checkout, vendor API error) instead of a bare "Internal error".

## 0.11.2

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [74f982c]
- Updated dependencies [74f982c]
  - @agentproto/define-doctype@0.1.4

## 0.11.1

### Patch Changes

- a21b38b: Read opencode's native session modes from the `category:"mode"` config option
  it actually advertises (opencode 1.19 leaves the ACP `modes` field undefined), so
  `availableModes` is no longer empty: canonical postures now resolve to a real
  native mode (`default`→`build`, `plan`→`plan`) and switch live via
  `session/set_mode`, instead of silently degrading to an advisory
  prompt-injection preamble. Also re-assert the requested model/effort/mode on
  `loadSession` (native-resume): a restarted opencode session used to drop the
  requested model and run its own default `opencode/big-pickle` (a per-IP
  rate-limited free id) while agentproto still reported the requested model and
  route. The existing derived-from-model spawn guard now covers resumes too, since
  `loadSession` records `modelApplyRejection`.

## 0.11.0

### Minor Changes

- c1e3dfd: Harness-neutral system-prompt channel for AIP-42 AGENT.md projection. An adapter whose manifest declares `systemPrompt` now receives the projected AGENT.md text through that channel instead of as a first-prompt prefix, and no `session:harness-warning` is raised for it. Three `via` channels: `acp-meta` (claude-code — ACP `_meta.systemPrompt.append` on `session/new` and `session/load`), `inline-config` (opencode `instructions` file path and codex `developer_instructions`, layered into the CLI's inline JSON config env var) and `argv` (pi's `--append-system-prompt`, on every spawn including resume). Every other adapter keeps today's prefix + warning behaviour, and a sandbox spawn still warns — the box owns its own adapter configuration.

## 0.10.0

### Minor Changes

- 3959962: fix(runtime): detect a dead ACP connection instead of reporting it alive — a
  second, independent liveness axis (`adapterConnected`) so a row whose ACP
  transport died is no longer reported as running/Idle forever.

## 0.9.2

### Patch Changes

- 11c1e09: Controller→host-session prompt path + E2E channel flap diagnostics (BOOTSTRAP P4)

  - `runtime`: `device_prompt` MCP tool + `POST /devices/:id/sessions/:sessionId/prompt` —
    write a turn to a session on a registered HOST device (the write counterpart of
    `device_sessions`), forwarded over the host's E2E channel with `agent_prompt`'s
    queueing rules (fire-and-forget default, FIFO behind an in-flight turn,
    `interrupt`/`force`; `wait` blocks until the turn drains). The host side serves
    `POST /device-prompt/:sessionId`, self-proxying onto its own
    `POST /sessions/:id/prompt`, gated by the same two gates as `/device-spawn/*`
    (host-scoped pairing + `features.deviceSpawnAllow` — a plain remote-control
    pairing never gets it). CLI: `agentproto devices prompt <fp|name> --session <id>
--prompt <text> [--wait]`.
  - `runtime`: post-handshake E2E diagnostics in `HostRegistry.connectToHost` —
    each failed attempt logs the host name/fingerprint, attempt number, and the step
    it died at; a host that closes AFTER completing the Noise handshake now fails
    immediately with the remote close reason instead of masking it behind a 10s
    tunnel-hello timeout (the step the observed flaps break at), and the re-pair
    hint now also fires on a hello timeout.
  - `pairing-host`: the daemon's pairing accept-loop no longer swallows handshake
    failures silently — the gated log names the step (`transport closed during
handshake: <reason>` vs a hello timeout), and the channel-closed log carries the
    remote close reason.
  - `acp`: `daemonHandshakeOverSink` takes an optional `log` hook that surfaces the
    remote's POST-REPLY close reason — the exact step the observed E2E flaps break
    at (Noise OK, reply sent, controller hangs up). Wired into the pairing accept
    loop (gated, labelled with the loop key) and the join-token accept loop; the
    reason was previously captured at this layer and discarded.

## 0.9.1

### Patch Changes

- Updated dependencies [461df5e]
  - @agentproto/define-doctype@0.1.3

## 0.9.0

### Minor Changes

- 65777ee: Keep the reported context window sticky: a cost-bearing usage_update's size is authoritative and no longer downgraded by later inferred frames (claude-agent-acp guesses 200k for 1M models until its first result). The daemon seeds the window from the model catalog at spawn, carries the adapter's `_claude/model` and `sizeInferred` on usage_update events, records `reportedSize` when it corrects a size, and treats a trailing `[1m]` lane hint (`claude-opus-5-5[1m]`) as an explicit window choice — not part of model identity for pricing/alias lookups.
- 8c74864: stdio MCP-server entries now carry `args` and `env` end to end: the ACP schema, runtime tool/HTTP parsing, spawn and restart mount builders, the file-based config converter, and the VS Code client type all forward them instead of silently dropping them. The local-browser plugin additionally exports headless per-session browser helpers (`ensureChromeDevtoolsMcp`, `resolveChrome`, `buildHeadlessBrowserMcpEntry`, …) and `installChromeMcp` gains generic `pkg`/`binName` options.
- dc87d79: Track claude-code's background-task wake instead of dropping it
- 7d825ff: Add orphaned-prompt recovery: a `session/prompt` folded into an agent's autonomous cycle (autonomous-origin result frame followed by silence) is cancelled after `orphanedPromptTimeoutMs` (default 60s, `0` disables) and reported `completed` instead of leaving the session busy forever.
- 535779b: Add ACP steering support to the client: `_session/steering` extension detection from `InitializeResponse._meta.steering.supported`, new `initMeta`/`steeringSupported` surfaces, and a non-throwing `AcpClientSession.steer()` gated to host-initiated turns.

  ***

  "@agentproto/driver-agent-cli": minor
  ---

  Expose optional `steer`/`steeringSupported` on `AgentCliClient` and `AgentCliRuntimeSession` (ACP arm passthrough) and export the `SteerOutcome` type.

  ***

  "@agentproto/runtime": minor
  ---

  Add `AgentSessionLike.steer`/`steeringSupported` and a `capabilities.steering` stamp on `SessionDescriptor`, surfaced in `session_list` compact rows.

- 476b1ca: Crypto portability refactor: `@agentproto/secrets` gains a `CryptoProvider` seam (node:crypto / WebCrypto) and a browser-safe `@agentproto/secrets/pairing/browser` entry; all public crypto APIs (`seal`/`unseal`, identity, pairing handshakes, offer URLs, pair-root/epoch-token derivation) are now async and take an optional trailing `crypto` provider — a breaking change. `@agentproto/acp` gains an `E2eAead` seam, a browser-safe `@agentproto/acp/tunnel/browser` entry, `holdFrames`, and async-derivation callbacks in the handshake-over-sink helpers, with the Node entry keeping its `Buffer`-typed `decodeData`. `@agentproto/cli` and `@agentproto/runtime` adapt call sites to the async APIs.
- 5f0f9d1: Add web-fragment pair offers, browser pair-client tunnel, and pairing revocation signalling

## 0.8.2

### Patch Changes

- c27f0b8: Weekly minor/patch dependency bumps across workspaces (zod, @mastra/*, react, yaml, claude-agent-sdk, etc.).

## 0.8.1

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [2f37e7b]
  - @agentproto/define-doctype@0.1.2

## 0.8.0

### Minor Changes

- 0012980: feat(permissions): thread plan \_meta through the hold path and add free-text feedback on the respond path

  Adds `feedback?: string` to permission resolutions, enabling users to attach contextual information when approving or denying held tool-permission requests. The feature threads through all layers: types export `ACP_META_FEEDBACK` constant for the `_meta` key convention, ACP client carries `_meta` through to agent-prompt events, runtime forwards feedback on outcomes, and mastra-agent adapter folds feedback into suspension resumeData. CLI gains `--feedback` flag on approve/deny commands and renders plan text from suspension payloads. All changes are backward compatible.

### Patch Changes

- @agentproto/define-doctype@0.1.1

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
