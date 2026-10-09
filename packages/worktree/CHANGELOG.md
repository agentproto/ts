# @agentproto/worktree

## 0.14.5

### Patch Changes

- Updated dependencies [ab367ec]
  - @agentproto/tool@0.5.1
  - @agentproto/driver@0.3.2
  - @agentproto/workflow-runtime@0.17.1

## 0.14.4

### Patch Changes

- 5b021a8: `branch_gc` / `worktree_gc` daemon tools: smaller, truthful responses and a faster plan. `branch_gc_status` takes `classes`, `scopes`, `section`, `results`, `limit` and `cursor`, and `full: true` now returns one filtered page (default 100 rows, with `page.nextCursor`) instead of the whole 65k+ character result. An apply result carries a top-level `status` and an `applySummary` (deleted / skipped / failed per scope, plus the restore log path). A running job no longer announces a `resultPath` that does not exist yet. `terminal_sessions_list` called without `limit` is capped at 50 rows with `total` / `truncated` / `nextCursor`; `paginated()` gains a `defaultLimit` option for this. The branch gc ladder computes `git patch-id`s once per commit and reuses merge-bases instead of running `git cherry` per tip (about 2.5x faster on a 374-ref repo, identical classification).
- 6cf7140: Every shipped `worktree_gc` caller now gets the real result instead of a background jobId. Without `wait: true`, the tool falls back to a background job after its 25 s default `waitMs` and returns only `{ jobId, status: "running" }`. On a repo with dozens of worktrees:

  - The repo-maintenance `maintain` workflow counted "0 worktree(s) classified", and an `applyMerged: true` apply ran in the background, unreported, after the workflow had finished. Both of its `worktree_gc` steps now pass `wait: true`.
  - The `worktree-gc-notify` workflow reported no outcomes. Its `gc` step now passes `wait: true`.
  - A `worktree-gc` routine cron run recorded the bare jobId as success, so a failed apply never reached `on_failure`. The routine template now passes `wait: true`.
  - The ops panel's Worktrees card showed "0 reclaim … (no linked worktrees)". It now polls `worktree_gc_status` (added to the panel's tool allowlist) until the plan lands, and shows a failed job as an error.

  `branch_gc` already blocks by default and is unchanged.

- Updated dependencies [4a833e9]
- Updated dependencies [5b021a8]
- Updated dependencies [3e61035]
  - @agentproto/workflow-runtime@0.17.0
  - @agentproto/tool@0.5.0
  - @agentproto/driver@0.3.1

## 0.14.3

### Patch Changes

- Updated dependencies [2d4457e]
  - @agentproto/harness@0.5.0

## 0.14.2

### Patch Changes

- Updated dependencies [399fd2a]
  - @agentproto/harness@0.4.8

## 0.14.1

### Patch Changes

- Updated dependencies [a68d1d6]
- Updated dependencies [4243c75]
  - @agentproto/driver@0.3.0
  - @agentproto/workflow-runtime@0.16.0
  - @agentproto/tool@0.4.0

## 0.14.0

### Minor Changes

- 14e2494: Refactored branch_gc's background-job machinery into a shared `createBackgroundJobRegistry` (`background-jobs.ts`) and extended background mode + `*_status` polling to `worktree_gc` and `session_wrapup_plan`: new `worktree_gc_status` / `session_wrapup_status` tools, new optional `wait`/`waitMs` params on `worktree_gc` and `session_wrapup_plan`, and new `worktreeGcJobsDir`/`sessionWrapupJobsDir` runtime options (`@agentproto/runtime`).

  `removeWorktreeFast`'s cleanliness gate is now re-derived from git's real worktree-removal refusal rule (ignored files tolerated, untracked files refused even under `status.showUntrackedFiles=no`, locked worktrees refused), and trash deletion is serialized into a single detached deleter per pool: new exported `ensureTrashDeleter` / `WORKTREE_TRASH_PIDFILE`, new `spawnDeleter` options, and changed non-force removal-refusal semantics (`@agentproto/worktree`).

- 78cd278: feat(worktree): throttle heavy worktree provisioning through a daemon-wide FIFO queue. `depsCmd`, `cloneGlobs` and setup hooks now run at most `worktrees.provisionConcurrency` (default 2, `0` = unlimited, env `AGENTPROTO_WORKTREES_PROVISION_CONCURRENCY`) at a time, fair across callers, with optional per-repo caps and a `provisionLoadFactor` load guard. Killing a `starting` session drops its queued provisioning or terminates a running install's whole process tree and removes the half-made worktree. Sessions report `provisioning: { state, position, phase, startedAt }` in `agent_sessions_list`, `session_list` and `agentproto sessions`, and the event bus emits `session:provisioning` events.

### Patch Changes

- 88f2836: Weekly minor/patch dependency bumps across workspaces (@modelcontextprotocol/sdk 1.30.0 → 1.30.1, @anthropic-ai/claude-agent-sdk 0.3.282 → 0.3.283, turbo 2.10.12 → 2.11.5, @tauri-apps/* 2.12, @tanstack/react-query 5.104, e2b 2.51, @earendil-works/pi-tui 0.87, tsx 4.23.15, @types/vscode 1.138).
- 2b36ea0: Fix a race in the fast-remove background deleter that could leave a stale `.trash/.deleting` pid file behind. The parent used to write the pid file after spawning the deleter, so a fast deleter could drain the trash and run its EXIT trap first, leaving a permanent stale file (a stale pid could then wrongly suppress spawning a deleter after PID reuse). The deleter now writes its own pid after installing its trap, and the parent only writes a placeholder before the spawn.
- Updated dependencies [88f2836]
- Updated dependencies [036c9df]
  - @agentproto/harness@0.4.7
  - @agentproto/workflow-runtime@0.15.0
  - @agentproto/driver@0.2.5
  - @agentproto/tool@0.3.2

## 0.13.0

### Minor Changes

- 9a9a3e7: `worktree.provision` gains `cloneGlobs`: glob patterns of gitignored dirs/files (e.g. `node_modules`) cloned into the worktree before `depsCmd`, copy-on-write where the filesystem supports it (macOS `cp -Rc`, Linux `cp --reflink=auto`), falling back to a plain copy, never a symlink. New file `<repoRoot>/.agentproto/worktree.json`: a local, gitignored, host-owned config a machine can use to declare its own `depsCmd`/`linkPaths`/`copyGlobs`/`cloneGlobs`/`writeFiles` defaults (with a `{slug}` placeholder in `writeFiles`), read straight off disk rather than committed. Precedence: explicit tool input > local `worktree.json` > committed `agentproto.json`. Both `worktree.provision` and the daemon's `agent_start({worktree})` spawn path pick up the new local config automatically.

### Patch Changes

- 904f3d4: Test-only fix: disable git auto-maintenance in worktree test fixtures via a vitest setup file (GIT_CONFIG_* env overrides) plus per-repo `maintenance.auto=false` for bare origins, since `receive-pack` strips the pusher's GIT_CONFIG_* env. Prevents flaky `ENOTEMPTY` cleanup failures from `git maintenance run --auto` holding locks during afterEach teardown.

## 0.12.0

### Minor Changes

- 83ffc2d: Fast worktree removal (rename to same-volume `.trash` + prune + detached background delete) wired into cleanup-worktree and gc, plus `agentproto maintain --all` with repeatable `--repo` to maintain every repo owning worktrees under the worktrees root.

### Patch Changes

- 4ecd91b: Fix a CI-only flaky test in `lifecycle.test.ts`: generated hook scripts used `process.exit()` right after many `console.log()` calls, which can truncate stdout on a piped (non-TTY) stream before the writes flush. Switched to `process.exitCode = …` so pending output drains before exit. Test-only; no runtime behavior change.

## 0.11.0

### Minor Changes

- 8277109: Combine stdout+stderr in HookError, add setup-hook log persistence and bounded retry
- c1899d7: gc: add a narrow "plans-only" salvage rule so no-commit worktrees whose only dirt is untracked `.plans/` files archive via `--salvage-dirty` instead of holding forever; widen the default noise allowlist to lockfile and launch-config churn; hold merged+dirty worktrees with a live session in `classify`; expose the new optional `onlyUnder` field on the dirty `TreeState` variant.

### Patch Changes

- Updated dependencies [8518b3f]
  - @agentproto/workflow-runtime@0.14.0

## 0.10.0

### Minor Changes

- 7f50ff6: Branch gc prunes stale remote-tracking refs (`git fetch --prune`) before classifying and reports it as `plan.fetched`; its delete pushes skip git hooks (`--no-verify`) and a refused batch is retried as a batch before falling back to one push per ref. The `maintain` workflow now applies worktree gc before branch gc.

### Patch Changes

- 1f03bf3: `branch_gc` can run in the background (`wait: false`, or `waitMs` to block at most that long) and be polled with the new `branch_gc_status` tool, so a multi-minute plan no longer times out an MCP call. Branch gc also answers "contained in a remote ref" and "merged into base" from one `git rev-list` each instead of one git call per ref (109 s → ~78 s on a 900-ref repo).
- Updated dependencies [b0eeee7]
- Updated dependencies [8a29038]
- Updated dependencies [b9f9bb6]
  - @agentproto/workflow-runtime@0.13.1

## 0.9.0

### Minor Changes

- eaa50f8: Add `branch_gc`, the sibling of `worktree_gc` for refs. It classifies local branches, the base remote's branches and orphan tracking refs (from removed remotes) as `reclaim` (provably in base: merged, squash-merged, patch-merged or content-merged), `review` or `hold` (protected, worktree plus its remote twin, open PR, PR check unavailable, too young). It's a dry run unless you pass `apply` with explicit `scopes`. Each ref is re-classified right before it's deleted, and every apply writes a restore log. `branch_gc_verdict` stores reviewer verdicts by tip sha, so `includeReviewed` can reclaim a ref once a gate has agreed. New CLI commands: `agentproto branch gc` and `agentproto branch review-queue`; new HTTP routes: `POST /branches/gc[/verdict]`. `worktree_gc` also changes: a noise allowlist (`noisePaths`, default `.opencode/package-lock.json`), status reads that take no optional locks, and clean idle worktrees whose branch content is squash/patch/content-merged now reclaim.
- b61405e: Worktree status now carries base divergence (`dirty`/change counts, ahead/behind vs the default branch), PR web URLs built from a GitHub `origin` (including ssh host aliases), a per-session `worktree_status { sessionId }` / `GET /worktrees?sessionId=` narrow read, and new session descriptor fields `mainRepoPath` and `commandSandbox`. Adds `computeBaseDivergence`/`BaseDivergence` and `githubPrUrlBuilder` exports; `listWorktreeStatuses` accepts a `paths` filter.
- 219e8cf: Additive engine features for tolerant fan-outs and cleanup: a spawn circuit breaker for `map`/`pipeline` with `onError: "collect"` (`maxConsecutiveSpawnFailures`, `AgentSpawnError`, `skipped` outcomes, `onStepFailed` hook), workflow-level `finally` cleanup steps, per-step agent `cwd` resolution against the run cwd, the `branch_gc_review_worktree` tool (disposable detached review worktrees), and parallelized/memoized `merge-base` sweeps in branch gc. The maintain workflow caps reviews per run (`maxReviews`, default 40) and runs every reviewer in its own detached worktree.
- 8dc445b: branch_gc: reclaim merged-PR-head tips without review; review queue groups by branch name

### Patch Changes

- bdb5830: repo-maintenance: missing-verdict retry ladder (same-session nudge + large-model retry) via the new read-only `branch_gc_verdict_get` tool (`BranchGcVerdictReader` port); fixed the maintain report's worktree classification counts; `tool_search` option for the claude-code adapter, auto-disabled for allowlisted agent steps; `{{index}}` support in agent-step `sessionRef` for fan-out session reuse; step session descriptors now echo the pinned model/effort.
- Updated dependencies [c3314bd]
- Updated dependencies [cd00daa]
- Updated dependencies [7c059bc]
- Updated dependencies [582b79c]
- Updated dependencies [579227e]
- Updated dependencies [6c68009]
- Updated dependencies [1e871ec]
- Updated dependencies [5a466d6]
- Updated dependencies [9a5d311]
- Updated dependencies [bdb5830]
- Updated dependencies [219e8cf]
- Updated dependencies [502f4c9]
  - @agentproto/workflow-runtime@0.13.0
  - @agentproto/driver@0.2.4

## 0.8.1

### Patch Changes

- Updated dependencies [41b8b76]
- Updated dependencies [854db1f]
  - @agentproto/workflow-runtime@0.12.0

## 0.8.0

### Minor Changes

- 6fb4a28: Add declarative `worktree.depsCmd` and `worktree.linkPaths` to `agentproto.json`, used as fallbacks by `worktree.provision` when the corresponding tool inputs are omitted. Explicit tool inputs still win, and the `runSetup` gate now also covers the declarative `depsCmd`/`linkPaths` lifecycle.

### Patch Changes

- c27f0b8: Weekly minor/patch dependency bumps across workspaces (zod, @mastra/*, react, yaml, claude-agent-sdk, etc.).
- Updated dependencies [c27f0b8]
  - @agentproto/driver@0.2.3
  - @agentproto/harness@0.4.6
  - @agentproto/tool@0.3.1
  - @agentproto/workflow-runtime@0.11.1

## 0.7.0

### Minor Changes

- e759d6d: Classify a prunable worktree without crashing the gc plan

## 0.6.2

### Patch Changes

- Updated dependencies [c809f12]
  - @agentproto/workflow-runtime@0.11.0

## 0.6.1

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [2f37e7b]
- Updated dependencies [20ef731]
  - @agentproto/driver@0.2.2
  - @agentproto/harness@0.4.5
  - @agentproto/tool@0.3.0
  - @agentproto/workflow-runtime@0.10.1

## 0.6.0

### Minor Changes

- 80c837e: Add `writeFiles` parameter to `worktree.provision` for generating worktree-specific configuration before `depsCmd` runs. Supports `create` mode (never-clobber) and `append` mode (with automatic `skip-worktree` marking to prevent accidental commits).

### Patch Changes

- Updated dependencies [c4bff00]
- Updated dependencies [f9e21fd]
- Updated dependencies [c4ebbd3]
- Updated dependencies [a48dc03]
- Updated dependencies [1cd0220]
- Updated dependencies [ece3cae]
- Updated dependencies [e7e9261]
- Updated dependencies [a04bd29]
- Updated dependencies [fe9a374]
  - @agentproto/workflow-runtime@0.10.0
  - @agentproto/driver@0.2.1
  - @agentproto/harness@0.4.4
  - @agentproto/tool@0.2.2

## 0.5.5

### Patch Changes

- 2fc4c69: Sandboxed sessions now report their spend, and PR footers pick it up.
  - `HarnessClient.usage(sessionId)` (`session_usage`) and an optional `usage` on
    `DaemonAgentSessionHost`. The runtime's sandbox spawn wires it as the session's
    `readUsage` hook, so a box's cost/tokens/model reach the HOST descriptor at
    every turn-end — the proxy's text stream never carried them, which is why the
    CI review footer showed no amount and no model for e2b-sandboxed `claude-sdk`
    reviews.
  - `readUsage` may now return `model`; a descriptor spawned without one adopts it.
  - PR-body footer cost refresh: a PR opened through the daemon is stamped the
    instant `gh pr create` returns — mid-turn, before a claude-code/claude-sdk
    session has reported any cost. The provenance reconciler now re-renders each
    recorded PR's footer once the session knows its spend (`replaceProvenanceFooter`,
    `stampFooterOnPr({ refresh: true })`), exactly once per PR.

- Updated dependencies [11b5564]
- Updated dependencies [2fc4c69]
  - @agentproto/workflow-runtime@0.9.0
  - @agentproto/harness@0.4.4

## 0.5.4

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

- Updated dependencies [f0c51a7]
  - @agentproto/driver@0.2.1
  - @agentproto/harness@0.4.3
  - @agentproto/tool@0.2.2
  - @agentproto/workflow-runtime@0.8.1

## 0.5.3

### Patch Changes

- 6372c19: Implement exit-time auto-reclaim for policy-provisioned (implicit) worktrees. When a session spawned under the `"always"` isolation policy without an explicit `worktree` request exits cleanly (merged/fresh, no uncommitted work), its worktree is automatically reclaimed using the same safety-layered classify→re-verify→remove pipeline as `worktree gc`. Caller-explicit worktrees (today's manual-cleanup behavior) are never auto-reclaimed. The feature is fire-and-forget, best-effort only, and never interrupts session teardown.
- 8a3d53d: Fix two critical bugs in `monitorSessionWait`:
  1. **Stale fast-path**: The synchronous already-in-target-state check for `turn-end` now requires `opts.since !== undefined` to fire. Without a cursor anchor, there is no way to distinguish "the turn this wait is waiting for already finished" from "some turn finished hours ago". Fresh `agentproto sessions wait` CLI processes (which have no persisted cursor) now correctly fall through to the real bus-subscribe long-poll instead of instantly succeeding against stale history.
  2. **Dropped empty/reason fields**: `SessionTurnEndEvent.empty` (zero assistant output, zero tool calls) and `.reason` (e.g. `"error"`) are now propagated through all three branches of the wait monitor (ring-replay, sync fast-path, bus long-poll) so callers can distinguish productive turns from silent no-ops (bad auth/model config) or adapter-reported errors. CLI exit code 4 is added for these cases.

  Includes a new `currentEventsCursor()` method to capture race-free cursors for prompt+wait patterns that cannot otherwise subscribe before a turn completes.

- c5016ed: Fix critical production incident (2026-08-22) where running daemon sessions' own working directories were incorrectly deleted by worktree GC. Root cause: `computeLiveness` was defaulting to the frozen legacy sessions file instead of reading per-workspace bucket files (AIP-46). Also adds `protectedPaths` mechanism as belt-and-suspenders protection, wiring the daemon's live in-memory session registry to prevent TOCTOU races between plan and apply.
- Updated dependencies [8a3d53d]
- Updated dependencies [b1a8b7e]
  - @agentproto/harness@0.4.2
  - @agentproto/workflow-runtime@0.8.0

## 0.5.2

### Patch Changes

- 5f5b1bc: Use the active GitHub CLI credential when probing forge availability so a stale secondary account no longer makes worktree status and cleanup appear offline.

## 0.5.1

### Patch Changes

- 4b6bbe6: Documentation sync: update version to 0.11.1-alpha and document new spawn policies (dedupe/attach), judge gate structured verdicts, implicit session deduplication, and worktree async provisioning.
- Updated dependencies [087f0ea]
- Updated dependencies [5e75a57]
- Updated dependencies [2962637]
  - @agentproto/workflow-runtime@0.7.0

## 0.5.0

### Minor Changes

- 8228d88: Add dep-bump reclaim exemption for worktree GC: safely promote clean, unpushed worktrees from `hold` to `reclaim` when all commits are mechanical dependency bumps (subject and cumulative diff validation). Addresses storage bloat from recurring automated dependency-bump worktrees piling up as permanent holds. Includes comprehensive test coverage and applies re-validation at apply time (layer 2).
- fd3e287: **WP-E (spawn-dedupe-default)**: Add implicit idempotency key derivation to prevent accidental spawn duplicates without requiring explicit opt-in. When a spawn carries a `label` and no `idempotencyKey`, the daemon derives an implicit key from the label plus a hash of the initial prompt. Same-adapter/cwd/key spawns within ~2 minutes are deduped (shorter window than explicit keys to reduce false collisions). Label-gated derivation preserves the fan-out safety pattern where unlabelled parallel spawns must remain distinct. New config field `spawn.dedupe` ("always" default / "on-request") controls policy; per-call `dedupe: false` escape hatch.

  **WP-F (worktree async provisioning)**: Enable fast-return session registration with background worktree provisioning, and share a single turbo build cache across all provisioned worktrees. `worktree: { async: true }` opts in: returns immediately with status "starting", provisioning + driver spawn continue in background. New registry methods `spawnAgentPending` / `settlePendingAgent` manage placeholder lifecycle. New `resolveWorktreesTurboCacheDir()` export provides shared cache path to setup hooks, eliminating cold builds on every worktree provision.

### Patch Changes

- c1399f3: Weekly dependency update: bump @modelcontextprotocol/sdk, @mastra/core and ecosystem packages, turbo, tsx, and React types to latest patch/minor versions within semver constraints.
- Updated dependencies [c1399f3]
  - @agentproto/harness@0.4.1

## 0.4.3

### Patch Changes

- 7192faf: Enrich `SessionRef` with optional `adapterSlug`, `model`, `authMode`, `costUsd`, `tokensIn`, and `tokensOut` echoes from `SessionDescriptor`. These fields are ignored by GC logic and are surfaced in local PR provenance footers.
- 41cd652: Ship opt-in AIP-41 routine for scheduled worktree garbage collection. The `worktree-gc` routine wraps the existing `worktree_gc` engine and packages it as a reference template for users to adopt on a daily cron schedule. Routine ships disabled by default; activate in a workspace by copying to `.routines/` and setting `enabled: true`.
- 7465b6c: Harden git-spawn PATH and worktree-cwd anchoring to fix two runtime bugs surfaced by worktree-gc daemon cron. Narrow inherited PATH (frozen at daemon install time) is merged with standard system bin dirs to prevent spawned tools like git from ENOENT-ing. Worktree-specific git spawns are anchored to stable repoRoot instead of per-worktree paths to prevent TOCTOU race conditions where concurrent gc reaps cause misleading "spawn git ENOENT" errors.
- 4d200a9: Implement AIP-41 routine runtime bridge: tight schema for `target` union (tool/agent/workflow/action), `RoutineRegistrar` that reads `.routines/*/ROUTINE.md` and registers cron jobs, `dispatchTool` gateway for in-process MCP tool calls, HTTP `/routine-defs/:id/trigger` and MCP `routine_trigger` tool (mirrors `cron_run`). New `TargetAgent` sugar kind for agent spawning (ahead of upstream draft). Comprehensive unit + integration tests proving all three target kinds fire through real dispatch mechanism.
- 23fa73e: Wire daemon tool-step registry into compileWorkflow; dogfood worktree-gc→notify
- Updated dependencies [bd79483]
- Updated dependencies [831d4f5]
- Updated dependencies [23fa73e]
  - @agentproto/harness@0.4.0
  - @agentproto/driver@0.2.0
  - @agentproto/workflow-runtime@0.6.0

## 0.4.2

### Patch Changes

- Updated dependencies [57d1499]
- Updated dependencies [3d403d7]
  - @agentproto/workflow-runtime@0.5.0
  - @agentproto/harness@0.3.0

## 0.4.1

### Patch Changes

- a116fd6: Replace literal NUL bytes in memoKey with \\u0000 escape to restore UTF-8 text

## 0.4.0

### Minor Changes

- 98bbebf: Partition session state per workspace (AIP-46 §State partitioning)

## 0.3.0

### Minor Changes

- 5ae8c13: Add agentproto.json lifecycle: setup/teardown hooks, supervised services, localhost reverse proxy, and worktree CLI verb
- 2bed7e6: Add worktree status engine (tree/integration/liveness axes, squash-proof reconciliation, ForgeClient, provenance join, ls --status)
- 3e99abf: Split worktree.cleanup --force into discardUntracked/discardModified flags; add rm/archive CLI verbs and salvage writer
- a63b4bc: Add worktree new verb, worktrees.root config, and provision provenance marker
- 47d3251: Add `worktree gc` command: plan/apply/salvage cleanup sweep over linked worktrees

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- 4f62f46: Fix worktree archive ENOENT by resolving the main repo root via --git-common-dir
- a32bb69: Bump test timeouts on subprocess/IO-heavy tests that flake under parallel load
- 0839e5f: Fix gc salvaging dirty fresh worktrees; add recent-write hold window
- Updated dependencies [7b53b8c]
- Updated dependencies [e0fbccc]
  - @agentproto/driver@0.1.3
  - @agentproto/harness@0.2.1
  - @agentproto/tool@0.2.1
  - @agentproto/workflow-runtime@0.4.0

## 0.2.0

### Minor Changes

- 7aaf24a: Add AgentStep.cwd selector and new worktree provision/gate/cleanup tools
- 435dfbf: Add worktree-agent CLI and move worktreeAgentWorkflow into @agentproto/worktree
- 126f7c6: Add createSandboxAgentSessionHost, e2b SandboxProvider, and re-export daemon host from worktree
- 4733077: Add linkPaths to worktree.provision and --link CLI flag to symlink gitignored deps
- e029a35: Wire agent_start.sandbox: boot box + proxy session via SandboxAgentSessionProxy

### Patch Changes

- 4a1ea0f: Add explicit Bindings type annotations in worktree workflow
- a6dce67: Fix expandGlob stack overflow on large repos by skipping node_modules and avoiding spread-push
- 5988bf4: Fix waitForSettled to poll past daemon timeouts via timedOut flag
- Updated dependencies [f8ebe41]
- Updated dependencies [7aaf24a]
- Updated dependencies [2154ed5]
- Updated dependencies [5988bf4]
- Updated dependencies [e029a35]
  - @agentproto/workflow-runtime@0.3.0
  - @agentproto/harness@0.2.0
