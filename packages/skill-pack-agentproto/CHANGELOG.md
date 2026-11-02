# @agentproto/skill-pack-agentproto

## 0.10.2

### Patch Changes

- e429491: Document the `auto` reviewer sandbox (computer fleet first, capped e2b overflow, plain e2b fallback) in the CI review lanes reference.

## 0.10.1

### Patch Changes

- d9a8be3: Let a cron job declare `notify: "onFailure"` so a successful `kind: "command"` run reaches followers as an `fyi` inbox entry instead of waking them. A failing command still crashes and wakes. Exposed by `cron_create`, `cron_update`, `cron_list`, `POST /cron`, `PATCH /cron/:id`, and `agentproto cron add --notify`.
- 201b612: End a clerk reaction dead when its `run.command` exits non-zero or is terminated by a signal/timeout, instead of recording a dishonest done (runtime). Document the behavior in the shipped `ap-reactions` skill guide (skill pack).

## 0.10.0

### Minor Changes

- 6a4d5c2: Add the `ap-reactions` skill (AIP-71 event routines, AGENT.md `on` maps, builtin brain-ingest and clerk reactions, `GET /reactions`) and document `dedupeKey` in `ap-prompt-agent`, with corrected guidance on the `session:clerk-pass` scope and `on`-entry retry/cooldown behavior.
- 6a4d5c2: Add the `ap-reactions` skill (event routines, AGENT.md `on` maps, `session:archive`, the opt-in brain-ingest and clerk reactions, `GET /reactions`) and document `dedupeKey` in `ap-prompt-agent`.

### Patch Changes

- 97a0074: Rename three packages to their AIP-70 names: `@agentproto/llm-endpoint` to `@agentproto/inference-endpoint` (AIP-61), `@agentproto/app-kit` to `@agentproto/app` (AIP-53) and `@agentproto/mastra` to `@agentproto/bridge` (AIP-52). The old names stay as deprecated re-export shims with the same exports, and every workspace dependency, import, test and doc points at the new names.
- 97a0074: Complete the AIP-52/AIP-53/AIP-61 batch renames: add the canonical `@agentproto/bridge`, `@agentproto/app` and `@agentproto/inference-endpoint` packages (moved from `mastra`, `app-kit` and `llm-endpoint`), keep the old names as deprecated re-export shims, and repoint every workspace dependency, import, test and doc at the new names.

  This complements the changeset already in the PR (`.changeset/aip70-p3-batch7b-renames.md`); the two are merged by changesets so each package is bumped at most once.

## 0.9.0

### Minor Changes

- c9553f7: Let a `prompt-session` cron job target an AGENT LABEL instead of a session id: `action.agent` (or the `agent:<label>` spelling in `sessionId`, from `cron_create` or `agentproto cron add --target-session agent:<label>`). The label is resolved when the job FIRES, not when it is created, so the job survives the target agent being relaunched under a new id (a restart or continue-fresh keeps the label, the id changes). Resolution picks the newest live session with that label (exact, case-insensitive), follows a retired session's successor chain, revives an ended session through the usual restart path, and otherwise fails the tick naming the label; the run result records the session id the label resolved to. Jobs that carry a plain `sessionId` keep working unchanged.

## 0.8.10

### Patch Changes

- d7f5063: Replace the stale `pb-build-app` skill with the rewritten `agentproto-apps` authoring skill (updating the manifest, README, and every cross-reference), and fix the book/react-ts/vanilla scaffold templates' invalid `cost_class: cheap` to the accepted `trivial`.
- d7f5063: Replace the stale `pb-build-app` skill with the rewritten `agentproto-apps` authoring skill, and fix the scaffold templates' invalid `cost_class: cheap` to `trivial`.

## 0.8.9

### Patch Changes

- 42dfcb1: Added `session_role_refresh` and `session_role_watch` MCP tools (AIP-42 hot role refresh): a manifest-spawned session's AGENT.md can now be re-read and applied to a live keepAlive session without a restart. A changed role (body/persona/boundaries/traits text) is pushed into the session as a steer notice telling it to adopt the new text without replying to the user; a changed `tools` list is only reported (`toolsChanged: true`), since stdio MCP servers are fixed at spawn and need an actual `session_restart` to change. `session_role_watch` is the opt-in, event-driven (fs.watch, debounced, never polling) companion that calls the refresh automatically on every AGENT.md edit — off by default. This generalizes the ad-hoc composed-prompt-hash mechanism apps like Pygmalion previously hand-rolled for their own personas. The `ap-lifecycle` skill doc now documents both tools.
- 42dfcb1: AIP-42 hot role refresh: new `session_role_refresh` and `session_role_watch` MCP tools re-read a manifest-spawned session's `AGENT.md` and apply the parts that can change in place without a restart. A changed role (body/persona/boundaries/traits text) is steered into the live session as a notice telling it to adopt the new text without replying to the user; a changed `tools` list is only reported (`toolsChanged: true`), since stdio MCP servers are fixed at spawn and need an actual `session_restart`. `session_role_watch` is the opt-in, event-driven (fs.watch, debounced) companion that refreshes automatically on each AGENT.md edit — off by default and in-memory only. The `ap-lifecycle` skill doc documents both tools.

## 0.8.8

### Patch Changes

- 68c5ce6: Document ui.renders and terminal session list pagination.
- ab367ec: Narrow `session_list` server-side instead of reading hundreds of sessions. New optional filters, shared by the MCP tool, `GET /sessions` and `agentproto sessions [list]`: `q` (substring over id/name/label/title/cwd), `excludeNoise` (drops `review:*`/`wf:*` sessions and ended command / plain-terminal runs), `excludeLabelPrefix`, `excludeLabels`, `excludeKinds`, `rootOnly`, `parentSessionId`, `updatedSince` and `startedSince` (ISO or relative, e.g. `24h`). Rows now come back newest-activity first and the response carries `total` for the filtered set. `fields` is now honoured without `limit`, and `session_list` errors are returned as tool errors. Without any filter the response only gains `total`. `paginated` in `@agentproto/tool` gains an `includeTotal` option; the long-form help moves to `tool_help {name:"session_list"}`.

## 0.8.7

### Patch Changes

- 4a833e9: Agent steps retry transport failures. A `kind: agent` step whose session dies before its first turn ends (killed or crashed mid-turn, "ACP connection closed") is re-spawned with the same prompt in the same run workspace, instead of failing the run. By default that is one retry after 1 s. A step can set `retry: { max_attempts, backoff, initial_ms }` in WORKFLOW.md, the same block gates take; `max_attempts: 1` turns it off, and a declared `retry` also covers spawn failures. A turn that ended is never retried (empty or errored reply, schema mismatch, input request), and neither is a deliberately ended session, a cancelled run or a `sessionRef` reuse. Each retry is logged as a `step.retrying` run event. New exports: `AgentSessionLostError`, `isAgentTransportFailure`, `DEFAULT_AGENT_TRANSPORT_RETRY`, and the `onAgentRetry` run hook.
- dbf571c: Documentation updates: tunnel privacy/revoke docs, OpenRouter pricing tiers, and knowledge provider supersede/explain.
- e927cb2: Docs: document tunnel private-by-default and revoke, knowledge supersede/explain, pricing tiers, and compaction checkpoint/compactRequiresOperator.

## 0.8.6

### Patch Changes

- 461df5e: Package-metadata refresh accompanying the vendored-specs resync (PR #1554): homepage URLs and keyword tags renumbered to the ratified AIP numbers (app-kit/apps → AIP-53, mastra → AIP-52, define-doctype → AIP-56, wallet → AIP-49), a stale agentik.net homepage corrected (redaction), new keyword tags (pair-client → AIP-59, runtime → AIP-46/AIP-58), and test/doc-comment updates replacing the retired sandbox AIP-61 placeholder with a 9999 fixture number (product, ref), plus bundled SKILL.md renumbering (skill-pack-agentproto) and a routine doc comment aligned with the now-upstream `targetAgent` variant. No runtime behavior changes.

## 0.8.5

### Patch Changes

- 8a29038: Add AIP-58 §6 run.retry (workflow_retry) — journal-sourced replay, no re-execution

## 0.8.4

### Patch Changes

- 4e398a9: Unify the display-mode toggle into `@agentproto/app-client/display-mode`: the panel bridge and the `window.McpApp` bridges now share one installer with host-aware placement (`safeAreaInsets`), theme support, an `optimistic` mode, and `mountToggle` for inline placement. Runtime exports `injectMcpAppBridge` / `MCP_APP_BRIDGE_SCRIPT`; the bridges expose `getHostContext` / `onHostContext` / `displayMode`.
- 6c68009: Cache tool steps, key map items by index, surface cache hits as steps
- db9b586: Docs: document inter-session messaging (`inbox_wait` supervision loop, `message_send`/`message_reply`/`inbox_*` tools, `messaging` config block) in `ap-prompt-agent` and `pb-supervise-parallel-mission` skills.
- 9a5d311: Fix branch arms to be exclusive with an explicit join (F22); untaken arms surface as step.skipped
- 502f4c9: Add AIP-58 §4 per-run workspace + artifacts (kind:"artifact", outputsFiles.required, run.publish/readArtifact)

## 0.8.3

### Patch Changes

- 39b0ac5: Queue agent_prompt/inbound routing by default instead of rejecting mid-turn

## 0.8.2

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)

## 0.8.1

### Patch Changes

- 8215419: Give installed apps a data directory distinct from their source directory. The `app_data_*` plane now anchors to `InstalledApp.dataDir` (default `<dir>/data`) rather than the app's `dir`. Custom data directories are set with `app_install {dataDir}` / `agentproto app install --data-dir`, or hinted by APP.md `data: { dir }`. Full backward compatibility: pre-dataDir files under `<appDir>` are still found via fallback; under the default layout the legacy `data/` spelling is collapsed so existing paths continue to work.

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
