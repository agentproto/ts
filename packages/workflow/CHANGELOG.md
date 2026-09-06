# @agentproto/workflow

## 0.4.0

### Minor Changes

- f9e21fd: AIP-15 P2: `harness.knowledge[]` on `kind: "agent"` steps. A selector pins an AIP-10 corpus workspace (relative paths resolve against the WORKFLOW.md dir at load time; a missing workspace fails the load), `anyOf`/`allOf` tag filters, refined `kinds`, a `maxEntries` cap (default 50, slug-ascending deterministic order) and v1 `mode: "files"`. Before an agent step's spawn, the runtime resolves each selector with the corpus `resolveKnowledge`, writes the matched raw entries to `<stepCwd>/.knowledge/<workspaceBasename>/<slug>.md` plus a deterministic `INDEX.md`, prepends a prompt note pointing at the index, and records `knowledgeApplied: { workspace, matched, written }[]` on the step's run record. An empty match is not an error — it is recorded and emitted as a `session:harness-warning` (`knowledge-empty`). `resolveKnowledge`'s signature is unchanged; the new `filterEntriesByAllOf` helper beside it provides the AND-semantics post-filter.
- a48dc03: Implement AIP-15 P2 (harness pinning) and P3 (declarative gate steps).

  **P2 Changes:**
  - Add `AgentHarness` interface for spawn-time control (model, effort, role, tools, skills, cwd, promptFile)
  - Thread harness fields through agent session spawn paths (host and sandbox)
  - Emit `session:harness-warning` events when unsupported harness fields (tools, role) are encountered
  - Load `harness.promptFile` at workflow-load time and record sha256 for audit

  **P3 Changes:**
  - Add `GateStep` interface for shell-command checks (command, args, cwd, report, retry, on_fail)
  - Implement gate step execution with exit-code semantics, report parsing (JSON from stdout or file), and retry logic
  - Add exponential/fixed backoff retry strategy with reprompt-and-retry linking to prior agent steps
  - Emit `workflow:gate-report` events on every command attempt (not just final outcome)

  All changes maintain backward compatibility (optional fields, new types only, no removals).

- ece3cae: Extract shared `$steps.<id>` reference validation logic into a reusable utility in @agentproto/workflow, eliminating duplication across workflow-loader and workflow-runtime.

### Patch Changes

- c4bff00: Gate steps: resolve run-time refs in `cwd` and inside `args` strings. A gate's `cwd` and each `args[]` element now accept a LEADING `$input|$item|$steps.<id>|$index` ref token (AIP-16 prefix grammar) plus trailing literal text — e.g. `cwd: $input.bookDir`, `args: ["$input.bookDir/knowledge"]` — instead of only a bare whole-string ref for args (`$$` still escapes a literal `$`; an unresolvable ref throws naming the step and field). The resolved `cwd` is made absolute: an absolute value stays as-is, a relative one (incl. `.`) resolves against the workflow run's own cwd instead of the daemon process cwd. The string-ref resolver is factored into one shared implementation (`ref-string.ts`) shared with `harness.knowledge[]` selector strings.
- c4ebbd3: Run-time refs in `harness.knowledge[]` (AIP-15): a selector's `workspace` or tag/kind strings may now carry AIP-16 `$…` references. The loader leaves such strings verbatim (no relative resolution, no existence check) and flags the selector `deferred` internally (authoring `deferred` is rejected); the runtime resolves every string field against the run bindings before materialization — only the leading ref token (up to the next `/`) is replaced, so `$input.bookDir/knowledge` becomes `<resolved bookDir>/knowledge` — a relative resolved workspace joins to the run cwd, an unresolvable ref throws naming the step and field, and a workspace still missing after resolution warns `knowledge-workspace-missing` instead of throwing. `knowledgeApplied` records carry the resolved workspace.
  - @agentproto/define-doctype@0.1.1

## 0.3.1

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

## 0.3.0

### Minor Changes

- b1a8b7e: Add declarative `onError: "collect"` support to workflow map steps. The runtime previously supported per-item error collection via `MapStep.onError`, but the declarative manifest layer did not expose this field. This change:
  - Adds `onError?: "throw" | "collect"` to the `StepMap` interface in `@agentproto/workflow`
  - Updates the compiler to read and propagate `onError` from declarative steps to compiled runtime steps
  - Includes comprehensive test coverage for the collection behavior with mixed success/failure outcomes

## 0.2.0

### Minor Changes

- 087f0ea: Declarative agent steps for AIP-15 workflows (WP-B4): author `kind:"agent"` steps with `agent.ref` (app-scoped agent ids) that resolve at compile time to concrete adapters + spawn options. Includes app installation/lifecycle tools (`app_install`, `app_run`, `app_list`, `app_status`, `app_stop`) for managing installed-app state and running agents as live sessions. Tool-id validation now shifts from STEP-DISPATCH time to INSTALL time, listing all missing ids upfront instead of failing one-at-a-time.

## 0.1.1

### Patch Changes

- 23fa73e: Wire daemon tool-step registry into compileWorkflow; dogfood worktree-gc→notify

## 0.1.0

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
  - @agentproto/define-doctype@0.1.1
