# @agentproto/workflow-loader

## 0.2.1

### Patch Changes

- Updated dependencies [66f73d9]
  - @agentproto/workflow@0.5.0

## 0.2.0

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

### Patch Changes

- c4ebbd3: Run-time refs in `harness.knowledge[]` (AIP-15): a selector's `workspace` or tag/kind strings may now carry AIP-16 `$…` references. The loader leaves such strings verbatim (no relative resolution, no existence check) and flags the selector `deferred` internally (authoring `deferred` is rejected); the runtime resolves every string field against the run bindings before materialization — only the leading ref token (up to the next `/`) is replaced, so `$input.bookDir/knowledge` becomes `<resolved bookDir>/knowledge` — a relative resolved workspace joins to the run cwd, an unresolvable ref throws naming the step and field, and a workspace still missing after resolution warns `knowledge-workspace-missing` instead of throwing. `knowledgeApplied` records carry the resolved workspace.
- ece3cae: Extract shared `$steps.<id>` reference validation logic into a reusable utility in @agentproto/workflow, eliminating duplication across workflow-loader and workflow-runtime.
- e7e9261: AIP-15 `subworkflow` steps: the loader now compiles a declarative `with:` block into the step's `inputs` projection (AIP-16 ref grammar — literals, `$input.*`, `$steps.<id>.*`, resolved against the parent's bindings), so the child receives the mapped object instead of the parent's raw input verbatim; steps without `with:` are unchanged. `with` and `inputs` on the same step is a load error, and a `with:` ref to an unknown step id is rejected at load time naming the step and key. The runtime compiler's subworkflow projection is now strict: a referenced field that does not exist throws at run time naming the subworkflow step and key instead of silently passing `undefined`. Spec: `with` semantics added to `stepSubworkflow` in `specs/resources/aip-15/draft/WORKFLOW.schema.json`.
- Updated dependencies [c4bff00]
- Updated dependencies [f9e21fd]
- Updated dependencies [c4ebbd3]
- Updated dependencies [a48dc03]
- Updated dependencies [ece3cae]
  - @agentproto/workflow@0.4.0

## 0.1.5

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
  - @agentproto/workflow@0.3.1

## 0.1.4

### Patch Changes

- Updated dependencies [b1a8b7e]
  - @agentproto/workflow@0.3.0

## 0.1.3

### Patch Changes

- Updated dependencies [087f0ea]
  - @agentproto/workflow@0.2.0

## 0.1.2

### Patch Changes

- Updated dependencies [23fa73e]
  - @agentproto/workflow@0.1.1

## 0.1.1

### Patch Changes

- 3edb7a7: Cache-bust entry.mjs import by mtime for live daemon reloads

## 0.1.0

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
  - @agentproto/workflow@0.1.0
