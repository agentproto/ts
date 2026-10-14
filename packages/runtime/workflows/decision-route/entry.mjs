// Runtime source of truth for WORKFLOW.md's step graph (the frontmatter mirrors
// id + kind for governance, per `reconcileEntry`). Every step is a `tool` step
// calling a `decision_*` stage tool registered by the daemon
// (`decision-workflow-tools.ts`); each stage owns exactly one concern and
// returns failures as data, so a refused/failed stage never aborts the run
// with an engine error — `validate` folds the whole trail into one report.
//
// Later steps receive `policy` from `collect` so the DECISION.md text is read
// once. `$run.workspace` lets the stages derive the workflow run id for the
// parent/owner metadata they stamp on spawned sessions.

const common = {
  profile: "$input.profile",
  profileOptions: "$input.profileOptions",
  runWorkspace: "$run.workspace",
  parentSessionId: "$input.parentSessionId",
}

export default {
  name: "Decision-routed review",
  id: "decision-route",
  description:
    "Collect bounded evidence, apply DECISION.md rules, classify with Jev only when unresolved, escalate through ONE profile-gated harness session at most, map the closed choice to a review binding, and (enforce mode only) run it.",
  version: "0.1.0",
  inputs: {
    cwd: { type: "string", description: "Directory inside the repo to review." },
    policyPath: {
      type: "string",
      description: "DECISION.md path relative to cwd.",
      default: "DECISION.md",
    },
    manifestPath: {
      type: "string",
      description: "REVIEW.md path (absolute or relative to cwd). Default: the repo's REVIEW.md.",
    },
    base: { type: "string", description: "Range base (default: merge-base with origin/main)." },
    head: { type: "string", description: "Range head (default: HEAD)." },
    profile: { type: "string", description: "local-free (default) or remote-sonnet.", default: "local-free" },
    mode: {
      type: "string",
      description: "shadow (default; starts no review) or enforce.",
      default: "shadow",
    },
    bindings: {
      type: "object",
      description: "Closed choice -> REVIEW.md binding name.",
      default: { skip: "light", light: "light", standard: "local", deep: "deep" },
    },
    freeBindings: {
      type: "object",
      description: "Binding overrides under a free-only profile (e.g. deep -> a free-reviewer deep binding).",
      default: { deep: "deep-free" },
    },
    profileOptions: {
      type: "object",
      description: "Escalation target ({preset|adapter,model,profileRef,roleDefault,timeoutMs}), jev flag, reviewTimeoutMs.",
    },
    parentSessionId: { type: "string", description: "Session that owns this run; spawned sessions nest under it." },
    evidence: {
      type: "object",
      description: "Consumer-built tier-1 evidence (e.g. a studio router's state); replaces git-derived metadata, same export policy.",
    },
  },
  outputs: {},
  steps: [
    {
      id: "collect",
      kind: "tool",
      tool: "decision_collect_evidence",
      timeout_ms: 90_000,
      inputs: {
        policyPath: "$input.policyPath",
        cwd: "$input.cwd",
        base: "$input.base",
        head: "$input.head",
        supplied: "$input.evidence",
        ...common,
      },
    },
    {
      id: "rules",
      kind: "tool",
      tool: "decision_stage_rules",
      timeout_ms: 30_000,
      inputs: { policy: "$steps.collect.policy", evidence: "$steps.collect.evidence", ...common },
    },
    {
      id: "classify",
      kind: "tool",
      tool: "decision_stage_classify",
      timeout_ms: 60_000,
      inputs: {
        policy: "$steps.collect.policy",
        evidence: "$steps.collect.evidence",
        rules: "$steps.rules",
        ...common,
      },
    },
    {
      id: "escalate",
      kind: "tool",
      tool: "decision_stage_escalate",
      timeout_ms: 15 * 60_000,
      inputs: {
        policy: "$steps.collect.policy",
        evidence: "$steps.collect.evidence",
        rules: "$steps.rules",
        classify: "$steps.classify",
        ...common,
      },
    },
    {
      id: "select",
      kind: "tool",
      tool: "decision_select_review",
      timeout_ms: 60_000,
      inputs: {
        policy: "$steps.collect.policy",
        escalate: "$steps.escalate",
        cwd: "$input.cwd",
        manifestPath: "$input.manifestPath",
        bindings: "$input.bindings",
        freeBindings: "$input.freeBindings",
        ...common,
      },
    },
    {
      id: "review",
      kind: "tool",
      tool: "decision_run_review",
      timeout_ms: 65 * 60_000,
      inputs: {
        policy: "$steps.collect.policy",
        select: "$steps.select",
        range: "$steps.collect.range",
        cwd: "$input.cwd",
        manifestPath: "$input.manifestPath",
        mode: "$input.mode",
        requesterSessionId: "$input.parentSessionId",
        ...common,
      },
    },
    {
      id: "validate",
      kind: "tool",
      tool: "decision_validate_verdict",
      timeout_ms: 30_000,
      inputs: {
        policy: "$steps.collect.policy",
        escalate: "$steps.escalate",
        select: "$steps.select",
        review: "$steps.review",
        ...common,
      },
    },
  ],
}
