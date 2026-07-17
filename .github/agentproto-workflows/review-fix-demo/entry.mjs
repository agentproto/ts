// Entry-based handle for the agentproto-run lane's review-fix-demo proof
// flow. `kind: "agent"` only reaches the compiler via an entry module
// (compile-workflow.ts) — it is not a declarative WORKFLOW.md-frontmatter
// kind — so this mirrors the with-entry fixture pattern: a literal object,
// no build step required. Same shape as .github/agentproto-workflows/smoke,
// extended to two steps that share one session via sessionRef.

const reviewPrompt = (bindings) => {
  const baseRef = bindings.input.baseRef
  return [
    `Run "git diff origin/${baseRef}...HEAD" in the current working directory (this is a checked-out git repository) and review everything that changed on this branch relative to origin/${baseRef}.`,
    "Look for correctness issues, typos, and small, clearly safe improvements.",
    "This step is READ-ONLY: do not edit, stage, commit, or push anything, and do not open a PR — just report what you found.",
    "Reply with a concise, concrete list of findings (file + line where you can), or say plainly that you found nothing worth changing.",
    "",
    "Two hard rules that apply for the rest of this session, including any later step, not just this one:",
    "- Never run `gh pr merge` under any circumstances.",
    "- Never add an AI-attribution trailer (no `Co-Authored-By: ...`, no `Generated with ...`, no equivalent) to any commit message or PR body you produce later.",
  ].join("\n")
}

const fixAndPrPrompt = (bindings) => {
  const baseRef = bindings.input.baseRef
  return [
    "This continues your previous review turn in this same session.",
    "",
    "If, and only if, your review found something concrete and safe to fix (a real correctness issue, a typo, a small clear improvement — not a stylistic opinion or anything you're unsure about), do the following now:",
    "1. Apply the fix directly in this checkout.",
    "2. Commit it with a clear, plain commit message. Do NOT add any AI-attribution trailer — no `Co-Authored-By: ...`, no `Generated with ...`, no equivalent.",
    `3. Push to a brand-NEW branch (e.g. named like "agentflow-fix/<short-description>"). This branch must NOT be the branch you just reviewed, and must NOT be "${baseRef}" — never commit or push directly to the branch under review or to the base branch.`,
    `4. Run "gh pr create" targeting "${baseRef}", with a title and body describing the fix and stating plainly that it was opened by the agentproto-run lane's review-fix-demo proof agentflow.`,
    "",
    "If you did NOT find anything concrete and safe to fix, say so explicitly and stop — do not create a branch, do not commit anything, and do not open a PR.",
    "",
    "Two hard rules, no exceptions:",
    "- Never run `gh pr merge` under any circumstances — opening the PR is the end of your job, someone else merges it.",
    "- Never add an AI-attribution trailer (no `Co-Authored-By: ...`, no `Generated with ...`, no equivalent) to any commit message or PR body.",
  ].join("\n")
}

export default {
  name: "Review then fix-and-PR demo",
  id: "review-fix-demo",
  description:
    "Two-step proof that the agentproto-run lane carries a real multi-step agentflow — a single claude-code session reviews a diff, then (via sessionRef reuse) acts on its own findings by opening a PR against a new branch.",
  version: "0.1.0",
  inputs: {},
  outputs: {},
  steps: [
    {
      id: "review",
      kind: "agent",
      adapter: "claude-code",
      prompt: reviewPrompt,
    },
    {
      id: "fix-and-pr",
      kind: "agent",
      sessionRef: "review",
      prompt: fixAndPrPrompt,
    },
  ],
}
