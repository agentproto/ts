# @agentproto/apps

## 0.22.0

### Minor Changes

- f3665ea: session-steward is now a three-step pipeline. `agentproto steward classify` writes a persisted snapshot (rules plus the Jev typed verdict, one recommended action per session from the closed set keep, mark-complete, mark-failed, relaunch, needs-input, close-abandoned, archive). `steward analyze` (or `classify --llm`) adds an LLM pass over the relevant sessions only (reason, question, errorKind, nextStep, relaunchHint). `steward act <snapshotId|latest>` applies the snapshot as a dry run by default, with a per-session staleness re-check, origin bounds, and custom rules from `.agentproto/steward-rules.yaml` or `--rules`. Bare `steward --apply` stays the one-shot.

  `relaunch` is recommended only for work that is not superseded by a later session of the same task, not owned by a workflow/gate/review/cron run, and failed within `--relaunch-window` (default 6h, rules key `failedMinutesAgo`); the rest are `mark-failed` with the reason.

  Fixes: a rule verdict for a stuck session now applies instead of being refused as `ambiguous_needs_judge`, and refusals say why; `model-bench` and other machine origins are no longer treated as user sessions. Session outcomes now carry `reason`, `question`, `errorKind`, `nextStep` and `by`, written by `act` and by `agentproto sessions stop --outcome --reason --error-kind --next-step`. The steward reads sessions through a `fields` projection with filters and pagination instead of `session_list {full:true}`, so hourly runs no longer persist the whole registry as a step output.

### Patch Changes

- 1195dd6: Sessions past the boot-history cap are reachable again, and review/workflow noise is grouped.

  **Cold history fallback.** `HISTORY_CAP` bounds how many sessions the registry reinflates at boot; older ones kept their `index.json` sidecar and `events.jsonl` transcript but no tool could return them. `session_list` now serves them with `includeCold: true` (and automatically when a `q` matches nothing live), `session_search` searches them the same way, `session_recap` recaps a cold id, and `conversation_read` resolves a registry miss from disk — enriched by the `conversations.jsonl` link index so the conversation-id ladder binds exactly instead of searching by cwd. Cold rows are terminal records (`pid: null`, `alive: false`, flagged `cold: true`), honour every filter exactly like live rows, are never merged into a non-empty live result, and are skipped for a subtree-scoped caller. Backed by a 30s-TTL scan cache (`session-cold-list.ts`). `session_search`'s cursor also stops returning an empty page 2: the handler no longer pre-slices the rows the `paginated` transformer pages over.

  **Noise-first eviction.** `loadHistorySnapshot` now spends `HISTORY_CAP` per lane — real sessions first, `review:*`/`wf:*` rows last — so a host that blew past the cap on gate-review traffic keeps its real history instead of silently evicting it under the flood.

  **Review grouping.** `session_tree` and the live-session widget's `app_session_tree` collapse review-lane / workflow-stage ROOTS under one synthetic parent per checkout (`{ id: 'reviews:<key>', label: 'reviews · <key>', synthetic: true, children }`, keyed by worktree basename else workspace slug). The node is flagged `synthetic: true` — not a session, never focusable — and the widget renders it as a group header. `byOrigin` is derived from the grouped tree so the companion view mirrors it.

  **Filters.** `session_list` (and `GET /sessions`) gain `label` (exact, case-insensitive) and `cwd` (boundary-aware path prefix); the CLI mirrors them as `--label` / `--cwd`.

- Updated dependencies [0e8cd2d]
  - @agentproto/app-kit@1.7.3

## 0.21.2

### Patch Changes

- 86f43d7: Session steward: a PR is not proof a session is finished. A would-be `done` close is now downgraded to a flag (`needs-input`) when the last assistant message asks the user a question, announces a next action or leaves work pending — this includes the `parentEnded` path that closed children holding an open question to a dead parent. The terminal-session relabel gains `needs-follow-up` (open PR still awaiting review/merge) and PR numbers are repo-qualified (`owner/repo#N`). The loop rule no longer counts recursive `rg`/`grep` over a directory as a repeated file read, and the zero-candidate report breaks exclusions down per reason.

  Runtime: `session_wrapup_plan` evidence carries `worktree.pr` state (`open`/`merged`/`closed`) and a `worktreePrOpen` signal; a fresh `starting` session that is not stuck is kept instead of sent to the judge.

  Workflow loader: the workflow entry's relative imports are versioned with the entry (`agentproto_v`), so editing a helper next to `entry.mjs` is picked up on the next run instead of being served from Node's module cache.
  - @agentproto/app-kit@1.7.2

## 0.21.1

### Patch Changes

- eee0a3c: Fix the repo-maintenance `maintain` workflow's held-worktree review (0.21.0) never queuing anything. `reviewableWorktrees` read `tree.state`, but the daemon's `worktree_gc` tool flattens the tree to a bare string (`tree: "clean"`), so every idle worktree was silently dropped: a live run on agentproto/ts queued 0 of the eligible held worktrees. It now reads both shapes. The tests use the daemon's real projection, and the real-runner test feeds its output through `reviewableWorktrees`.
- 60a1fd2: Session steward: keepAlive sessions idle past `keepAliveAskAfterMinutes` with a merged or clean worktree can now be asked and closed on a declared DONE. Runtime: added tests covering this.
- 60a1fd2: Session steward: a `keepAlive` session can now be closed. With `askSessions`, a keepAlive session whose worktree is merged or clean (nothing uncommitted, nothing ahead of base) is asked `STEWARD: DONE / NOT-DONE` like any other idle session, and a declared DONE closes it through `session_wrapup_apply`. Before, `buildAskQueue` skipped every keepAlive session, so an idle keepAlive session stayed `judge` forever whenever Jev stayed under `minConfidence`. Closing is an active act, so an on-demand run (`agentproto steward --ask-sessions`) applies no idle delay beyond `--idle`. Only a scheduled run (new `recurring` input, set by the hourly routine) waits `keepAliveAskAfterMinutes` (new input, default 1440, 0 disables), so a session its owner meant to resume is not closed overnight. keepAlive keeps meaning "re-light after a daemon restart"; an unknown worktree, uncommitted work or unmerged commits keep the session out.
- Updated dependencies [68c5ce6]
  - @agentproto/app-kit@1.7.1

## 0.21.0

### Minor Changes

- 1645a51: The repo-maintenance `maintain` workflow now also reviews branches held only because they're checked out in an idle, clean linked worktree with no open PR (tip at least 3 days old). Until now `worktree_gc` held such a worktree because its branch wasn't provably merged, and `branch_gc` held the branch because a worktree had it checked out, so an abandoned worktree was never reviewed and stayed forever. These branches now join the existing reviewer queue (same small/large model roles, verdict store, re-prompt and retry). The reviewer prompt says why the branch was held. The report gains a "Held worktrees reviewed" section listing each verdict, plus the `agentproto worktree rm <path>` command when the reviewer agreed nothing of value is lost. Nothing is removed automatically. The new `reviewHeldWorktrees` input (default `true`) turns it off.
- 2e7d918: App Store panel: add an app detail view, icons and search. Clicking a card title or icon opens `?app=<appId>` (pushState/popstate, "← Back to store") showing icon, publisher, version and update badge, license, tier, size, origin/catalog (+ stale), requires, pinned source, install/data dirs (with a missing-dir warning), agents, workflows and the last 10 runs, with Install (existing two-step confirmation), Update, Uninstall and Open. A Copy block gives the equivalent CLI commands and the exact `app_install` MCP arguments (builtins show their MCP tool id / resource URI instead). Cards show the catalog `icon` and fall back to an initial-letter tile when the image is missing, unsafe or blocked by the host's CSP. A search box (name / appId / description / publisher) and category chips filter every section, with state in `?q=` / `?cat=` and an empty-result message. History writes refused by a host iframe degrade to in-panel navigation.

### Patch Changes

- 6cf7140: Every shipped `worktree_gc` caller now gets the real result instead of a background jobId. Without `wait: true`, the tool falls back to a background job after its 25 s default `waitMs` and returns only `{ jobId, status: "running" }`. On a repo with dozens of worktrees:

  - The repo-maintenance `maintain` workflow counted "0 worktree(s) classified", and an `applyMerged: true` apply ran in the background, unreported, after the workflow had finished. Both of its `worktree_gc` steps now pass `wait: true`.
  - The `worktree-gc-notify` workflow reported no outcomes. Its `gc` step now passes `wait: true`.
  - A `worktree-gc` routine cron run recorded the bare jobId as success, so a failed apply never reached `on_failure`. The routine template now passes `wait: true`.
  - The ops panel's Worktrees card showed "0 reclaim … (no linked worktrees)". It now polls `worktree_gc_status` (added to the panel's tool allowlist) until the plan lands, and shows a failed job as an error.

  `branch_gc` already blocks by default and is unchanged.

- 754a694: session-steward: `workflow` (workflow-step sessions) and `review` (reviewer lanes) are now closable origins by default. They are one-shot sessions spawned by the engine, never by a human, but an unrecognized root origin was treated as user-origin and therefore flag-only, so finished ones piled up. Still gated by idle time and a confident `done`/`abandoned` verdict.
- 6a86cd8: The `session-steward` workflow's two `session_wrapup_apply` steps (`autoApplyOne`, `judgedApplyOne`) now pass `wait: true`. Without it the tool falls back to a background job after its 25 s default `waitMs` and returns only `{ jobId, status: "running" }`. A slow close then came back as that bare jobId, and the report showed no outcome for a session that was in fact closed.
- ef1fb49: Fix the builtin App Store panel showing "No apps installed, and the app catalog is empty" when opened standalone at `/apps/@agentproto/store/ui`. The standalone `tool-call` route wraps a builtin tool's MCP result a second time, and the panel bridge's `callTool` peeled only one layer. It now unwraps nested envelopes recursively, honours `isError` at every layer, and returns non-JSON text as a string, which fixes every builtin panel opened standalone. The store lists builtin panels from the catalog's `category: "builtin"` rows (open by default, each with an Open button, never counted as Available or toward the empty state), and its status bar shows installed / available / builtin counts. `@agentproto/runtime` only gains a comment on the double-wrap; the wire shape is unchanged.
- Updated dependencies [b7ddf13]
  - @agentproto/app-kit@1.7.0

## 0.20.3

### Patch Changes

- 9aed05d: Repo maintenance: reviewers spawn again. A workflow agent step started in a review worktree (`branch_gc_review_worktree`) now gets that worktree and its repo's git dir as read-only zones, so `reviewOne` passes the app boundary check and git can read the branch under the OS sandbox. Before, every reviewer was refused with `app_boundary_cwd_outside` and the run recorded no verdicts. A look-alike directory in the review root is still refused. The maintain report also groups one failure that hit several branches as a single reason. `agentproto workflow status` prints step labels. Compact `workflow_status` folds repeated circuit-open skips into one row and caps large run outputs.
- 5733913: Docs: update CLI app verb list, session-steward workflow rule text, and VS Code README (App Store entry point).
- dad18f3: Session steward: errored sessions are no longer auto-closed as done, relabel proposes `unknown` instead of `abandoned` without PR evidence, and loop detection ignores anonymous calls and reads the file after the read verb.
- 70b8e9c: Session steward: a dry run (`apply: false`) no longer appends verdict memory to the `app_state` ledger, so its verdicts cannot be served from cache to a later real pass; the report says the memory was read but not written.
- Updated dependencies [0ea7fe9]
  - @agentproto/app-kit@1.6.2

## 0.20.2

### Patch Changes

- fdaaf7d: Remove every link to the retired cli.agentproto.sh host. The `PAIR_WEB_URL` export is removed from secrets and pair-client (breaking). The daemon no longer trusts the cli.agentproto.sh origin by default, and `remote_enable` only returns a `phoneUrl` when `@agentik/session-chat` is installed. The session-story panel's full-panel link now opens the daemon's live-session panel.
- fdaaf7d: Remove every link to the retired cli.agentproto.sh host. `PAIR_WEB_URL` (the opt-in shared pair page on that host) is no longer exported; the default per-daemon pair page is unchanged, and a self-hosted shared page still works through `pairing.pairPage` / `--pair-page`. The daemon no longer trusts the `https://cli.agentproto.sh` origin by default. `remote_enable` only returns a `phoneUrl` when the `@agentik/session-chat` app is installed (there is no hosted panel fallback anymore; pair a phone through rendezvous with `agentproto pair offer --qr`). The session-story panel's "panneau complet" link now opens the daemon's own live-session panel for that session, and is hidden when the panel is not served by the daemon.
- 11d503f: The session-chat launcher allowlists `session_artifact_add`, `session_artifact_list`, `session_artifact_get` and `session_artifact_pin`, so the chat can create, list, open and pin session artifacts through its UI bridge.
- baebdce: session-steward: the "terminal sessions missing an outcome" proposals now use real evidence instead of always falling back to `abandoned`. A session whose list row records an opened PR (`openedPrs` / `outcome.artifacts`) is proposed `done` with the PR in the reason (`PR #1738 merged`, `PRs #1738, #1740 opened`); a merged worktree/PR or an open PR seen through `session_evidence` is proposed `done` too. That lookup runs only for the newest 20 listed sessions; the rest stay `abandoned`.
- Updated dependencies [8e87002]
  - @agentproto/app-kit@1.6.1

## 0.20.1

### Patch Changes

- 1130a2d: App Store empty states and catalog verbs. `agentproto app install @scope/name` installs the daemon catalog entry's pinned source (an existing path still wins). New `agentproto app catalog`, `app uninstall`, `app update` and `app store` verbs, and `app list` points at the store when nothing is installed. The VS Code apps view offers "Browse the App Store" instead of a dead end, the session-chat launcher shows a working install command plus an absolute App Store deep link, and onboarding proposes featured catalog apps (opt-in, skipped offline).
- 1130a2d: App Store empty states and catalog verbs: `app install @scope/name`, `app catalog`, `app uninstall`, `app update`, `app store`; session-chat App Store deep link; VS Code apps view welcome state.
- 9018b92: session-steward: a 0-token session is only "never ran" (stuck) when it is not busy, not starting/provisioning, has no queued first prompt, and is both older and idler than `idleMinutes` (a just-started busy session used to be flagged), and the "terminal sessions missing an outcome" section now lists only sessions that ended within the new `relabelWindowHours` input (default 24), at most 20 newest first, with a per-label count and an "… and N more" line instead of hundreds of lines.

## 0.20.0

### Minor Changes

- f3e06dc: Add the App Store builtin panel (`@agentproto/store`, tool `agentproto_store`): the browse/install surface over `app_catalog` / `app_list` / `app_updates`, with confirmed installs (`app_install` issued from an app panel's tool-call surface now answers a `{needsConfirmation}` preview first and installs only on a second call echoing the preview's `confirm` token; direct MCP/CLI calls are unchanged), `app_resync` / `app_uninstall` actions, install-from-URL, catalog sources warnings, builtin panels, and `GET /store` redirecting to `/apps/@agentproto/store/ui` with the query preserved. VS Code: `agentproto.openStore` command.

### Patch Changes

- 3ea7d79: session-steward: the workflow now reads the un-paged `{sessions}` shape from `session_list` (a dry run over 545 sessions used to report "0 live, 0 terminal"), defaults its verdict-memory `appId` to the installed `@agentproto/session-steward` (resolved through `app_list`, so a missing app turns memory off with a report note instead of failing a step; `appId: ""` really disables it), and waits for `session_wrapup_plan` instead of accepting the `{jobId}` fallback.

## 0.19.0

### Minor Changes

- 58d5a41: Surface silent provider stream errors as turn errors. `@agentproto/driver-agent-cli` adds a stderr logfmt parser (`parseStderrStreamError`, `_onStderrLine` push subscription) so opencode's silent 429/usage-cap retry loop surfaces as a turn error instead of a hung session, and the opencode adapter spawns with `--print-logs --log-level ERROR`. `@agentproto/runtime` exports `NO_OUTPUT_STALL_TURN_ERROR` (new export ⇒ minor) and attaches it via the stall watchdog for zero-output turns. `@agentproto/apps` (session-steward) gains the `session-steward` skill, a session snapshot script, and APP.md skill wiring.
- ef89993: Session steward: port the `kill-idle-sessions` cron prototype's mechanical
  rules into pure, unit-tested functions wired into the workflow — loop
  detection, stall, never-ran, fast-path done, terminal relabel, self-exclusion,
  apply-time re-check, explicit 0-candidate reporting, host-saturation header,
  and verdict memory in `app_state` — and enrich `session_evidence` (origin,
  outcome, tool stats, last tool call, tokens, live children, previous verdict)
  with a rewritten concrete-signal wrap-up verdict criteria. Loop/stall nudges
  are reported only, never sent; user-origin sessions are never nudged or closed.
- 41917fd: feat(review): per-lane reviewer fallback. An agent check may declare `fallbackPresets: [...]` (also on a `uses[]` entry and in `uses[].overrides.<id>`); when the lane's reviewer is unavailable — spawn failure, a turn that ends in an error, an empty turn, or a session that exits early, after the per-preset retries — the lane runs on the next preset instead of settling `skipped`. Never after a verdict (a `block` is final), a timeout, a cancel, or an OpenRouter refusal; the chain shares the lane's single `timeoutMs`. The lane records the reviewer that actually ran (`preset`/`model`/`sessionId`) plus `fallbacks: [{ preset, error }]` for each unavailable one, shown in `agentproto review` output and the review panel; an exhausted chain settles the lane `skipped` listing every error.

### Patch Changes

- 2049adb: Bound the session-steward's apply by session origin: a pure origin policy (`origin-policy.mjs`) classifies each candidate as user-origin (chat-starter, vscode, or a root with no origin and no parent — flag-only, never closed) or closable (cron:*, gate, executors), configured by new `userOrigins` / `closableOrigins` workflow inputs. `SessionWrapupEntry` carries `origin` / `parentSessionId` through, and the steward report gains an `origin` column with the retained action.
- 2049adb: Bound the session-steward's apply by session origin: a pure origin policy (`origin-policy.mjs`) classifies each candidate as user-origin (chat-starter, vscode, or a root with no origin and no parent — flag-only, never closed) or closable (cron:*, gate, executors), configured by new `userOrigins` / `closableOrigins` workflow inputs. `SessionWrapupEntry` carries `origin` / `parentSessionId` through, and the steward report gains an `origin` column with the retained action.
- 205bade: `agentproto steward` goes back to the end-of-session wrap-up as its default:
  judge idle agent sessions, then close or flag them (dry run unless `--apply`).
  The attention-digest workflow (`session-attention`) and its `--wrapup` /
  `--include-children` / `--format` flags are removed from the open-source
  steward; the open-source steward keeps the minimal idle / done / errored policy
  with explicit close.
- Updated dependencies [1487de1]
- Updated dependencies [c72bbd4]
- Updated dependencies [530c3ec]
  - @agentproto/app-kit@1.6.0

## 0.18.0

### Minor Changes

- a878968: OpenAI MCP-extensions carriage (W-B): `AgnoMcpApp` gains an optional namespaced
  `openai` descriptor (§3.2 tool/resource metadata + icons); `performInstall`
  carries the app-kit-normalized `ui.extensions.openai` through `InstalledApp.ui`
  structurally; `registerMcpApps` serializes the declared entrypoints and icons
  under the generated UI tool's `_meta["openai/ui"]` and the display
  available/preferred modes under the `ui://` resource's `_meta["openai/ui"]`;
  `registerUiResource` accepts extra namespaced `meta` refused for the canonical
  `ui` key. Apps without `ui.extensions.openai` install and serve byte-identically.

## 0.17.2

### Patch Changes

- Updated dependencies [eb3d4d5]
  - @agentproto/app-kit@1.5.0

## 0.17.1

### Patch Changes

- c0101dd: Fix the session-steward agent judge lane: the `judgeOne` step forced `cwd: tmpdir()`, which lies outside the app boundary's readable zones, so every agent judge spawn was refused (`app_boundary_cwd_outside`) and judged candidates silently fell back to verdict `active`. Dropping the explicit `cwd` lets the agent host fall back to the run cwd (the app root), which is inside the boundary.
  - @agentproto/app-kit@1.4.1

## 0.17.0

### Minor Changes

- b63c311: Model roles: one config for which model the reviewers and judges use. The daemon config gains a `models` map (role → model id, or `{ model, route?, profile? }`), resolved as explicit input > repo `agentproto.json` `models` > daemon config `models` > built-in default (`DEFAULT_MODEL_ROLES`: `review.small`, `review.large`, `review.pr`, `judge.session`). `config_set models.<role>` warns (does not block) on a model id the catalog does not know, `config_get` lists the roles, and the new read-only `model_roles` tool reports each role's resolved model and source. An AGENT.md `model: role:<name>` is resolved before adapter selection and `app_run` spawn. The repo-maintenance `maintain` workflow (`reviewModelSmall`/`reviewModelLarge`) and the session-steward (`judgeModel`) now default to their roles instead of hard-coded ids; explicit inputs still win.
- a48ec1f: New `session-steward` built-in app: a workflow that classifies idle agent sessions, closes rule-certain ones, judges the ambiguous ones (Jev when `JEV_API_KEY` resolves, else a one-shot agent judge), and closes or flags only confident verdicts — a dry run by default. `@agentproto/cli` adds the `agentproto steward` command over it. `@agentproto/runtime` adds the read-only `session_evidence` and `session_judge_jev` MCP tools plus the exported `jev-client` and `session-evidence` modules behind them.

### Patch Changes

- 51561f3: Model roles no longer default to Haiku: `review.small` and `judge.session` now default to `claude-sonnet-5-5`, and `review.large` (and the retry reviewer) to `claude-opus-5-5`. Override any role via `models` in `agentproto.json` / the daemon config as before.
- 461df5e: Package-metadata refresh accompanying the vendored-specs resync (PR #1554): homepage URLs and keyword tags renumbered to the ratified AIP numbers (app-kit/apps → AIP-53, mastra → AIP-52, define-doctype → AIP-56, wallet → AIP-49), a stale agentik.net homepage corrected (redaction), new keyword tags (pair-client → AIP-59, runtime → AIP-46/AIP-58), and test/doc-comment updates replacing the retired sandbox AIP-61 placeholder with a 9999 fixture number (product, ref), plus bundled SKILL.md renumbering (skill-pack-agentproto) and a routine doc comment aligned with the now-upstream `targetAgent` variant. No runtime behavior changes.
- 2973a57: repo-maintenance: the review agents (the maintain workflow's large-residual reviewer and the repo-maintenance reviewer agent) now default to `claude-sonnet-5-5` instead of `claude-sonnet-5`. Override per run with the workflow's `reviewModelLarge` input as before.

  @agentproto/runtime: test-only update asserting the new default review model id in the repo-maintenance workflow routing tests.

- Updated dependencies [d9cd5d7]
- Updated dependencies [dfeebb6]
- Updated dependencies [88f2836]
- Updated dependencies [461df5e]
- Updated dependencies [6a1bedc]
  - @agentproto/app-kit@1.4.0
  - @agentproto/app-client@0.4.1
  - @agentproto/agent@0.2.5
  - @agentproto/workflow@0.7.1

## 0.16.0

### Minor Changes

- de2decc: Review attestation signing and composition: `@agentproto/review` gains `canonicalJson`, `canonicalAttestationBytes`, and `attestationSha256` plus optional `Attestor.signature` and `LaneResult.composedFrom` fields. `@agentproto/runtime` adds `review-signing.ts` (SSH-keygen-based `signAttestation`/`verifySignedAttestation`, key management, `ReviewConfig`) and `review-compose.ts` (delta re-review composition). `@agentproto/cli` adds the `review key` subcommand and `verify --allowed-signers/--require-signed` (exit code 6). The review panel shows signed/unsigned badges.
- 6f53567: Review panel: the agent-lane reviewer-session link now deep-links the live-session widget as a real per-session URL (`/apps/@agentproto/live-session/ui?sessionId=<id>`), opened via `openLink` with a `window.open` fallback — the same convention session-chat's card link uses. Runtime's `handleAppUiPage` reads the `sessionId` query param, validates it (`isValidDeepLinkSessionId`), and bakes it into the live-session widget's `window.__APP_INIT__` so it boots already pinned to that session; invalid or absent ids are ignored and every other builtin's html is served byte-identical. `REVIEW_PANEL_UI_TOOLS` keeps only the review tools (the deep link is a navigation, not a `tools/call`), and the panel exports `liveSessionUrl`.

## 0.15.0

### Minor Changes

- b7b85d6: Join tokens (SANDBOX-VISIBILITY-JOIN): a daemon can now mint a long-lived, revocable, reusable credential (`join_token_create`/`join_token_list`/`join_token_revoke` MCP tools, `POST/GET /devices/join-tokens` + `DELETE /devices/join-tokens/:id` REST routes, `agentproto devices join-token create|list|revoke` in `@agentproto/cli`) that a box daemon reads from its `AGENTPROTO_JOIN` env var at boot to auto-register itself as a host (`HostRegistry.add`, DEVICES-PLAN PR-C) with no offer URL to relay by hand — new `createJoinTokenRegistry`/`JoinTokenRegistry` in `@agentproto/runtime`, wired into `createGateway`'s `joinTokens` option, and boot-time `AGENTPROTO_JOIN` handling in `agentproto serve`. `HostRecord`/`Device` gain optional self-reported `provider`/`sandboxId`/`labels`, set via `HostRegistry.add`'s new optional `meta` parameter. New `device_sessions` MCP tool + `GET /devices/:id/sessions[/:sessionId/output]` REST routes + `agentproto devices sessions` (and the new `DeviceRegistry.forwardHttp`/`GET /sessions/:id/output` it's built on) let one daemon read another registered host's session list and tail a session's output over the same E2E channel `/devices/:id/exec` already uses. `@agentproto/apps`'s builtin Session Chat launcher additionally allowlists `device_list`/`device_sessions` for its UI.

### Patch Changes

- 83ffc2d: Fast worktree removal (rename to same-volume `.trash` + prune + detached background delete) wired into cleanup-worktree and gc, plus `agentproto maintain --all` with repeatable `--repo` to maintain every repo owning worktrees under the worktrees root.

## 0.14.0

### Minor Changes

- eba403e: Add the read-only `capabilities_inventory` MCP tool and its `GET /capabilities/inventory` HTTP twin (shared builder in the runtime), plus exported `CapabilitiesInventory*` types. Add a Capabilities (MCP & Skills) section to the `@agentproto/config` app, including the new `capabilities` deep-link fragment section.
- 753bfc7: `review_ledger` gains `includeRunning`, `requesterSessionId`, and `subtree` (backed by a lazy, incrementally-updated ledger index, never a full re-scan), and `ReviewRunner.list()` surfaces in-flight and settled-in-this-process runs. `session_tree` nodes that requested a review now carry a `reviews` badge (latest 3, newest first). A settled review with a known requester writes a display-only `notice` into that session's transcript (never a prompt, never a wake) via the new `SessionsRegistry.recordNotice`. New builtin panel `agentproto_reviews` (`packages/apps/src/review-panel`) — a verdict list + detail view over the review ledger, mounted alongside sessions-panel/work-board, with cancel / re-run-fresh / PR-status / export actions over the existing `review_*` tools.

### Patch Changes

- Updated dependencies [afe8324]
  - @agentproto/app-kit@1.3.1

## 0.13.1

### Patch Changes

- 7f50ff6: Branch gc prunes stale remote-tracking refs (`git fetch --prune`) before classifying and reports it as `plan.fetched`; its delete pushes skip git hooks (`--no-verify`) and a refused batch is retried as a batch before falling back to one push per ref. The `maintain` workflow now applies worktree gc before branch gc.

## 0.13.0

### Minor Changes

- 4e398a9: Unify the display-mode toggle into `@agentproto/app-client/display-mode`: the panel bridge and the `window.McpApp` bridges now share one installer with host-aware placement (`safeAreaInsets`), theme support, an `optimistic` mode, and `mountToggle` for inline placement. Runtime exports `injectMcpAppBridge` / `MCP_APP_BRIDGE_SCRIPT`; the bridges expose `getHostContext` / `onHostContext` / `displayMode`.
- 54983df: Allowlist session_restart on the builtin session-chat panel
- 48da1d4: Add repo-maintenance app (maintain workflow + reviewer agent) and agentproto maintain CLI shortcut
- ea5e30d: Add typed SessionMessage envelope + session-message transcript record for inter-session reports
- eabdd3c: Add the `@agentproto/config` read-only MCP app (wallets, harnesses, models, defaults, remote, advanced) with a new `./config` subpath export, the exported `configApp` handle, and the deep-link fragment helpers `parseConfigFragment`/`buildConfigFragment`/`CONFIG_SECTIONS`.
- 219e8cf: Additive engine features for tolerant fan-outs and cleanup: a spawn circuit breaker for `map`/`pipeline` with `onError: "collect"` (`maxConsecutiveSpawnFailures`, `AgentSpawnError`, `skipped` outcomes, `onStepFailed` hook), workflow-level `finally` cleanup steps, per-step agent `cwd` resolution against the run cwd, the `branch_gc_review_worktree` tool (disposable detached review worktrees), and parallelized/memoized `merge-base` sweeps in branch gc. The maintain workflow caps reviews per run (`maxReviews`, default 40) and runs every reviewer in its own detached worktree.
- 8de3a66: Config app: add the write/edit flows — wallet lifecycle and model curation, harness preset CRUD, a generic config_get/config_set editor (defaults, per-harness defaults, titler.model), and remote/pairing lifecycle with one-time reveals; new jsdom DOM test suite.
- be22e9f: Add optional view deep-link input to app_ui_* panel tools, routed via bridge tool-input

### Patch Changes

- 65777ee: Keep the reported context window sticky: a cost-bearing usage_update's size is authoritative and no longer downgraded by later inferred frames (claude-agent-acp guesses 200k for 1M models until its first result). The daemon seeds the window from the model catalog at spawn, carries the adapter's `_claude/model` and `sizeInferred` on usage_update events, records `reportedSize` when it corrects a size, and treats a trailing `[1m]` lane hint (`claude-opus-5-5[1m]`) as an explicit window choice — not part of model identity for pricing/alias lookups.
- 5a466d6: Mount daemon /mcp gateway on workflow agent steps; fix prompt sections, map scheduling, run output persistence, maintain --wait
- 5f923bb: Durable inter-session messaging inbox (AIP-46 §Session messages): new `message_send`, `message_reply`, `inbox_list`, `inbox_ack`, `inbox_wait` tools, `POST /sessions/:id/messages` / `GET /sessions/:id/inbox` / `POST /sessions/:id/inbox/ack` HTTP routes, `sessions inbox` / `sessions message` CLI commands, and a re-routed `message_parent` through `registry.sendMessage`.
- bdb5830: repo-maintenance: missing-verdict retry ladder (same-session nudge + large-model retry) via the new read-only `branch_gc_verdict_get` tool (`BranchGcVerdictReader` port); fixed the maintain report's worktree classification counts; `tool_search` option for the claude-code adapter, auto-disabled for allowlisted agent steps; `{{index}}` support in agent-step `sessionRef` for fan-out session reuse; step session descriptors now echo the pinned model/effort.
- 8dc445b: branch_gc: reclaim merged-PR-head tips without review; review queue groups by branch name
- Updated dependencies [4e398a9]
- Updated dependencies [cd00daa]
- Updated dependencies [d6d86b6]
- Updated dependencies [6c68009]
- Updated dependencies [9a5d311]
- Updated dependencies [502f4c9]
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
