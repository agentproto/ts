// Entry-based handle for the docs-audit lane. Follows the CI-lane SOP
// (reference/ci-review-fix-lanes.md): the PROMPT lives here; placement/billing/
// delivery plumbing is composed from ../lib/sandbox-agent.mjs so this lane
// shares the one sandbox recipe with pr-review + agent-verb. `kind: "agent"`
// only reaches the compiler via an entry module — mirrors the smoke/pr-review
// pattern (a literal object, no build step).
//
// TWO STEPS, sharing one session via `sessionRef` (the review-fix-demo shape):
//   1. audit   — READ-ONLY: read the docs + ground truth, emit the drift report.
//   2. deliver — reuses the audit session; a no-op in `review` mode, else it
//      applies the fixes it just reported and commits / opens a PR.
// A single "report THEN deliver" mega-prompt is unreliable — the model treats
// the report as terminal and stops before delivering. Splitting delivery into
// its own turn (that continues the same session) makes commit/pr dependable.
//
// Placement is config-driven (reviewerSandbox in the passed reviewConfig):
//   · no reviewConfig (local `workflow_run_file`) ⇒ host spawn, adapter
//     claude-code, subscription billing from the daemon config.
//   · reviewConfig with reviewerSandbox:"e2b" (CI) ⇒ sandbox spawn, adapter
//     claude-sdk (headless-safe), auth env passed through.
//
// Delivery is a per-run INPUT (`delivery`), NOT an agentic-review.json key, so
// this lane needs no merge-machinery config edit to be useful:
//   · review (default) — report drift only, edit nothing.
//   · commit           — apply the doc fixes and commit to a dedicated branch.
//   · pr               — apply the doc fixes and open a fresh PR.

import {
  adapterFor,
  bootstrapBlock,
  commitDeliveryBlock,
  hardRulesBlock,
  restOpenPrBlock,
  sandboxRefFor,
  workspaceCwdFor,
} from "../lib/sandbox-agent.mjs"

const VERB = "docs-audit"

// The surface the docs are expected to reflect. Passed as the `surface` input
// when present; otherwise this baked-in default describes the shipped
// session-config-axes surface.
const DEFAULT_SURFACE = [
  "The agentproto daemon shipped a unified per-session CONFIG-AXES surface that",
  "replaces the overloaded `mode` concept. The axes are:",
  "  - model         — route-identity ref, grammar `[route:]vendor/product[:pin][@route]`",
  "  - effort        — reasoning/compute budget (low|medium|high|xhigh|max|ultracode)",
  "  - access        — a NAMED auth profile (access.profileRef), not an inline token",
  "  - route         — endpoint/gateway rail (anthropic|openrouter|requesty|...)",
  "  - posture       — what the agent may DO (default|plan|accept-edits|bypass|read-only)",
  "  - contextProfile — what enters context (full|lean|...)",
  "New MCP verbs: `catalog_models` (route/vendor/profile-aware model catalog,",
  "with a per-route `runnable` flag), and three LIVE best-effort switches —",
  "`agent_set_model`, `agent_set_effort`, `agent_set_posture` (each returns",
  "`{applied:false, reason}` instead of throwing when a switch can't apply live).",
  "`session_restart` gained restart-with-override: model/effort/posture/route/",
  "access.profileRef/contextProfile.",
  "The OLD framing that should now read as stale: `mode`/`modes` as the way to",
  "pick model/posture/behavior, and inline `auth {mode,token,apiKey}` as the",
  "only billing selector.",
].join("\n")

// Doc files most likely to have drifted (from the recon). The agent should
// still discover anything else under docs/ that mentions the surface.
const DEFAULT_DOC_PATHS = [
  "README.md",
  "docs/cli/verbs/sessions.md",
  "docs/cli/concepts/adapters.md",
  "docs/cli/verbs/models.md",
  "docs/cli/verbs/run.md",
  "docs/HARNESS-DESIGN.md",
  "AGENTS.md",
].join("\n")

const DELIVERY_MODES = new Set(["review", "commit", "pr"])
const deliveryOf = (bindings) => {
  const raw = String(bindings?.input?.delivery ?? "review").trim().toLowerCase()
  return DELIVERY_MODES.has(raw) ? raw : "review"
}

const isSandboxRun = (bindings) =>
  sandboxRefFor(bindings?.input?.reviewConfig, VERB) !== undefined &&
  Boolean(bindings?.input?.repo)

// Run-specific, not surface-specific: a fresh branch per run so a rerun with a
// different `surface`/`docPaths` never collides (non-fast-forward push) with a
// still-open branch from a prior run.
const branchFor = () => `bot/docs-audit-${Date.now().toString(36)}`

// ── Step 1: audit (read-only) ────────────────────────────────────────
const auditPrompt = (bindings) => {
  const input = bindings?.input ?? {}
  const surface = (input.surface && String(input.surface).trim()) || DEFAULT_SURFACE
  const docPaths =
    (input.docPaths && String(input.docPaths).trim()) || DEFAULT_DOC_PATHS
  const baseRef = String(input.baseRef || "main")
  const repo = String(input.repo || "")
  const sandboxed = isSandboxRun(bindings)

  return [
    `You are a documentation auditor for the @agentproto/ts monorepo. This turn is`,
    `READ-ONLY: read the docs and report drift. Do NOT edit, commit, or open a PR —`,
    `a later turn in this same session handles any delivery.`,
    ``,
    sandboxed ? bootstrapBlock({ repo, baseRef }) : "",
    `## The shipped surface the docs SHOULD reflect`,
    ``,
    surface,
    ``,
    `## Ground truth for the surface`,
    `The authoritative, as-built description lives in the runtime tool`,
    `descriptions. Read these to confirm the exact vocabulary before judging drift:`,
    `  - packages/runtime/src/agent-tools.ts   (agent_set_model / _effort / _posture, catalog_models)`,
    `  - packages/runtime/src/session-tools.ts  (session_restart override axes)`,
    ``,
    `## Phase 1: Analyze`,
    `Read each of these (use read_file / grep / rg). Also grep docs/ for any`,
    `other page mentioning: mode, modes, posture, effort, auth, route, model,`,
    `catalog_models, contextProfile, profile.`,
    ``,
    docPaths,
    ``,
    `Classify each drift as:`,
    `1. STALE — text framing legacy \`mode\`/\`modes\` or inline \`auth\` as the way to pick model/posture/billing.`,
    `2. MISSING — axes/verbs that exist in the tool descriptions but appear in NO doc.`,
    `3. INCONSISTENT — two docs (or a doc vs a tool description) disagree on vocabulary.`,
    ``,
    `## Phase 2: Report`,
    `Produce a single markdown report, no preamble:`,
    ``,
    `### Docs drift audit — session-config-axes`,
    `A one-line verdict: UP TO DATE, PARTIALLY STALE, or STALE.`,
    ``,
    `A table: file:line | current text (short) | drift type | what it should say.`,
    `Then a short ranked list "Where a doc fix should land first".`,
    `Ground every row in a real file:line you actually read. If a doc is already`,
    `current, say so rather than inventing a finding.`,
  ]
    .filter(Boolean)
    .join("\n")
}

// ── Step 2: deliver (reuses the audit session) ───────────────────────
const deliverPrompt = (bindings) => {
  const input = bindings?.input ?? {}
  const delivery = deliveryOf(bindings)
  const baseRef = String(input.baseRef || "main")
  const repo = String(input.repo || "")
  const sandboxed = isSandboxRun(bindings)

  if (delivery === "review") {
    return [
      `This was a review-only run (delivery=review). The audit report you produced`,
      `in the previous turn IS the deliverable — do NOT edit any file, commit, or`,
      `open a PR. Reply with the single word: DONE.`,
    ].join("\n")
  }

  const branch = branchFor()
  const apply = [
    `This continues your audit turn in the SAME session. Now DELIVER the fixes you`,
    `just reported (delivery=${delivery}).`,
    ``,
    `1. Apply the fixes from your report by EDITING the doc files in place — only`,
    `   the drift you actually found (grounded in your file:line rows); do not`,
    `   invent changes, and touch only Markdown docs.`,
    ``,
  ]

  if (delivery === "commit") {
    apply.push(`2. Commit the edits to a dedicated branch (never straight onto ${baseRef}):`)
    apply.push(
      sandboxed
        ? commitDeliveryBlock({ branch })
        : [
            `   \`\`\`bash`,
            `   git checkout -b "${branch}"`,
            `   git add -A && git commit -m "<concise conventional-commit title for the doc fixes>"`,
            `   git push -u origin "${branch}"`,
            `   \`\`\``,
          ].join("\n"),
    )
  } else {
    apply.push(`2. Open a fresh pull request with the edits:`)
    apply.push(
      sandboxed
        ? restOpenPrBlock({ repo, branch, base: baseRef, titleHint: "the drift report above" })
        : [
            `   \`\`\`bash`,
            `   git checkout -b "${branch}"`,
            `   git add -A && git commit -m "<concise conventional-commit title for the doc fixes>"`,
            `   git push -u origin "${branch}"`,
            `   gh pr create --base ${baseRef} --title "<concise PR title for the doc fixes>" --body-file -`,
            `   \`\`\``,
            `   Pipe your drift report (what changed + why) into the PR body. Print the PR URL when done.`,
          ].join("\n"),
    )
  }

  apply.push(``)
  apply.push(
    hardRulesBlock({
      sandboxed,
      extra: [
        `- DOCS lane — edit only Markdown docs; never code, migrations, workflows, or config.`,
        `- Never run \`gh pr merge\`.`,
      ],
    }),
  )
  return apply.join("\n")
}

export default {
  name: "Docs drift audit",
  id: "docs-audit",
  description:
    "Read-only-by-default documentation auditor. Step 1 audits the repo docs against a shipped surface and reports drift; step 2 (same session, via sessionRef) escalates to commit or PR when the `delivery` input asks for it.",
  version: "0.3.0",
  inputs: {
    surface: {
      type: "string",
      description: "Free-text description of the shipped surface the docs should reflect.",
      default: "",
    },
    docPaths: {
      type: "string",
      description: "Newline- or comma-separated list of doc files to audit.",
      default: "",
    },
    delivery: {
      type: "string",
      description: "review (default, report only) | commit (apply + commit) | pr (apply + open PR).",
      default: "review",
    },
    baseRef: { type: "string", description: "Base branch for pr delivery.", default: "main" },
    repo: { type: "string", description: "owner/repo — required for sandbox bootstrap + REST delivery.", default: "" },
    reviewConfig: {
      type: "object",
      description: "Parsed .github/agentic-review.json (placement/adapter). Omit for a host run.",
      default: {},
    },
  },
  outputs: {
    report: {
      type: "string",
      description: "The markdown drift report (the audit step's final message).",
    },
  },
  steps: [
    {
      id: "audit",
      kind: "agent",
      // Config-driven adapter (claude-code host default; claude-sdk in CI).
      adapter: (b) => adapterFor(b?.input?.reviewConfig, VERB),
      // Config-driven placement — undefined ⇒ host spawn (local billing).
      sandbox: (b) => sandboxRefFor(b?.input?.reviewConfig, VERB),
      cwd: (b) => workspaceCwdFor(b?.input?.reviewConfig, VERB),
      prompt: auditPrompt,
    },
    {
      id: "deliver",
      kind: "agent",
      // Reuse the audit session — inherits its placement; no-op in review mode.
      sessionRef: "audit",
      prompt: deliverPrompt,
    },
  ],
}
