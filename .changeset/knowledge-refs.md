---
"@agentproto/workflow": patch
"@agentproto/workflow-loader": patch
"@agentproto/workflow-runtime": patch
---

Run-time refs in `harness.knowledge[]` (AIP-15): a selector's `workspace` or tag/kind strings may now carry AIP-16 `$…` references. The loader leaves such strings verbatim (no relative resolution, no existence check) and flags the selector `deferred` internally (authoring `deferred` is rejected); the runtime resolves every string field against the run bindings before materialization — only the leading ref token (up to the next `/`) is replaced, so `$input.bookDir/knowledge` becomes `<resolved bookDir>/knowledge` — a relative resolved workspace joins to the run cwd, an unresolvable ref throws naming the step and field, and a workspace still missing after resolution warns `knowledge-workspace-missing` instead of throwing. `knowledgeApplied` records carry the resolved workspace.
