# @agentproto/workflow-runtime

## 0.10.0

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

- 1cd0220: Extract shared AIP-16 ref-prefix resolution logic into a new `resolveRefPrefixed` function that resolves the leading ref token of a string and returns the resolved value plus the literal remainder. Refactor `knowledge.ts` to use this new function, reducing duplication and enabling broader reuse of prefix-style ref parsing.

### Patch Changes

- c4bff00: Gate steps: resolve run-time refs in `cwd` and inside `args` strings. A gate's `cwd` and each `args[]` element now accept a LEADING `$input|$item|$steps.<id>|$index` ref token (AIP-16 prefix grammar) plus trailing literal text — e.g. `cwd: $input.bookDir`, `args: ["$input.bookDir/knowledge"]` — instead of only a bare whole-string ref for args (`$$` still escapes a literal `$`; an unresolvable ref throws naming the step and field). The resolved `cwd` is made absolute: an absolute value stays as-is, a relative one (incl. `.`) resolves against the workflow run's own cwd instead of the daemon process cwd. The string-ref resolver is factored into one shared implementation (`ref-string.ts`) shared with `harness.knowledge[]` selector strings.
- c4ebbd3: Run-time refs in `harness.knowledge[]` (AIP-15): a selector's `workspace` or tag/kind strings may now carry AIP-16 `$…` references. The loader leaves such strings verbatim (no relative resolution, no existence check) and flags the selector `deferred` internally (authoring `deferred` is rejected); the runtime resolves every string field against the run bindings before materialization — only the leading ref token (up to the next `/`) is replaced, so `$input.bookDir/knowledge` becomes `<resolved bookDir>/knowledge` — a relative resolved workspace joins to the run cwd, an unresolvable ref throws naming the step and field, and a workspace still missing after resolution warns `knowledge-workspace-missing` instead of throwing. `knowledgeApplied` records carry the resolved workspace.
- ece3cae: Extract shared `$steps.<id>` reference validation logic into a reusable utility in @agentproto/workflow, eliminating duplication across workflow-loader and workflow-runtime.
- e7e9261: AIP-15 `subworkflow` steps: the loader now compiles a declarative `with:` block into the step's `inputs` projection (AIP-16 ref grammar — literals, `$input.*`, `$steps.<id>.*`, resolved against the parent's bindings), so the child receives the mapped object instead of the parent's raw input verbatim; steps without `with:` are unchanged. `with` and `inputs` on the same step is a load error, and a `with:` ref to an unknown step id is rejected at load time naming the step and key. The runtime compiler's subworkflow projection is now strict: a referenced field that does not exist throws at run time naming the subworkflow step and key instead of silently passing `undefined`. Spec: `with` semantics added to `stepSubworkflow` in `specs/resources/aip-15/draft/WORKFLOW.schema.json`.
- a04bd29: `runWorkflow`'s `approve` hook may now return a full decision `{approved, who, note?}` (a bare boolean still works), `ApprovalStep` gains `artifacts` and `timeoutMs` (timeout resolves as rejected with `who: "timeout"`), and the step output records who decided.
- fe9a374: Bridge workflow runs to the app state ledger: a run started on behalf of an installed app (workflow id owned by exactly one installed app, or explicit `appId`/`appRunId`) now appends `stage-started` / `gate-report` / `stage-done` / `blocked` events with `by: "runner"` to that app's `<dataDir>/state/events.jsonl`, so an app's stage board (`app_state_get`) is written by the runner instead of staying empty. Appends are serialized, best-effort, and never fail the run. An optional `item` on the run stamps every ledger event to one sub-key inside each stage.

  Also: `kind: "gate"` step args now resolve per-run — `$…` reference strings expand against the run bindings (`$$…` stays a literal `$`; a ref that resolves to nothing throws naming the step and the arg), so a manifest gate no longer receives literal `"$input.x"` strings as arguments.

- Updated dependencies [c4bff00]
- Updated dependencies [f9e21fd]
- Updated dependencies [c4ebbd3]
- Updated dependencies [a48dc03]
- Updated dependencies [ece3cae]
  - @agentproto/workflow@0.4.0
  - @agentproto/corpus@0.7.1
  - @agentproto/driver@0.2.1
  - @agentproto/tool@0.2.2

## 0.9.0

### Minor Changes

- 11b5564: Add forward-only branch step compilation and subworkflow input projection support to the workflow runtime compiler, plus validation of step references at compile time.

## 0.8.1

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
  - @agentproto/tool@0.2.2
  - @agentproto/workflow@0.3.1

## 0.8.0

### Minor Changes

- b1a8b7e: Add declarative `onError: "collect"` support to workflow map steps. The runtime previously supported per-item error collection via `MapStep.onError`, but the declarative manifest layer did not expose this field. This change:
  - Adds `onError?: "throw" | "collect"` to the `StepMap` interface in `@agentproto/workflow`
  - Updates the compiler to read and propagate `onError` from declarative steps to compiled runtime steps
  - Includes comprehensive test coverage for the collection behavior with mixed success/failure outcomes

### Patch Changes

- Updated dependencies [b1a8b7e]
  - @agentproto/workflow@0.3.0

## 0.7.0

### Minor Changes

- 087f0ea: Declarative agent steps for AIP-15 workflows (WP-B4): author `kind:"agent"` steps with `agent.ref` (app-scoped agent ids) that resolve at compile time to concrete adapters + spawn options. Includes app installation/lifecycle tools (`app_install`, `app_run`, `app_list`, `app_status`, `app_stop`) for managing installed-app state and running agents as live sessions. Tool-id validation now shifts from STEP-DISPATCH time to INSTALL time, listing all missing ids upfront instead of failing one-at-a-time.
- 5e75a57: Add progressive step status reporting to workflow execution via optional `onStepStart` and `onStepComplete` callbacks. Steps now transition through pending → running → done states during execution, rather than remaining pending until workflow completion. This enables real-time progress tracking for long-running workflows.
- 2962637: **Feature: Agent step output text threading in workflows**

  Agent steps can now automatically capture their text output and inject it into subsequent steps' prompts, enabling multi-step workflows to share context and analysis. The workflow runtime captures the final message from each agent step (when `readFinalMessage` is available) and threads it through the bindings, making it accessible to downstream steps via the AIP-16 Selector pattern. Previous step outputs are formatted as `[Output from step "id"]\ntext` and prepended to the base prompt, improving agent reasoning across sequential steps.

### Patch Changes

- Updated dependencies [087f0ea]
  - @agentproto/workflow@0.2.0

## 0.6.0

### Minor Changes

- 23fa73e: Wire daemon tool-step registry into compileWorkflow; dogfood worktree-gc→notify

### Patch Changes

- Updated dependencies [831d4f5]
- Updated dependencies [23fa73e]
  - @agentproto/driver@0.2.0
  - @agentproto/workflow@0.1.1

## 0.5.0

### Minor Changes

- 57d1499: Route sandboxed agent-step spawns through spawnAgentSession; e2b installPackages boot option

## 0.4.0

### Minor Changes

- e0fbccc: Add opt-in per-item error tolerance (onError: "collect") to map/pipeline steps

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
  - @agentproto/driver@0.1.3
  - @agentproto/tool@0.2.1
  - @agentproto/workflow@0.1.0

## 0.3.0

### Minor Changes

- 7aaf24a: Add AgentStep.cwd selector and new worktree provision/gate/cleanup tools

### Patch Changes

- f8ebe41: Pass agent steps through the compiler unchanged
- 2154ed5: Pass agent steps through the compiler unchanged

## 0.2.0

### Minor Changes

- caab49e: Add AgentStep kind and AgentSessionHost; wire WorkflowRunner onto the interpreter
- 3cfe18a: Add outputSchema/maxRetries to AgentStep with validate-and-retry loop
- 887ea34: Add run-level cost ceiling (maxTotalCostUsd) and AgentSessionHost.readCostUsd
- 987db7b: Add PipelineStep: no-barrier staged concurrency over N items through K stages
- 4b76485: Add opt-in journal cache for cacheable steps — replay unchanged outputs on re-invocation

### Patch Changes

- a5c4701: Add package README and CLI concepts/workflows docs page

## 0.1.2

### Patch Changes

- Updated dependencies [78ac79e]
- Updated dependencies [dc870cf]
- Updated dependencies [2186e9e]
  - @agentproto/tool@0.2.0
  - @agentproto/driver@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [1fc1750]
- Updated dependencies [1fc1750]
  - @agentproto/driver@0.1.1
  - @agentproto/tool@0.1.1

## 0.1.0

### Patch Changes

- Updated dependencies [44192c9]
  - @agentproto/driver@0.1.0
  - @agentproto/tool@0.1.0
