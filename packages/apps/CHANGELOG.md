# @agentproto/apps

## 0.13.0

### Minor Changes

- 4e398a9: Unify the display-mode toggle into `@agentproto/app-client/display-mode`: the panel bridge and the `window.McpApp` bridges now share one installer with host-aware placement (`safeAreaInsets`), theme support, an `optimistic` mode, and `mountToggle` for inline placement. Runtime exports `injectMcpAppBridge` / `MCP_APP_BRIDGE_SCRIPT`; the bridges expose `getHostContext` / `onHostContext` / `displayMode`.
- 54983df: Allowlist session_restart on the builtin session-chat panel
- 48da1d4: Add repo-maintenance app (maintain workflow + reviewer agent) and agentproto maintain CLI shortcut
- ea5e30d: Add typed SessionMessage envelope + session-message transcript record for inter-session reports

### Patch Changes

- 65777ee: Keep the reported context window sticky: a cost-bearing usage_update's size is authoritative and no longer downgraded by later inferred frames (claude-agent-acp guesses 200k for 1M models until its first result). The daemon seeds the window from the model catalog at spawn, carries the adapter's `_claude/model` and `sizeInferred` on usage_update events, records `reportedSize` when it corrects a size, and treats a trailing `[1m]` lane hint (`claude-opus-5-5[1m]`) as an explicit window choice — not part of model identity for pricing/alias lookups.
- 5a466d6: Mount daemon /mcp gateway on workflow agent steps; fix prompt sections, map scheduling, run output persistence, maintain --wait
- 5f923bb: Durable inter-session messaging inbox (AIP-46 §Session messages): new `message_send`, `message_reply`, `inbox_list`, `inbox_ack`, `inbox_wait` tools, `POST /sessions/:id/messages` / `GET /sessions/:id/inbox` / `POST /sessions/:id/inbox/ack` HTTP routes, `sessions inbox` / `sessions message` CLI commands, and a re-routed `message_parent` through `registry.sendMessage`.
- bdb5830: repo-maintenance: missing-verdict retry ladder (same-session nudge + large-model retry) via the new read-only `branch_gc_verdict_get` tool (`BranchGcVerdictReader` port); fixed the maintain report's worktree classification counts; `tool_search` option for the claude-code adapter, auto-disabled for allowlisted agent steps; `{{index}}` support in agent-step `sessionRef` for fan-out session reuse; step session descriptors now echo the pinned model/effort.
- Updated dependencies [4e398a9]
- Updated dependencies [cd00daa]
- Updated dependencies [d6d86b6]
- Updated dependencies [6c68009]
- Updated dependencies [9a5d311]
  - @agentproto/app-client@0.4.0
  - @agentproto/app-kit@1.3.0
  - @agentproto/workflow@0.7.0

## 0.12.0

### Minor Changes

- a169e72: Add launcher card fallback when host CSP blocks the session-chat iframe
- ec66e92: Ship a live, boot-stable embed token with each session-chat tool result so host-cached widgets re-arm after a daemon restart: new exported `stableAppEmbedToken()` in runtime, and new optional `SessionChatOutput.embedToken` / `SessionChatOps.mintEmbedToken` in apps.

### Patch Changes

- f84c972: Shim history.replaceState/pushState to survive cross-origin blob base href
- f6f2d75: Mint per-boot embed tokens so MCP-Apps widgets render in opaque hosts
- f6f2d75: MCP-Apps hosts with opaque widget origins (e.g. Claude Desktop) can now mount an app's `/ui` page: a per-boot embed token is baked into panel bridge scripts at registration and accepted (alongside `vscode-webview:` and `csp.frameDomains`) as a trusted-embedder proof by `handleAppUiPage`/`applyCors`, layered under the existing bearer-auth and `sec-fetch-dest: iframe` gates.
- a373209: Bind agent_start to session-chat widget via self-bootstrapping bridge
- 54e8f28: Regen work-board panel bundle after panel-bridge changes
- 4b31967: Hide session-chat launcher bar once the frame mounts

## 0.11.0

### Minor Changes

- 7941fc7: Rebuild the work-board panel as a single-file Vite app (committed generated artifact with a CI drift check) and add a standalone tool-call fallback to the shared panel bridge (`POST ./tool-call` when no host iframe is present), plus agentproto branding for the work-board UI.

### Patch Changes

- 13858b8: Fix builtin panels served standalone (`GET /apps/:appId/ui`) hanging on "Connecting to bridge…": `panelBridgeScript` now detects the standalone shape (`window.parent === window` plus a working `window.McpApp.connect`), short-circuits `initBridge()` with a default inline hostContext, and routes `callTool` through the injected standalone app bridge. The postMessage-host path is unchanged. Adds static script assertions in `@agentproto/apps` and real-jsdom coverage in `agentproto-vscode`.
- 7473ccd: Regenerate the stale work-board `panel.generated.ts` bundle so the committed artifact matches the post-#1303 panel-bridge sources (standalone connect behavior, display-mode/pin toggles). Also hardens the auto-merge workflow to skip arming while a PR is behind its base, closing the stale-merge race from #1302/#1303.
- c27f0b8: Weekly minor/patch dependency bumps across workspaces (zod, @mastra/*, react, yaml, claude-agent-sdk, etc.).
- Updated dependencies [c27f0b8]
  - @agentproto/agent@0.2.4
  - @agentproto/app-kit@1.2.1
  - @agentproto/workflow@0.6.1

## 0.10.0

### Minor Changes

- 264c4c7: Add a builtin `session-chat` panel: a thin launcher widget that deep-links/frames the installed `@agentik/session-chat` app's standalone UI (install notice when not installed), plus a new `csp.frameDomains` field on `AgnoMcpApp`.

  ***

  "@agentproto/runtime": minor
  ---

  Mount the `agentproto_session_chat` builtin panel and add an `?embed=1` trusted-embedder opt-out for the standalone app-UI host's anti-framing headers.

- 2125685: Add work-board builtin kanban panel over the Task ledger

### Patch Changes

- Updated dependencies [264c4c7]
- Updated dependencies [79991e7]
  - @agentproto/app-kit@1.2.0

## 0.9.3

### Patch Changes

- Updated dependencies [c809f12]
  - @agentproto/workflow@0.6.0
  - @agentproto/app-kit@1.1.1

## 0.9.2

### Patch Changes

- 81752fa: Update upstream dependencies for improved compatibility and stability: @anthropic-ai/claude-agent-sdk (0.3.263), @mastra/core (1.64.0), @mastra/memory (1.28.2), @types/react-dom (19.2.7), and @tauri-apps/plugin-opener (2.5.5).
- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [66f73d9]
- Updated dependencies [81752fa]
- Updated dependencies [2f37e7b]
  - @agentproto/app-kit@1.1.0
  - @agentproto/workflow@0.5.0
  - @agentproto/agent@0.2.3

## 0.9.1

### Patch Changes

- Updated dependencies [c4bff00]
- Updated dependencies [f9e21fd]
- Updated dependencies [c4ebbd3]
- Updated dependencies [4d01e5c]
- Updated dependencies [d66ffe3]
- Updated dependencies [a48dc03]
- Updated dependencies [ece3cae]
  - @agentproto/workflow@0.4.0
  - @agentproto/app-kit@1.0.0
  - @agentproto/agent@0.2.2

## 0.9.0

### Minor Changes

- e655351: Support UI-only apps in app-kit; move builtin daemon panels into @agentproto/apps

### Patch Changes

- 11b5564: Add forward-only branch step compilation and subworkflow input projection support to the workflow runtime compiler, plus validation of step references at compile time.
- Updated dependencies [8215419]
- Updated dependencies [e655351]
  - @agentproto/app-kit@0.8.0

## 0.8.2

### Patch Changes

- Updated dependencies [f0c51a7]
  - @agentproto/agent@0.2.2
  - @agentproto/workflow@0.3.1
  - @agentproto/app-kit@0.7.1

## 0.8.1

### Patch Changes

- 4ac9d37: Documentation sync: Update MCP tool naming conventions (resource_action pattern), version bumps (0.12.0 → 0.14.0), and add docs for new features (daemon status build identity, pack build subcommand, workspace-brain transcript chunking, ops-panel app).
- e2314b3: Weekly dependency update: minor/patch-range bumps across the workspace.
  - @mastra/core 1.57.0 → 1.59.0
  - @mastra/memory 1.26.0 → 1.26.2
  - @mastra/libsql 1.19.0 → 1.20.0
  - turbo 2.10.9 → 2.10.10
  - unpdf 1.8.0 → 1.8.1
  - e2b 2.38.2 → 2.39.0
  - @anthropic-ai/claude-agent-sdk 0.3.226/0.3.232 → 0.3.233
  - @earendil-works/pi-tui 0.84.1 → 0.84.2
  - mastracode 0.32.6 → 0.33.1

- b95e23b: Weekly dependency update: bump external dependencies to latest minor/patch versions.
  - @anthropic-ai/claude-agent-sdk 0.3.233 → 0.3.241
  - @ast-grep/napi 0.45.1 → 0.45.2
  - @mastra/core 1.59.0 → 1.61.0
  - @mastra/libsql 1.20.0 → 1.21.1
  - @mastra/memory 1.26.2 → 1.27.0
  - @tanstack/react-query 5.66.0 → 5.102.2
  - @types/react-dom 19.2.4 → 19.2.5
  - @types/vscode 1.90.0 → 1.134.0
  - e2b 2.39.0 → 2.45.0
  - mastracode 0.33.1 → 0.35.0
  - turbo 2.10.10 → 2.10.11

  No code changes; pnpm-lock.yaml updated to reflect new dependency versions.

- Updated dependencies [0097d36]
- Updated dependencies [e2314b3]
- Updated dependencies [b95e23b]
- Updated dependencies [b1a8b7e]
  - @agentproto/app-kit@0.7.0
  - @agentproto/workflow@0.3.0

## 0.8.0

### Minor Changes

- 1bd4dbd: Add ops-panel app — daemon operations cockpit bundling Session Watchdog (cron-ticked health checks, observe-only) and Sessions Manager (durable coordinator) agents with comprehensive UI panel for session lifecycle management, housekeeping, and cron administration.

## 0.7.0

### Minor Changes

- 85c391c: Add `session-viewer` app — a read-only conversation viewer for daemon sessions with a live-polling UI panel and plain-English narrator agent.

### Patch Changes

- Updated dependencies [e418ec7]
  - @agentproto/app-kit@0.6.1

## 0.6.0

### Minor Changes

- 172368f: Add support for multiple MCP server aliases in mail-triage app: `MAIL_TRIAGE_MCP_ALIASES` (overridable via env var, defaults to `["agentpush-prod", "agentpush"]`) enables flexible server selection at emit-time. UI now probes all candidate aliases at startup and auto-selects the first responding server, with a selector dropdown when multiple respond. Enhance plan builder with query input and action selector (mark read, archive, label, trash). Add "Past runs" section using new `app_list` tool to display agent run history with status and session counts. Export `MAIL_TRIAGE_MCP_ALIASES` constant for testing and configuration. Improve agent instructions to explain `mailbox_list` discovery step and new parameter contracts (mailbox ID, criteria, action schema).
- 2375019: Extend the MCP app bridge wire (spec 2026-01-26) with three new methods and integrate them into the mail-triage UI:
  - **`updateModelContext`** (`@agentproto/runtime`): lets an app push updated context back to the model over the bridge; marshaled through JSON-RPC on the postMessage bridge, rejected with a clear error on the standalone bridge.
  - **`openLink`** (`@agentproto/runtime`): lets an app request the host open a URL; the postMessage bridge marshals the request through JSON-RPC, the standalone bridge falls back to `window.open`.
  - **`onTeardown`** (`@agentproto/runtime`): registers a callback invoked when the host sends `ui/resource-teardown`; the bridge replies with `{result:{}}` after running registered callbacks synchronously.
  - **Mail-triage UI** (`@agentproto/apps`): adds email selection via checkboxes, a "send selection" action that pushes selected emails to the model via `updateModelContext`, and "open in Gmail" links wired through `openLink`.

### Patch Changes

- 59bc722: Three fixes around MCP app panels and session restart:
  - **MCP bridge injection** (`@agentproto/runtime`, `@agentproto/apps`): fix the idempotency check that incorrectly skipped injection for documents consuming `window.McpApp.connect()` — regex narrowed from `/window\.McpApp\b/` (any mention) to `/window\.McpApp\s*=/` (assignments only). Defensive guard in mail-triage UI when the bridge is missing.
  - **Credential re-resolution on restart** (`@agentproto/runtime`): pass `accessProfileRef` to `resolveResumeAuth` so restarting a session that used a named auth profile re-reads the current credential from the keychain instead of falling back to a stale mode-based path.
  - **Restart loading state** (`agentproto-vscode`): show a loading state and disable the restart button while a session restart is in flight; new `restartFailed` webview message resets the state on error.

- Updated dependencies [33e97d3]
- Updated dependencies [d22fec5]
- Updated dependencies [3d54f15]
  - @agentproto/app-kit@0.6.0

## 0.5.1

### Patch Changes

- 69e97d9: Documentation sync: version bumps, turn-liveness watchdog config details, UI surfaces/artifacts/dev-launch config examples, and agentproto-apps-sync binary documentation.
- Updated dependencies [69e97d9]
  - @agentproto/app-kit@0.5.1

## 0.5.0

### Minor Changes

- 1d3cbc2: Add stable id/name/version identity to bundled apps; fix app-registry persistence
- 4c91a47: Add UI panels for mail-triage and media-viewer apps with self-contained HTML dashboards using the McpApp bridge protocol. Introduce `agentproto-apps-sync` CLI utility to emit bundled apps to disk with catalog generation.

### Patch Changes

- b7171eb: Documentation update: add media-viewer app to package README
- Updated dependencies [4b73e28]
- Updated dependencies [b098b52]
  - @agentproto/app-kit@0.5.0

## 0.4.0

### Minor Changes

- 727ba11: Add media-viewer agentproto app for media file cataloging with cataloger agent and scan-media workflow.

## 0.3.0

### Minor Changes

- ea4313a: Add `mail-triage` app: a single-agent example that scans the inbox, categorizes unread mail, and applies triage actions (label, archive) via app-kit.

### Patch Changes

- 087f0ea: Declarative agent steps for AIP-15 workflows (WP-B4): author `kind:"agent"` steps with `agent.ref` (app-scoped agent ids) that resolve at compile time to concrete adapters + spawn options. Includes app installation/lifecycle tools (`app_install`, `app_run`, `app_list`, `app_status`, `app_stop`) for managing installed-app state and running agents as live sessions. Tool-id validation now shifts from STEP-DISPATCH time to INSTALL time, listing all missing ids upfront instead of failing one-at-a-time.
- Updated dependencies [47ca357]
- Updated dependencies [087f0ea]
- Updated dependencies [2b379e9]
  - @agentproto/app-kit@0.4.0
  - @agentproto/workflow@0.2.0

## 0.2.2

### Patch Changes

- c1399f3: Weekly dependency update: bump @modelcontextprotocol/sdk, @mastra/core and ecosystem packages, turbo, tsx, and React types to latest patch/minor versions within semver constraints.
- Updated dependencies [c1399f3]
  - @agentproto/app-kit@0.3.2

## 0.2.1

### Patch Changes

- 04aedad: Weekly dependency bump with semver-safe minor/patch updates across 18 packages. Includes Mastra ecosystem update (1.31-1.48.x → 1.52.1), Claude SDK patch (0.3.200 → 0.3.220), build tool updates (turbo, tsx), and general dependency maintenance (yaml, ws, react, etc.). All changes verified to pass build, test, and type checks.
- Updated dependencies [23fa73e]
- Updated dependencies [04aedad]
  - @agentproto/workflow@0.1.1
  - @agentproto/app-kit@0.3.1

## 0.2.0

### Minor Changes

- b2debf0: Add illustrator agent and produce-cover workflow to the content-team app: a new team member that art-directs cover illustrations for articles with visual discipline (flat shapes, limited palettes, strong negative space, text-free prompts).

### Patch Changes

- 4252c81: Fix subpath export types pointing at nonexistent flat .d.ts files
- Updated dependencies [a0b94fd]
  - @agentproto/app-kit@0.3.0

## 0.1.1

### Patch Changes

- c850b1b: Infer anthropic for bare claude model ids; grant team agents their workspace tools
- e3bacf3: Add app-kit pick()/only, fix content-team tools, self_inspect discovers app-emitted agents
- Updated dependencies [e3bacf3]
  - @agentproto/app-kit@0.2.0
