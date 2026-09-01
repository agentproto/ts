# agentproto-vscode

## 0.12.1

### Patch Changes

- Updated dependencies [47653e3]
  - @agentproto/runtime@2.10.1

## 0.12.0

### Minor Changes

- eeb0209: Add slash-command popup UI for browsing and quickly inserting available harness commands. Users can type `/` at the start of the composer to filter commands by name with keyboard navigation (arrow keys, enter/tab to choose, escape to close). Includes a new optional `availableCommands` field in `SessionDescriptor` mirroring `@agentproto/runtime`, aligned with ACP's `available_commands_update` standard.

### Patch Changes

- Updated dependencies [7a96351]
- Updated dependencies [77ca7ff]
- Updated dependencies [4fa1a02]
- Updated dependencies [f5b462a]
- Updated dependencies [f0c51a7]
- Updated dependencies [d663b35]
- Updated dependencies [12bb9e8]
- Updated dependencies [728205b]
  - @agentproto/runtime@2.10.0

## 0.11.0

### Minor Changes

- b4e0806: Add release indicator status bar showing when a newer @agentproto/cli is available on npm, with configurable poll interval and offline-safe cache fallback.
- 34bbf65: Extract release-check logic from VS Code into `@agentproto/runtime` for code sharing with the CLI. Add `daemon status` release indicator and VS Code update-prompt command with tarball/workspace-specific behaviors.
- f90a383: Add queue management commands and MCP tools for prompt FIFO inspection and control.

  Introduces `agentproto sessions queue <id>` CLI command with flags `--force`, `--deliver`, `--drop` to inspect and manipulate queued prompts after enqueue. Adds four new MCP tools (`session_queue_list`, `session_queue_promote`, `session_queue_deliver`, `session_queue_drop`) with the same semantics. HTTP routes mirror the MCP surface.

  New public exports: `previewPrompt()`, `promptOriginLabel()`, `QueuedPromptView` interface from @agentproto/runtime for after-the-fact queue UI. Origin tracking distinguishes user-initiated queuing from agent/child-sourced prompts. Queue badge ("N queued") shown in CLI and VS Code session listings.

  All three operations are deliberately distinct: promote reorders without interrupting; deliver interrupts and dispatches immediately; drop removes without delivering.

### Patch Changes

- dde599e: Simplify sessions webview layout: merge "Awaiting bg" section into "Quiet" (reducing 6 sections to 5) while preserving visual distinction via amber dot and pulsing bg-task indicator. Replace text label (⏳N) with small ambient pulsing dot after cost tag for pending background tasks.
- 11982fd: Introduce shared dashboard presence classifier (`presenceFor`) to unify session-status rendering across CLI and VS Code. Previously, the CLI sessions table and VS Code tree/webview each derived their own inconsistent status readings. The new four-state model (running/tending/attention/quiet) is driven by a pure, config-aware classifier in @agentproto/runtime, consumed identically by both clients. Fixes status divergence and adds grace-window config (`sessions.attentionDelaySec`, default 60s).
- dcfaa65: Fix text fragment rejoining logic to use only the explicit `partial` flag instead of heuristic `endsWith("\n")` check. This prevents complete text blocks from being incorrectly concatenated when tool calls interleave, which was causing paragraphs to run together (e.g., "…the client.Trial logic…"). The writer's transcript contract emits end-of-message blocks as non-partial records without trailing newlines, making the explicit `partial: true` flag the only reliable glue signal.
- 6372c19: Implement exit-time auto-reclaim for policy-provisioned (implicit) worktrees. When a session spawned under the `"always"` isolation policy without an explicit `worktree` request exits cleanly (merged/fresh, no uncommitted work), its worktree is automatically reclaimed using the same safety-layered classify→re-verify→remove pipeline as `worktree gc`. Caller-explicit worktrees (today's manual-cleanup behavior) are never auto-reclaimed. The feature is fire-and-forget, best-effort only, and never interrupts session teardown.
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
- Updated dependencies [dfb41f6]
- Updated dependencies [76f2c78]
- Updated dependencies [adebd5b]
- Updated dependencies [1297e7f]
- Updated dependencies [e3ad769]
- Updated dependencies [4ac9d37]
- Updated dependencies [88134e9]
- Updated dependencies [f62f63a]
- Updated dependencies [90411f9]
- Updated dependencies [557c4d0]
- Updated dependencies [007716f]
- Updated dependencies [c48c10d]
- Updated dependencies [34bbf65]
- Updated dependencies [c6b5e41]
- Updated dependencies [7d39ce7]
- Updated dependencies [d5eb115]
- Updated dependencies [f90a383]
- Updated dependencies [11982fd]
- Updated dependencies [8900417]
- Updated dependencies [9191286]
- Updated dependencies [dcfaa65]
- Updated dependencies [baf8570]
- Updated dependencies [7220068]
- Updated dependencies [bdc7d6f]
- Updated dependencies [6372c19]
- Updated dependencies [8a3d53d]
- Updated dependencies [c5016ed]
- Updated dependencies [9953527]
- Updated dependencies [1fd4a15]
  - @agentproto/runtime@2.9.0

## 0.10.0

### Minor Changes

- da57681: Add build identity tracking to CLI and runtime. Captures git SHA and build timestamp at build time, and judges source (workspace vs published) at runtime. This enables operators to distinguish between workspace distributions and published tarballs of the same version via `daemon start`/`status` output and `/health` endpoint.

  New exports:
  - `renderBuild()` from `@agentproto/cli/commands/daemon`

  New optional fields:
  - `DaemonHealthInfo.build`
  - `CreateGatewayOptions.build`
  - `RuntimeHttpServerOptions.build`
  - `DaemonHealth.build` (VS Code)

- 9fe9f66: Fix session lineage handling in the webview: subagents spawned under human chat sessions now stay in the agents lane (nested under their spawner) rather than routing to the auto lane's Tasks group. Orphans and children of machine-origin sessions correctly fall back to Tasks. Includes cycle detection to prevent infinite loops in parent chain traversal.

### Patch Changes

- 3740171: Fix transcript debounce-split bug where mid-word fragments split by interleaved tool-call records would create artificial paragraph breaks. Adds `partial` flag to track explicitly unterminated flushes and updates reducers to rejoin text-delta records that haven't reached newline termination, keeping sentences coherent across tool interactions.
- Updated dependencies [afa1796]
- Updated dependencies [3740171]
- Updated dependencies [d63cd31]
- Updated dependencies [bfd7daf]
- Updated dependencies [1bb03c4]
- Updated dependencies [da57681]
- Updated dependencies [949c6c7]
- Updated dependencies [463d345]
- Updated dependencies [d1b4aa4]
  - @agentproto/runtime@2.8.0

## 0.9.0

### Minor Changes

- a9798c1: Add model status indicators to curated model chips in wallet cards. Users now see colored dots and tooltips explaining why a model is active, inactive, unbillable, or unlisted before spawning. Also moves wallet actions from hover-gated to inline and adds a filter input to the allowed-models dialog for better usability.
- 506f829: Add Auth & Models Explorer — an editable webview for managing auth profiles, wallet curation, and model routing. Features vendor-grouped model allowlists, per-wallet enable/disable, provider connection flows, and local-router upstream link management.
- 0aa54c5: Add interactive permission-ask UI with clickable option buttons. Introduces `resolveQuestion` webview message type for permission responses and updates daemon integration to handle structured permission decisions via toolCallId.
- 59d23d1: Enhance session visibility by tracking watcher metadata (who's watching and what they're waiting for) alongside the watchers count. New optional `SessionWatcherInfo` type captures waiter identity, event, timeout, and attach timestamp. Adds "awaiting-bg" section for sessions with pending background tasks. All changes maintain backward compatibility.
- 231f015: Add native terminal/TUI launching for harnesses and redesigned harness card UI. New `NATIVE_LAUNCH_ARGV` export in runtime maps harness slugs to their launch arguments. VS Code package now shows a wallet badge (replacing manifest facts) for quick navigation to billing providers, adds a Terminal button to spawn native sessions, and supports programmatic auth model focus targeting for direct provider navigation.
- cbe11c2: Fix jcode print arm: add `--ndjson` output format and move `run` subcommand to `bin_args` so composed flags land after it (not before). Add comprehensive jcode NDJSON event mapper with full test coverage. Implement fail-fast TTY handling for interactive setup steps: refuse pre-spawn when stdin is not a TTY, return distinct `EXIT_SETUP_NEEDS_TTY (78)` to surface the condition separately from real failures. Add `needsInteractiveSetup` flag to `AdapterInstallResult` and VS Code install action to offer "Open Setup Terminal" for TTY-blocked installs.
- a0558d4: Add session pinning — a server-persisted, list-visibility-only favorite flag. Pinned sessions sort to the top of `agentproto sessions` table and the VS Code webview's dedicated "Pinned" group. Includes new CLI `pin`/`unpin` subcommands, the `session_set_pinned` MCP verb, HTTP route `POST /sessions/:id/pin`, and dedicated UI in VS Code. Deliberately orthogonal to `keepAlive`, reaper eligibility, and notifications — pin is a quiet, structural sort/display flag with zero operational side effects.
- 140874a: Add optional `provider` field to ACP agent specifications. This allows generic ACP adapters (Mistral Vibe, Google Gemini CLI, Moonshot Kimi CLI) to declare their billing endpoints, enabling clients to link the harness to that provider's wallets even when no model list is declared. The provider is projected through AdapterInfo and integrated into VSCode wallet linking logic.

### Patch Changes

- bbc0495: Add distinct erlenmeyer-flask icon for the Agentproto Lab activity-bar container to improve visual distinction from the CLI mark in the VS Code activity bar.
- 9c27cfe: Improve Sessions webview row presentation: show workspace labels as location tags for in-place sessions (replacing generic "in-place" text), reposition background tasks chip from name line to right side under timestamp, and add hover details showing cwd and isolation posture.
- 42ca610: Add in-band adapter turn-error tracking and refactor session status precedence. Introduces `lastTurnErroredAt` field to distinguish adapter-reported failures (status stays "running") from thrown/rejected streams (status→"error"). Reorders status dot precedence to awaiting > stalled > busy and separates healthy parked-bg sessions from genuinely stuck ones in the status bar.
- 100d074: Wire grok-cli adapter into the CLI package's static CATALOG and VS Code extension's icon mappings. The adapter was previously installable via `agentproto install` but invisible to adapter discovery UI (MCP adapter_list, VS Code Harnesses panel) because it was only found via workspace scan, not the bundled catalog. Adds catalog entry with xAI branding metadata, SVG icon, and adapter icon → file mapping for VS Code.
- bc737ba: Fix: composer stuck on "Sending…" after mid-turn send — clear `isSending` on `queued` ack (regression from #967). UX: "Interrupt & send" now shows whenever the agent is busy and implements stop-and-go behavior (interrupts current turn and sends typed text, or forces the front of the queue when empty). Each queued row gains a per-item "send now" button.
- 4474e5e: Expand terminal launch coverage to every harness with an interactive CLI arm by broadening NATIVE_LAUNCH_ARGV beyond attachArgv's resume-specific gates. Redesign harness card action buttons from platform-font glyphs to crisp SVG icons (conversation bubble + terminal glyph) with title and aria-label for accessibility.
- Updated dependencies [e418ec7]
- Updated dependencies [2e24a7e]
- Updated dependencies [27a22ca]
- Updated dependencies [59d23d1]
- Updated dependencies [2120494]
- Updated dependencies [42ca610]
- Updated dependencies [6b04734]
- Updated dependencies [0b4a84b]
- Updated dependencies [231f015]
- Updated dependencies [4474e5e]
- Updated dependencies [5de8be3]
- Updated dependencies [f96dc2a]
- Updated dependencies [cbe11c2]
- Updated dependencies [a0558d4]
- Updated dependencies [140874a]
  - @agentproto/runtime@2.7.0

## 0.8.0

### Minor Changes

- 337cbfd: Parked-background-task detection, watch/unwatch sessions, watcher visibility.

  **Runtime** (`@agentproto/runtime`, patch):
  - Detect sessions parked with pending background tasks (run_in_background tool calls that end a turn without triggering a wake-up). Emit session:bg-tasks-parked / session:bg-tasks-cleared events; stamp pendingBgTasks count on descriptor.
  - Watcher attach/detach events: emit session:watcher-attached / session:watcher-detached when a blocking wait subscribes/unsubscribes, reporting the watcher count and supervising session id (when the wait came through the scoped orchestrator).

  **VS Code** (`agentproto-vscode`, minor):
  - Watch/unwatch commands: pin an eye on sessions so transitions into needs-you / stalled / parked-bg / failed / done raise toasts (debounced per state). Persisted per workspace; toggleable from tree and command palette.
  - Parked-bg activity state (needs-you > stalled > parked-bg > working > idle) with clock/warning icon, bg-task count in tree description + tooltip, '⏳ N bg tasks' webview chip.
  - Watcher visibility: info banner when a watcher attaches to the session you're watching, user-prompt badges when another session injected the message, and attributed history in the transcript.

- 6565428: Implement functional model restart modal and refactor sessions webview UI for compactness. The model switch now performs an actual session restart with the new model instead of just showing an informational message. Workspace color has been moved to the dot indicator via CSS variable for cleaner layout. Status indicators are condensed to icons and numbers to improve space efficiency while preserving full context via tooltips.
- f1f0866: Add background task UX: mark pending tool calls with `run_in_background: true` as background in the presentation layer, show an amber/brown dot indicator in the sessions panel, render a fixed chip strip in the transcript panel for quick navigation to still-running background tasks, and add a dimmed harness watermark in the bottom-left corner.
- 6e403f8: Add support for task/child sessions in webview grouping. Sessions with `parentSessionId` are now routed to a new "Tasks" subgroup in the auto lane. Also improve SVG rendering for adapter icons in the composer.
- 199324e: Enhance VS Code webview's long-running tool call handling with progressive elapsed time display, smooth label fade animations, intelligent fallback labels for stale tools, and de-alarming of the blocked note. The "$ now:" line now shows contextual information (Watching executor, activity summary, or Working) for steps older than 30 seconds, improving UX for supervision workflows. The blocked note is hidden when the live "$ now:" line already narrates the in-flight step, reducing redundancy. The live "$ now:" line's fade and debounce state is carefully shielded from past chapters, so the animation still fires correctly in multi-chapter books.

### Patch Changes

- 9943466: Fix SVG icon flashing on sessions panel re-render by caching fetched SVG content in memory.
- 59bc722: Three fixes around MCP app panels and session restart:
  - **MCP bridge injection** (`@agentproto/runtime`, `@agentproto/apps`): fix the idempotency check that incorrectly skipped injection for documents consuming `window.McpApp.connect()` — regex narrowed from `/window\.McpApp\b/` (any mention) to `/window\.McpApp\s*=/` (assignments only). Defensive guard in mail-triage UI when the bridge is missing.
  - **Credential re-resolution on restart** (`@agentproto/runtime`): pass `accessProfileRef` to `resolveResumeAuth` so restarting a session that used a named auth profile re-reads the current credential from the keychain instead of falling back to a stale mode-based path.
  - **Restart loading state** (`agentproto-vscode`): show a loading state and disable the restart button while a session restart is in flight; new `restartFailed` webview message resets the state on error.

- ec9efa3: **Hermes nativeTerminalResume gated on Node ≥22.5** — hermes TUI uses node:sqlite which is unavailable on older runtimes; the capability is now computed at import time so restart falls back to ACP agent-cli instead of crashing.

  **augmentWithFsResume backfills adapterSessionId** — when never captured (session killed before ACP handshake), backfill it from filesystem probe so agent restart can attempt ACP-level resume in addition to PTY-native restart.

  **restartAsTerminal opens transcript on fallback** — when restart falls back to agent-cli (no PTY available), open the conversation transcript view instead of the agent-mirror pseudo-terminal.

- b51b58e: **Support shell-based package managers (uv, pip, brew, cargo, go, pipx)** — expand adapter installation beyond npm to handle package managers commonly used in AI/ML workflows. New `parseShellHint` function parses and validates non-npm install commands; only recognized package managers are executed to prevent blind shell injection.

  **ACP adapters can now use `uv tool install`, `pip install`, etc.** — planner detects hint type (npm → shell → unsupported) and adapter install routes handle shell commands with the same safety/timeout guards as npm-global installs.

- c625db3: Refactor webview logo rendering: replace `harnessGlyph` string with structured `AdapterLogo` type supporting both icon files and lettermark fallbacks, enabling richer visual branding for different adapter providers.
- 2c24d6f: Fix by-model-router adapters (hermes, pi, opencode) to stamp the resolved billing gateway onto the session descriptor's `route` field, preventing false "restart required" alerts in the VS Code change-model picker.
- 9943466: Fix SVG icon flashing on sessions panel re-render by caching fetched SVG content in memory.
- 1cb2093: Enhance session resumption transparency by distinguishing "no context available" from "partial context recovered from daemon transcript". The new `ResumeContextDigestResult` interface provides explicit context-availability tracking, enabling callers to display honest restart banners about what was actually recovered.
- 2a124b7: Route child sessions (with parentSessionId) to the auto lane's Tasks group instead of nesting them under their parent. Display adapter SVG icons instead of text slugs in the composer bar for improved UX.
- b5ec52b: Add optional title field to plan events, displayed in VS Code conversation UI. Titles are safely threaded through ACP client translation, runtime event stream, and conversation presenter, supporting both immediate titles and late-binding (title added in subsequent plan updates).
- 41e36f4: Settle orphaned tool calls at turn-end. Adapters like Hermes can end a turn while omitting tool-result events for nested/parallel calls, leaving them stuck in "pending" state in UI consumers. This change synthesizes tool-result events with null values before the turn-end is recorded, ensuring transcript replay sees completed tool cards.
- e2dd0e4: Preserve rendered Markdown structure in the VS Code webview pause card, allowing rich formatting like code blocks, lists, and links to remain visible and interactive instead of being flattened to plain text.
- Updated dependencies [996ec8e]
- Updated dependencies [c17620e]
- Updated dependencies [33e97d3]
- Updated dependencies [d22fec5]
- Updated dependencies [af936f8]
- Updated dependencies [59bc722]
- Updated dependencies [337cbfd]
- Updated dependencies [ec9efa3]
- Updated dependencies [b51b58e]
- Updated dependencies [2375019]
- Updated dependencies [6fba2b9]
- Updated dependencies [82ca9e6]
- Updated dependencies [c1e1807]
- Updated dependencies [2c24d6f]
- Updated dependencies [ce6352b]
- Updated dependencies [57dec3b]
- Updated dependencies [1cb2093]
- Updated dependencies [a6b06b2]
- Updated dependencies [be06061]
- Updated dependencies [bd990d1]
- Updated dependencies [dde641e]
- Updated dependencies [66a6446]
- Updated dependencies [4b20f1e]
- Updated dependencies [c3dbdc4]
- Updated dependencies [435a6f2]
- Updated dependencies [b5ec52b]
- Updated dependencies [41e36f4]
- Updated dependencies [9d76f08]
- Updated dependencies [16e4304]
- Updated dependencies [16e4304]
  - @agentproto/runtime@2.6.0

## 0.7.0

### Minor Changes

- c4102d1: Add installed app UI panel support: new tree view for discovering daemon-installed apps that ship a UI, webview panels to host app UIs (via MCP resources/read), and commands to open/refresh apps. Introduces DaemonClient methods listApps(), appToolCall(), and readResource() to support MCP-Apps protocol.

### Patch Changes

- 69e97d9: Documentation sync: version bumps, turn-liveness watchdog config details, UI surfaces/artifacts/dev-launch config examples, and agentproto-apps-sync binary documentation.
- 0dea138: Remove stale hero element from empty state when real conversation turns arrive. Fixes a bug where the "Ready when you are" message persisted after the first message.
- Updated dependencies [36e19c3]
- Updated dependencies [f8b9c73]
- Updated dependencies [6e1fcf3]
  - @agentproto/runtime@2.5.0

## 0.6.0

### Minor Changes

- a2ed47d: Add live auth & model configuration map visualization to VS Code extension. New webview shows harnesses, their reach to providers, and wallet/endpoint relationships with computed edge classification (native/via-router). Includes new type fields on HarnessProviderCapability and HarnessCapabilities for billing endpoint and API mode information.
- 7f98884: Add session visibility tracking: ephemeral watcher counters surface how many supervisors are actively monitoring a session, and lineage carry-forward ensures sessions maintain their source channel through restarts.
- a836e66: Wallet-first revamp of auth-related UI surfaces. Auth Profiles webview renamed to "Wallets" and refactored to group profiles by provider via the Auth & Model Map's single-source-of-truth `buildProviders()`/`accessKind()` logic — eliminating duplicate classification across four surfaces. Harnesses webview now displays manifest facts (interface spoken, route, base_url acceptance) and per-provider reach via `buildAuthModel()`, ensuring parity with the map. Auth Settings consolidated into Wallets view for curation editing and model removal, leaving Auth Settings as a redirector to the two surfaces that replaced it. All mutation flows (connect, enable, disable, delete, set models) use only existing DaemonClient endpoints.
- c58b9fe: Implement turn-liveness watchdog: detect mid-turn agent-cli sessions with dead adapter streams.

  The daemon periodically sweeps every BUSY agent-cli session and, for one that is mid-turn, NOT legitimately blockedOn a subagent/command, and has had no adapter activity for longer than the configured threshold (default: 5 minutes), stamps `stalledSinceMs` on the descriptor and emits `session:stalled` — surfacing a dead adapter stream (network drop, hung child) that would otherwise sit indistinguishable from healthy long work. Detection and observability only; never auto-kills or restarts. Threshold configurable via `daemon.turnStallAfterMs` config or `AGENTPROTO_TURN_STALL_AFTER_MS` env var (DEFAULT ON, opt-in-to-disable). VS Code displays the stall flag (⚠ badge) when the daemon confirms, with a tooltip showing the silent duration.

- 542f7c4: Add chip-pickers support for session effort switching and restart-with-overrides. Introduces three new daemon client methods: `setSessionEffort()` for live effort changes, `setSessionPosture()` for live posture/mode changes, and `restartSessionWithOverride()` for restart-bound axis switches (wallet, harness, route). Includes pure-logic module (`chipPickers.logic.ts`) for testable decision-making on which axes switch in-place vs require restart. Adds effort chip to composer bar with proper conditional display and comprehensive test coverage.
- a7f897a: Dim the route chip when only one gateway is valid, preventing no-op clicks. Adds `isRouteSwitchable()` utility function (reuses `resolveRouteRows` for consistency) and UI-computed `routeSwitchable` flag to `SessionDescriptor`. The controller caches the model catalog and stamps the flag before posting session updates, allowing the composer's route chip to settle into its dimmed/active state. Backward compatible (routeSwitchable is optional); catalog fetch is defensive fire-and-forget.

### Patch Changes

- f5a3584: Enhanced file link resolution with robust fallback strategies: sanitization of decorated paths, multi-stage resolution (direct → sanitized → suffix matching → basename), and QuickPick for multiple matches. Adds graceful binary file handling via vscode.open fallback. Fixes working row visibility in book view to avoid duplication with live chapter status. Improves empty conversation display with session identity hero showing harness, model, mode, and wallet. Includes post-layout re-measure for message clamping to avoid spurious expanders on first paint.
- 2d9befc: Add session visibility features for parent-child session hierarchies: `childrenBusy` field counts descendant sessions mid-turn, enabling UI to show idle parents as "delegating" rather than truly idle; also adds "parked" state for idle sessions with watchers.
- a0bba97: Refactor conversation chrome with new pure helpers for webview injection. Add `formatCostShort`, `contextRingLevel`, `titleStatusState`, and `projectPlan` functions to support improved plan rendering (collapsible done summary, failed visibility, upcoming windowing), threshold-based context ring coloring, title status dot visibility states, and two-decimal cost display with hover precision.
- Updated dependencies [1d3cbc2]
- Updated dependencies [7f98884]
- Updated dependencies [2d9befc]
- Updated dependencies [c58b9fe]
- Updated dependencies [4b73e28]
- Updated dependencies [b098b52]
- Updated dependencies [c48defd]
  - @agentproto/runtime@2.4.0

## 0.5.0

### Minor Changes

- e578324: Implement Design B — attention-first sessions webview redesign. The seven status tabs are replaced by five fixed-priority attention sections (Needs you → Running → Attention → Quiet → Earlier). Navigation collapses to two axes: a project rail (All + one chip per workspace with "awaiting" indicators) and an Agents/Auto segmented control for human- vs machine-origin session filtering. Auto lane groups into Gate reviews, Crons, and Commands, with consecutive cron runs collapsing into a single row with a count. Supports progressive loading via GET /sessions/summaries for bounded first paint.
- b8da097: Brand icon, activity-bar glyph, and comprehensive Marketplace README — extension icon (256×256), updated VS Code activity-bar icon using CLI brand mark (chevron + block cursor), and rewritten README for user onboarding and discovery.
- 568a5b7: Dissociate user asks from agent chapter titles; add pop-out feature for wide narration blocks (tables, code) in book view; fix pause-card race condition when awaitingInput lingers during active work.
- 7a2e2f0: Add archived session toggling, watched session indicators, subagent nesting with depth-based indentation, and improved activity preview text generation with markdown stripping and system-line filtering to the VS Code sessions webview.
- 5f2ebb8: Add prompt provenance tracking to transcript records and webview, enabling accurate attribution of supervisor-orchestrated turns. When one agent session prompts another (via `agent_prompt` or spawn with `initialPrompt`), the originating session ID is now recorded as the turn's source and displayed in the conversation UI as "SUPERVISOR ASKED" instead of "YOU ASKED". The feature is backward-compatible: existing transcripts and API call sites are unaffected, and source fields are optional everywhere.
- e5f5b80: Enhance session search to use token-AND semantics: each whitespace-separated token in the query must appear (case-insensitive substring) in the session's label, command, cwd, or id. Query tokens are independent of order, and an empty or whitespace-only query matches all sessions. This provides a better UX for multi-word searches (e.g., "build sales" now returns sessions matching both "build" AND "sales", not just the literal phrase).
- 88aee63: Add a color picker UI for workspace colors in the Sessions webview. Users can now click the swatch on a workspace chip to override its color via a popover with arrow-key navigation, Enter/Escape keyboard support, and click-outside dismiss. Colors persist via VS Code globalState and hydrate on extension startup. Includes comprehensive type-safe validation, accessibility features (ARIA labels, roving tabindex), and end-to-end tests.
- 87b89f4: Add autolinking for URLs and file paths in transcript webview. Bare URLs (http/https/file), markdown-style links, and file paths with `:line` citations are now clickable — external URLs open in the browser, file paths open in the editor.

### Patch Changes

- 68432a2: Add GFM pipe table support to the transcript markdown renderer. Tables support alignment markers, inline formatting inside cells, and properly handle escaped pipes and pipes inside code spans.
- 13c7b9e: Add conversation book view — a redesigned reading surface that groups conversation turns into chapters (split on user prompts) with folding, duration tracking, and step aggregation. The book is the default view for structured sessions; users can toggle back to the raw transcript via a header button. All book logic is pure, testable, and injected into the webview alongside existing helper modules.
- 8d025e4: Fix markdown block rendering in conversation book by adding CSS for structural elements (paragraphs, lists, code fences, blockquotes, headings, tables) and correct chevron alignment.
- 2df0213: Replace stop-lookalike glyph with archive-box SVG icon in the Sessions webview archived toggle button. The ▣ character was visually similar to the stop button (square in circle), causing user confusion. Now uses the proper ARCH_SVG icon instead.
- 3a16ea2: Improve plan block rendering with hanging-indent markers, state-specific color coding, and progress tracking. Separates marker and content into distinct elements for better accessibility and styling control.
- fab3bfa: Refactor the "show archived" toggle to switch between mutually exclusive views (archived-only vs. active-only) instead of merging archived rows with active rows. Updates UI labels and aria-labels to reflect the new semantics, and adds empty-state messaging that adapts to the current view mode.
- 1bce78e: Persist permission resolution in the durable transcript so the conversation UI can display resolved permissions and clear the "Awaiting your decision" state. Permission-resolved events are keyed by toolCallId to correlate with their originating agent-prompt asks.
- Updated dependencies [29acda3]
- Updated dependencies [a26d527]
- Updated dependencies [5f2ebb8]
- Updated dependencies [1bce78e]
  - @agentproto/runtime@2.3.0

## 0.4.1

### Patch Changes

- 3e187e5: Add Google Antigravity adapter and extend print-arm event mapper.
  - **New adapter: @agentproto/adapter-antigravity** — AIP-45 print/headless adapter for Google Antigravity's `agy` CLI (a multi-model coding agent supporting Gemini, Claude, GPT-OSS). Includes auth documentation (OS keyring + Google Sign-In), sandbox policy, and model/option configuration.
  - **Print-arm event mapper extension** — Added `antigravity-stream-json` event schema handler to support `agy`'s custom wire-event taxonomy (discriminated by `event` field, nested `conversation_id`, incremental `text_delta` fragments). The mapper handles text streaming, tool calls, tool errors, usage tracking, and session resumption via `--conversation <id>`. Supports single wire lines that fan out to multiple StreamEvents (e.g., a tool step's terminal DONE carries both call and result).
  - **Type safety** — Introduced `PrintEventSchema` type to union all supported event taxonomies; updated Zod schema validation to include `antigravity-stream-json`.
  - **Catalog entries** — Added antigravity to the CLI adapter catalog; also included two new ACP generic agents (Mistral Vibe, Kimi CLI) with their VS Code lettermark overrides.

- 9a29a4c: Redesign Harnesses webview UI: stable action buttons (Install/Installing…/▶ Start) with optimistic state management and keyboard accessibility. Replaces hover-swapping pattern. Adds comprehensive DOM-level test coverage.
- Updated dependencies [48b4302]
- Updated dependencies [087f0ea]
- Updated dependencies [5e75a57]
- Updated dependencies [2962637]
- Updated dependencies [2b379e9]
  - @agentproto/runtime@2.2.0

## 0.4.0

### Minor Changes

- f37fe7a: Add origin-based session filtering and separate machine-origin sessions in the status bar and tree view. Introduces `agentproto.hideMachineSessions` setting (default: true) to suppress automated gate-review sessions by default while keeping them visible in a separate status-bar segment and tree icon with "verified" icon instead of "plug".

### Patch Changes

- 8228d88: Add dep-bump reclaim exemption for worktree GC: safely promote clean, unpushed worktrees from `hold` to `reclaim` when all commits are mechanical dependency bumps (subject and cumulative diff validation). Addresses storage bloat from recurring automated dependency-bump worktrees piling up as permanent holds. Includes comprehensive test coverage and applies re-validation at apply time (layer 2).
- Updated dependencies [c825a12]
- Updated dependencies [832870d]
- Updated dependencies [c1399f3]
- Updated dependencies [8228d88]
- Updated dependencies [678bc1a]
- Updated dependencies [980276e]
- Updated dependencies [df10f28]
- Updated dependencies [6280066]
- Updated dependencies [b99245b]
- Updated dependencies [fd3e287]
  - @agentproto/runtime@2.1.0

## 0.3.0

### Minor Changes

- 15e15db: Add context-continuity policy, structured checkpoints, and fresh continuation for long-running agent sessions.
  - Resolve context-continuity policy (manual / ask / auto) with configurable warn/compact/continue-fresh/hard-stop thresholds.
  - Build and persist bounded structured checkpoints next to the source session's events.jsonl.
  - Spawn a fresh continuation session with the same adapter, model, route, access, posture, cwd, and MCP servers, linked via `continuedFrom`/`continuedTo`.
  - Add MCP tools: `session_context_status`, `session_checkpoint`, `session_compact`, `session_continue_fresh`.
  - Surface compact and continue-fresh actions in the VS Code sessions panel.

- 7f6dc85: Add terminal location management: users can now toggle terminals between editor and panel views via a new `moveTerminalLocation` command in the terminal title context menu. Integrates a new `openTerminal` webview message type to switch from conversation view to terminal view (WP1–WP3).
- fa8fcd2: Add terminal location management: users can now toggle terminals between editor and panel views via a new `moveTerminalLocation` command in the terminal title context menu. Integrates a new `openTerminal` webview message type to switch from conversation view to terminal view (WP1–WP3).
- ce4a613: Add session isolation tracking and "Copy Session ID" command to VS Code extension. Sessions tree now displays worktree vs. in-place context with branch glyph (⑂), replacing redundant workspace names. New optional `worktreePath` and `worktreeId` fields on SessionDescriptor mirror the runtime's session metadata. New exported functions `worktreeName()` and `isolationLabelFor()` enable platform-agnostic worktree identification.
- f13dfe8: Extract pure rendering logic from transcript panel chrome into testable functions (`harnessGlyph`, `accessIdentity`, `contextGauge`), enabling reuse and unit testing of UI helpers. Add new header glyph icon for harness identity, replace segmented view toggle with single terminal button, display context-window gauge as visual ring with color levels (FIX 2/5), and move auth identity to cost popover for better header space efficiency (FIX 3/4).
- a3deef9: Fix session display name precedence: derived titles now outrank spawn labels

  Introduces a `renamedByUser` flag to distinguish user-renamed labels from spawner-supplied labels. This allows the derived title (first sentence of the first prompt) to outrank spawn labels in the display precedence, preventing slugs like "auto-title-precedence-fix" from shadowing useful titles. User-explicit renames still win.

  Breaking compatibility: None. Sessions persisted before this change treat an absent `renamedByUser` flag on a labelled session as "user-renamed" to preserve prior edits; only new spawns stamp the flag explicitly.

- 61b23e0: Implement adapter installation API for harnesses: add `POST /adapters/:slug/install` HTTP route and `adapter_install` MCP tool to install not-yet-ready agent CLI adapters. Supports both acp-catalog CLIs (npm-global) and first-party workspace adapters (manifest install pipeline). VS Code extension UI integration with context-aware install button for installable harnesses.
- 7d54bba: Add scriptable login flow for Anthropic subscription authentication. Users can now run `claude setup-token` directly within the VS Code extension to generate tokens, improving UX and reducing manual token-finding steps. New exports: `loginCommandFor()` and `credentialSourceChoices()`.
- e40554c: Add `agentproto.setSessionAccessProfile` command to change which auth profile (wallet) an agent-cli session bills against. Access is a restart-only axis per SPEC §4.3, so the command drives `session_restart` with an `access` override. Includes proper handling of live sessions (kill-first to avoid duplicates) and profile eligibility filtering reusing the sessionConfig resolver.
- 7249ba1: Add `agentproto.configureSession` command for per-session configuration. Renders dynamic chip strip from daemon capabilities (model, effort, route, access, posture, context profile) as interactive quick pick. Live chips (model/effort/native posture) switch via daemon verbs; restart-only chips apply via `session_restart` with override. Includes proper model↔route trap detection, profile eligibility tracking, and advisory posture labeling (SPEC §6).
- 95aafd4: Add support for user-saved presets in the VS Code extension. Users can now quickly spawn sessions using frequently-used configurations saved to ~/.agentproto/presets.json, with preset selection integrated directly into the spawn quick-pick menu. Includes graceful degradation on older daemons and comprehensive error handling.
- 645279d: Add support for source-backed auth profiles — named profiles that resolve credentials fresh from self-refreshing sources (e.g. `claude-code-oauth`) instead of storing a static secret. Session spawn resolves source-backed profiles via Mode 3 credential resolution on every spawn; session restart explicitly rejects them (out of scope for restart, follow-up planned).
  - `AuthProfile.credentialRef` now optional, new mutually-exclusive `source` field
  - `validateCreateInput` enforces exactly one of `credential`/`source` for oauth-bearer, requires `credential` for api-key
  - Session spawn: source-backed profiles resolve fresh credential each time via `resolveSubscriptionCredential`
  - Session restart: source-backed profiles fail loud with `RestartOverrideError`
  - New tests: profile provisioning with source, session spawn with source, restart rejection of source

- 8f212e5: Add comprehensive auth profile management: split presets into connected/unconnected states with one-click connect, show models each wallet can bill, and enhance spawn wizard to properly handle gateway models with explicit route + access resolution.
- 295f137: Add posture (mode) and access profile (auth/wallet) chips to the transcript composer bar. Users can now click these chips to open the unified session config picker and switch posture or access profile mid-conversation. The new `postureLabel()` helper renders both canonical and harness-mode postures as strings. UI fallback labels ("posture?", "no wallet") are always visible to indicate these fields can be configured, improving discoverability.
- 26df22b: Add "Stopped" and "Failed" status filter options to the sessions tree view, refactored to use the activity classification system (`activityFor`) for clearer semantics and correct handling of edge cases like sessions killed mid-turn vs. idle after completion.
- d0fff6c: Add resume-in-place affordance for daemon-restart recovery: new `agentproto.resumeSession` command that sends a plain prompt to the same session id (distinct from restart which mints a new id). Includes new `SessionDescriptor` fields `endedReason` and `interrupted` to distinguish resumable ghosts from ordinary terminal rows, with UI surfaces for interrupted-turn notices.
- 8c4661b: Add "Use My Existing Claude Code Login" — a source-backed auth profile that reuses your local Claude Code subscription without pasting a token (resolved fresh on every spawn), plus an activation-time auto-adopt policy (`agentproto.autoAdoptLocalLogin`: auto | ask | off). Codex/Gemini are deferred: the subscription-source mechanism needs an adapter with an `authSubscription` bearer env, which only claude-code provides today.
- 05f85ac: Add "Save as Favorite" functionality to capture and reuse preferred spawn configurations. New HTTP routes (POST/DELETE /user-presets) enable favorites authoring from VS Code, storing user presets with pinned spawn axes (adapter, model, route, effort, context) and location (cwd, skills) in ~/.agentproto/presets.json. Favorites are displayed in the spawn picker with star icon, enabling zero-input re-spawn with their pinned values.
- 8d20b7e: Dynamic session activity line: secondary, auto-regenerating label showing what each session is doing now. Regenerated on turn-end from heuristics (ANSI-stripped last assistant/tool line + lifecycle state); frozen for human-renamed sessions; throttled to ≥60s interval. Displayed as the leading segment of the sessions tree row (sidebar-truncated to 72 chars) and in full in the tooltip.
- c3e357b: Add daemon configuration UI surface (`agentproto.showDaemonConfig`) — a QuickPick that displays and edits daemon behavior knobs (`resumeSessionsOnBoot`, `idleReapAfterMs`) directly from VS Code, with live-vs-persisted reconciliation and restart-pending detection. Also extend `DaemonHealth` type with optional fields for the two behavior knobs surfaced by `/health`.
- 733221d: Add "Group By Origin" feature to sessions panel. Sessions can now be grouped by their source (Claude Code desktop, VS Code extension, cron, etc.) via a new toolbar toggle. When enabled, this grouping takes precedence over workspace grouping. Children nest under their root's origin group regardless of their own origin. New origins render under their raw slug without code changes.
- f3f5e82: Implement WS4 phase 2: model picker UI for auth profile curation. Adds pure picker logic functions with comprehensive tests, VS Code command flows for opening the model picker and toggling individual models, and webview rendering for model chips with removable toggles. All model data is sourced from the catalog_provider_models read tool without hardcoded values.
- f3f5e82: Implement WS6: credential discovery scanner + first-run onboarding flow. Adds `auth_discover_credentials` (read-only scan of local credentials), `auth_profile_import` (materialize discovered credentials into profiles), and onboarding wizard. Two security invariants verified: never returns secret values (sentinel test), never throws on malformed source (per-source warn+skip). All five discovery origins supported (Claude Code, Codex, Gemini, env, hermes-config). New optional `origin` field on AuthProfile stamps the import provenance.
- 70bfab0: feat(runtime): expose session-story-panel module in package exports

  feat(vscode): live session-story webview panel with "Open story" command

  Reuses SESSION_STORY_PANEL_HTML from @agentproto/runtime byte-for-byte inside a VS Code webview panel (srcdoc iframe relay pattern). Adds agentproto.openStory command to open any session's live timeline, wired into the spawn wizard and session tree context menu.

  The panel drives itself over JSON-RPC 2.0 postMessage, calling session_list/agent_export/agent_prompt via StoryPanelController — a testable bridge mapping the panel's three tools onto DaemonClient.

- f3f5e82: Add profile enable/disable (WS2), per-model curation (WS3), and server-side credential identity display (WS5) features.

  **WS2 — Whole-profile disable**: New `disabled?: boolean` field on `AuthProfile` and `setAuthProfileEnabled()` function enable/disable a profile entirely, dropping all its models to non-runnable. The `eligibleProfiles()` predicate skips disabled profiles at the endpoint/method gate.

  **WS3 — Per-model curation**: New `models?: ModelCuration` field on `AuthProfile` and `setAuthProfileModels()` function restrict a profile to specific models via an allow-list. Curated profiles stay endpoint-eligible but only their chosen refs become runnable. The curation filter is applied downstream in the catalog join.

  **WS5 — Credential identity**: New `credentialIdentity()` function computes a read-only identity (fingerprint + last4 tail) server-side from the keychain, never exposing the secret. `auth_profile_list` MCP tool output now includes key status (`stored` / `self-refreshing` / `unavailable`) and identity for stored secrets. VS Code UI displays the tail and fingerprint in the profile row.

  All changes maintain backward compatibility: absent `disabled` means enabled; absent `models` means mode "all". Profiles without these fields parse and round-trip byte-identically to pre-feature versions.

- 56177fa: Refactor session grouping from two independent boolean toggles to a single multi-choice setting. Add new status-based grouping dimension (Awaiting you / Live / Failed / Stopped / Done) alongside existing workspace and origin grouping modes. Introduce three new commands: `setSessionGrouping` (QuickPick selector), `expandAllSessions` (bulk-reveal groups), and `cleanEndedSessions` (bulk-archive). Maintain backward compatibility via deprecation migration from `groupByWorkspace` / `groupByOrigin` settings to new `sessionGrouping` enum.
- 6c1c6e3: Add hot-reload functionality for local model packs (packs.local.json). The llm-endpoint proxy now validates pack configurations and exposes a POST /v1/packs/reload endpoint for live reloading without a restart. The VS Code extension gains a "Reload Local Router Packs" command with tree-view integration and field-scoped error feedback.
- 924cbf6: Add upstream credential linking and live testing:
  - **@agentproto/llm-endpoint**: New API for per-upstream credential status (describeUpstreamStatus, collectUpstreamStatuses, testUpstream) and HTTP routes (GET /v1/upstreams, POST /v1/upstreams/:provider/test).
  - **@agentproto/runtime**: New llm-endpoint-links-store for persisting upstream→profile links to ~/.agentproto/llm-endpoint-links.json, and new MCP tools (llm_endpoint_set_upstream_link, llm_endpoint_list_links).
  - **agentproto-vscode**: New "Upstreams" tree grouping with inline test and link actions, profile picker QuickPick, and pending-restart annotations when persisted links haven't been applied yet.

  Users can now map LLM provider upstreams to named auth-profiles (instead of bare env keys), manage those links via MCP, and test them live to verify credentials resolve correctly.

- 91741b3: Add opt-in supervisor crash-notification (crash-detect PR-4): parent sessions can now receive direct in-band `[child-crashed]` notices when their children crash by setting `notifyParentOnCrash: true` at spawn time. Notices are enqueued immediately for idle parents and queued for delivery at the next turn for busy parents, ensuring no interruption of in-flight work. Complements the existing external webhook notification path.
- 565bb7b: Add opt-in Sessions webview panel — a modernized alternative to the tree view with a pinned filter input, status tabs, two-line rows, harness/model glyphs, subagent nesting, and an open-in-tab indicator. Controlled via `agentproto.sessionsView` config (enum: "tree" | "webview", default: "tree").
- a5f04b8: Add optional webview-based panels for Harnesses and Auth Profiles as alternatives to TreeView panels, with adapter logos, inline actions, and collapsible sections. Both are opt-in via configuration and default to the existing tree views for backward compatibility.
- d5e2dc3: Add route-aware model selection to the VS Code extension. The change model picker now shows which route (gateway/provider) each model uses and flags cross-route switches as restart-required. A synthetic "Change route" row delegates to the new `configureSessionAxis` command for independent gateway selection. Refactor sessionConfig.ts to support targeting a specific configuration axis.
- cae88ed: Add support for explicit authentication headers in daemon client configuration. Enables cookie-based and other auth schemes (e.g., for attached sandbox authentication) via the new `agentproto.authHeaders` setting, which takes precedence over bearer tokens.
- 80559f3: Add harness pre-selection to spawn flow, inline dialogs for auth profile management, and unread indicators for completed sessions. Fixes CSP source handling in webview panels.
- 2ac5141: Add Configuration Lab webview panel for pre-spawn configuration preview. New features include:
  - `harnessCapabilities(adapter?)` daemon API method for fetching harness capabilities
  - New types: `HarnessCapabilities`, `HarnessProviderCapability`, `HarnessModelDiscovery`, `HarnessApplicationContract`, `ConfigurationLabSnapshot`, `ConfigurationLabAxisOptions`, `ConfigurationLabIssue`, `ConfigurationLabEffectiveField`, `ConfigurationLabSelectionInput`, `ConfigurationLabRawData`
  - New `agentproto.configurationLab` webview view with Configuration Lab UI
  - New `agentproto.openConfigurationLab` command to open the Configuration Lab
  - New activity bar container `agentprotoConfig` ("Agentproto Lab")

  The Configuration Lab lets users preview and configure harness, model, route, auth profile, posture, and effort settings before spawning an agent session, with validation feedback and effective configuration display.

- 4bdea9f: Add per-model provider and adapter-level route selection to support free-routing adapters. This enables adapters like claude-sdk to offer models across multiple billing gateways while preserving money-safety for fixed-provider and derived-from-model adapters. Includes catalog widening logic to emit gateway routes only for adapters that can reach them, plus UI fanout for independent route choice on launch-menu drill-down.
- 0a5e064: Add daemon connection state tracking to VS Code extension for improved first-run UX. Users now see a clear "connecting" state while awaiting the daemon, and an actionable "unreachable" screen if the daemon is not running. Exports `DaemonConnectionState` type and adds `connectionState` getter to SessionStore.
- 88c4cf3: Unify the VS Code sessions webview into a single continuous list with a sticky workspace selector and per-row workspace tags. Rows now show deterministic workspace colors, lifecycle actions (Stop for live sessions, Archive/Unarchive for terminal sessions), and an archived style. Status tabs and the active-session indicator are preserved from the existing tree semantics.

### Patch Changes

- bb63cf2: Fix Codex native OpenAI launch contract. A fixed-provider adapter (e.g. codex with `provider: "openai"`) matched against its own native gateway preset (`route.gateway: "openai"`) is now treated as a direct route: subscription mode stays eligible, the preset `base_url` is dropped, and no `base_url` option is injected. Non-native gateway presets and custom third-party routes remain unsupported for such adapters and are rejected at spawn time; the Configuration Lab filters them out of the route list.
- 66d34c2: Configuration Lab route/auth axes now resolve canonical catalog routes and eligible profiles per harness semantics. Fixed adapters like Codex surface their native OpenAI route and profiles; derived-from-model adapters like MastraCode no longer show misleading "unset" axes when defaults are auto-resolved.
- 93e6309: Declare MastraCode's model-derived api-key auth contract and enforce it in catalog/session eligibility.
  - `@agentproto/adapter-mastracode`: adds `modelDerivedApiKey: true` so the runtime knows its direct-route API keys derive from the chosen model; the capability strategy now reports each provider's wire protocol (`apiMode`) and never claims subscription support.
  - `@agentproto/driver-agent-cli`: accepts `modelDerivedApiKey` in the AIP-45 manifest schema.
  - `@agentproto/runtime`: `buildCatalogModels` now includes api-key profiles for adapters that declare `modelDerivedApiKey`, matching `spawnEligibilityManifest`.
  - `agentproto-vscode`: Configuration Lab surfaces the corrected MastraCode eligibility (api-key profiles only; no Anthropic subscription defaults).

- 36d953e: Add Harnesses and Auth Profiles sidebar views with supporting type updates and spawn wizard refactoring. Removes preset selection from spawn flow in favor of sidebar integration.
- 6a0fdaf: Unblock agent-cli→terminal harness switch via recoverable resume id fallback. Live claude-code sessions can now switch to terminal using the daemon's fs-based resume recovery mechanism, even before graceful-exit metadata is available. Also remove hermes from supported adapters since it lacks a pty-native restart strategy.
- 3865de6: Add file-based ("external") subscription login support for Codex and future adapters (Gemini). File-based subscriptions have the CLI read its own login file (~/.codex/auth.json), so the daemon injects NOTHING and only scrubs conflicting api-key environment variables, maintaining the money-safety invariant that no OAuth bearer is ever written to an api-key channel.

  Includes:
  - New `authSubscription: { external: true }` shape in adapter manifests for CLI-resident login files
  - `verifyLocalLoginPresent()` function to fail-loud on missing external login before spawn
  - Comprehensive test coverage for both profile-based and config-based spawn paths
  - VSCode UI integration for "Use my existing Codex login" option
  - Documentation explaining both bearer-injection (Claude Code) and file-based (Codex/Gemini) shapes

- 2ef3bd1: Add native `@agentproto/adapter-gemini` AIP-45 adapter for Google's Gemini CLI in ACP mode, with file-based subscription auth ("use my existing Gemini login" via ~/.gemini/oauth_creds.json). Includes comprehensive spawn and auth resolution tests, VSCode profile flow integration, and catalog entry.
- 1f1bc8a: Refactor spawn picker to harness-first drill-down with quick-entry support. Fixes combinatorial picker explosion by collapsing product×route combinations into one row per product on its best route, then narrowing model selection by chosen harness. Quick-entry picker shows saved favorites and recent spawn combos for power users; falls back to harness drill-down for new users. Includes manifest fallback for old daemons without `/catalog/models`.
- a88a78b: Fix model routing for multi-vendor gateways (OpenRouter/Requesty) by introducing route-identity suffixes. Add bare-product curation tolerance for existing allowlists on direct routes. Export a new `@agentproto/runtime/catalog-models` subpath for the vscode picker's unroutable-model warning.
- c0bcb04: **fix(vscode):** Improve auth profile command UX by renaming "Configure Auth Profile" to "Add Auth Profile" with a plus icon, and dedupe the refresh button from views with dedicated refresh commands.
- 4c441a3: Add Local Router UI and daemon client methods for endpoint lifecycle control. The Local Router appears as a top-level tree node in the auth profiles view, showing the daemon-supervised `@agentproto/llm-endpoint` proxy sidecar's lifecycle status (running, starting, stopped, error). Users can start/stop the proxy via context menu, and when running & healthy, the tree expands to show discovered models with catalog pricing cross-referenced. Three new daemon MCP verbs enable this: `llm_endpoint_status`, `llm_endpoint_start`, and `llm_endpoint_stop`.
- 04f495f: Add `keepAlive` flag to allow sessions to opt out of idle-reaper auto-retirement. Sessions with `keepAlive: true` are never reaped regardless of idle time, useful for supervisors that legitimately park waiting on children or scheduled wakes. Configurable at spawn time via `agent_start`'s `keepAlive` parameter or toggled later with the new `session_set_keepalive` MCP tool. Persists across daemon restarts.
- 4e8640f: Implement restart-scheduler (PR-2 of crash-detect chantier): opt-in automatic restart for agent sessions that crash unexpectedly. Introduces RestartPolicy per-session configuration with exponential backoff and rolling-window crash-loop cap. Event-driven scheduling evaluates policy on session:exited; periodic sweep executes due restarts via in-place resume. Persists state so daemon restart mid-backoff preserves schedule. Includes comprehensive test suite and proper lifecycle integration.
- ddf0788: Support pinned `@route` suffixes in model references: enhance `currentRouteOf()` to prioritize the model ref's own explicit route over a stale `route.gateway` field, ensuring correct eligibility checks and profile selection when the same model is reachable via multiple billing endpoints.
- ec33fd9: Webview sessions list now uses the tree's fine-grained `activityFor` classifier to distinguish working/idle/stalled sessions and provide more granular filtering options, eliminating disagreement between views.
- 29042ca: Generate OpenCode model menu from shared provider catalog; add model-derived API key auth support and router-prefixed model ID handling across runtime and VS Code configuration UI.
- cce3546: ## Progressive Sessions Webview Loading

  Introduces a new `GET /sessions/summaries` endpoint on the runtime that returns lightweight `SessionSummary` projections with pagination support. The VS Code Sessions webview now uses this endpoint to load the first page (50 summaries) instantly, then offers a "Load more" affordance for older sessions, improving first-paint performance when the daemon holds hundreds of sessions.

  ### Runtime (@agentproto/runtime)
  - Added `SessionSummary` interface — a lightweight projection of `SessionDescriptor` excluding large resume/transcript/policy context
  - Added `listSummaries()` method to `SessionsRegistry` with `limit`/`offset` pagination
  - Added `GET /sessions/summaries` HTTP endpoint

  ### VS Code Extension (agentproto-vscode)
  - Refactored Sessions webview to consume `SessionSummary` instead of full `SessionDescriptor`
  - Implemented progressive loading: bounded first page + "Load more" button
  - Pending optimistic rows merged from store on each render for instant spawn feedback
  - Intelligent refresh: re-fetches the currently loaded slice on SessionStore changes
  - Removed workspace dropdown filter (simplification for paginated model)

  ### Sandbox Box (@agentproto/sandbox-box)
  - Fixed flaky test: strip ANSI color codes from stdout when `FORCE_COLOR=1` is set

- 04aedad: Weekly dependency bump with semver-safe minor/patch updates across 18 packages. Includes Mastra ecosystem update (1.31-1.48.x → 1.52.1), Claude SDK patch (0.3.200 → 0.3.220), build tool updates (turbo, tsx), and general dependency maintenance (yaml, ws, react, etc.). All changes verified to pass build, test, and type checks.
- 837d4ee: Auth Settings webview now distinguishes the curated model count from the total catalog-available count and the runnable count, and surfaces data-supported reasons (e.g. "curated out") when models are unavailable. Native `xai` and `xai-anthropic` profiles remain scoped to their own routes and do not cross-qualify.
- Updated dependencies [c736c02]
- Updated dependencies [d94680f]
- Updated dependencies [bb63cf2]
- Updated dependencies [15e15db]
- Updated dependencies [9bb814f]
- Updated dependencies [96b22d5]
- Updated dependencies [6a0a60c]
- Updated dependencies [636a01b]
- Updated dependencies [e9900a2]
- Updated dependencies [013e7b3]
- Updated dependencies [2ec1af8]
- Updated dependencies [bd79483]
- Updated dependencies [8367648]
- Updated dependencies [93e6309]
- Updated dependencies [0a165ee]
- Updated dependencies [e433dde]
- Updated dependencies [70ee0db]
- Updated dependencies [d10ed02]
- Updated dependencies [831d4f5]
- Updated dependencies [b04dba5]
- Updated dependencies [d90fdc0]
- Updated dependencies [6ff42b4]
- Updated dependencies [7e78a37]
- Updated dependencies [a3deef9]
- Updated dependencies [61b23e0]
- Updated dependencies [3948ef9]
- Updated dependencies [10f9091]
- Updated dependencies [4566930]
- Updated dependencies [75c9c90]
- Updated dependencies [443507d]
- Updated dependencies [fea103e]
- Updated dependencies [fa2e0c9]
- Updated dependencies [b55c58d]
- Updated dependencies [190a6ed]
- Updated dependencies [e44385b]
- Updated dependencies [93e21ea]
- Updated dependencies [589dc04]
- Updated dependencies [d3f6f85]
- Updated dependencies [f669026]
- Updated dependencies [64db0fb]
- Updated dependencies [2efea7d]
- Updated dependencies [8a76cc9]
- Updated dependencies [8f5e5cd]
- Updated dependencies [645279d]
- Updated dependencies [6c1948d]
- Updated dependencies [7b0d7e7]
- Updated dependencies [5ba2032]
- Updated dependencies [ca4b091]
- Updated dependencies [23c5d28]
- Updated dependencies [0515531]
- Updated dependencies [4dbd028]
- Updated dependencies [c506d87]
- Updated dependencies [dfe8023]
- Updated dependencies [3c0ef25]
- Updated dependencies [7f28982]
- Updated dependencies [3f3333a]
- Updated dependencies [230f378]
- Updated dependencies [392021a]
- Updated dependencies [bd24703]
- Updated dependencies [173cff1]
- Updated dependencies [17b503a]
- Updated dependencies [1470be9]
- Updated dependencies [6ff5175]
- Updated dependencies [9d56fa2]
- Updated dependencies [9b1736d]
- Updated dependencies [47dae30]
- Updated dependencies [7465b6c]
- Updated dependencies [05f85ac]
- Updated dependencies [8d20b7e]
- Updated dependencies [242df33]
- Updated dependencies [3865de6]
- Updated dependencies [4d200a9]
- Updated dependencies [14d29fe]
- Updated dependencies [2ef3bd1]
- Updated dependencies [f3f5e82]
- Updated dependencies [70bfab0]
- Updated dependencies [f3f5e82]
- Updated dependencies [5becedc]
- Updated dependencies [babc42d]
- Updated dependencies [23fa73e]
- Updated dependencies [ff9c348]
- Updated dependencies [655b4b6]
- Updated dependencies [281eb5f]
- Updated dependencies [a88a78b]
- Updated dependencies [1cbb910]
- Updated dependencies [358af0e]
- Updated dependencies [7e47007]
- Updated dependencies [2627fe1]
- Updated dependencies [f1484a4]
- Updated dependencies [0f10338]
- Updated dependencies [924cbf6]
- Updated dependencies [04f495f]
- Updated dependencies [91741b3]
- Updated dependencies [4e8640f]
- Updated dependencies [469bc47]
- Updated dependencies [9de8157]
- Updated dependencies [f3b54ad]
- Updated dependencies [e81ad25]
- Updated dependencies [511ce04]
- Updated dependencies [15abbee]
- Updated dependencies [40d6a42]
- Updated dependencies [ec5f64f]
- Updated dependencies [33221ac]
- Updated dependencies [3088e23]
- Updated dependencies [b373165]
- Updated dependencies [42f1217]
- Updated dependencies [d9b4721]
- Updated dependencies [2f246ba]
- Updated dependencies [f1b9828]
- Updated dependencies [4bdea9f]
- Updated dependencies [29042ca]
- Updated dependencies [cce3546]
- Updated dependencies [04aedad]
- Updated dependencies [bcbb6f0]
- Updated dependencies [77e93e5]
- Updated dependencies [68ef7fb]
- Updated dependencies [329ef7a]
- Updated dependencies [4832ced]
- Updated dependencies [b3e1648]
- Updated dependencies [bd79483]
- Updated dependencies [3123238]
  - @agentproto/runtime@2.0.0

## 0.2.0

### Minor Changes

- d14fc55: Add per-window workspace pinning feature to prevent the daemon's global `active` workspace from being mutated across VS Code windows. Includes new `agentproto.selectWorkspace` command, status bar indicator, and spawn wizard integration.
- ed0c269: Add terminal input endpoint and UI toggle for conversation/terminal view switching.
  - HTTP endpoint `POST /sessions/:id/terminal/input` for writing raw input to PTY sessions (FIX 2)
  - DaemonClient method `writeTerminalInput` for terminal input requests
  - VSCode UI: Conversation⇄Terminal segmented toggle for sessions with both representations
  - Routing: Terminal sessions now use `writeTerminalInput` instead of `prompt` endpoint
  - View toggle logic for agent-cli and native-conversation PTY sessions

- 4632ec7: Session management feature set: terminal input routing via POST /sessions/:id/terminal/input, session renaming via PATCH /sessions/:id and session_rename MCP tool, explicit --title flag for spawn, and structured↔terminal view toggle for dual-representation sessions. Includes code-point-aware name truncation, field-independent rename operations, and comprehensive test coverage.
- acd978d: Cut the VS Code extension stable Marketplace release to catch up with the features accumulated on `main` since v0.1.2: mid-session model switch from the conversation panel, capability-resolved session-config picker, workspace-grouped sessions panel with a create-workspace CTA, continuous restart-history transcript with resumed-from dedupe, archivable terminal sessions, and workspace-registry mutation over HTTP.

  The pre-release channel (`vscode-release.yml`, per push) already shipped these; the extension is `private` and excluded from the reviewer's auto-changeset on purpose, so the stable channel is cut deliberately rather than on every push. This is that deliberate cut.

## 0.1.2

### Patch Changes

- d29d7fb: Re-resolve daemon bearer on stale-token 401 and fix token resolution order

## 0.1.1

### Minor Changes

- bbc5070: Composer: stop button, and prompt history on ↑/↓
- 702cb00: Composer: drag-and-drop, `@file` mentions, and attachment chips
- 67dda1f: Composer: paste an image straight into the transcript
- 9cf0cd8: Collapse the transcript header to one line
- 90bc763: Render a step as a row rather than a box
- dee0923: Let the stop confirmation be dismissed for good
- 41e46b7: The transcript tab wears the read-receipt too

### Patch Changes

- 6a8b548: Fix Stop painted as crash; replace lifecycle with activity axis in tree icons and status bar
- 6fda931: Fix sidebar: auto-refresh on clock, unread dot read-receipt, optimistic spawn row
- 5a7ed25: Fix a reaped-after-finishing subagent reading as stopped rather than complete
- 9cec8c5: Fix picking claude-sdk's kimi-k2.7-code spawning against real Anthropic
- bf23320: Fix emphasis failing to span a code span in the transcript renderer
- 8f8d048: Fix VSIX packaging and auto-publish to the Marketplace

## 0.1.0

### Minor Changes

- af7ab1f: Fix transcript-writer seq collision after daemon restart; add structured VS Code conversation rendering
- eaa33b5: Add sessions tree filters/search/grouping, workspace autodetect on spawn, and session restart via MCP
- f913b43: Add agentproto.openTerminal — real Pseudoterminal mirror for PTY and agent-cli sessions

### Patch Changes

- c430b9f: Harden SSE reconnect sleep cancellation, poll-loop disposal guards, and webview hydration
- 4fce66e: Add pack registry, tool-header wildcard filtering, and vscode VSIX packaging script
