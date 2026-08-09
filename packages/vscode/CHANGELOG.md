# agentproto-vscode

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
