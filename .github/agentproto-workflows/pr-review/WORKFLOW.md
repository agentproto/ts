---
name: Agentproto PR Review
id: agentproto-pr-review
description: >
  Agentic PR reviewer that reads the diff, writes an accurate changeset, and
  posts a structured review (APPROVE / REQUEST_CHANGES / COMMENT). Replaces
  the hand-rolled scripts/review-pr.mjs loop with an agentproto-run lane that
  drives claude-code over MCP, defaulting to the subscription OAuth token and
  falling back to API-key billing when the OAuth token is absent/expired.
version: 0.1.0
entry: ./entry.mjs
inputs:
  placement:
    type: string
    description: >-
      Delivery placement — "host" (gh CLI, default), "sandbox" (inferred from
      reviewConfig.reviewerSandbox + repo), or "local" (no PR, no posting —
      emit a structured verdict as the final message; see "Local placement"
      below).
    default: host
  prNumber:
    type: number
    description: The pull request number to review. Unused (may be 0) when placement is "local".
    default: 0
  baseRef:
    type: string
    description: Base branch ref (e.g. "main").
    default: main
  repo:
    type: string
    description: owner/repo slug — required for the sandbox bootstrap clone (reviewerSandbox mode).
    default: ""
  lastReviewedSha:
    type: string
    description: SHA the reviewer last posted a review against; empty on first review.
    default: ""
  priorReviewBody:
    type: string
    description: The markdown body of the reviewer's prior review, for continuity.
    default: ""
  githubToken:
    type: string
    description: GitHub token for posting reviews and changesets.
  anthropicApiKey:
    type: string
    description: Anthropic API key for fallback review when OAuth token is unavailable.
  reviewConfig:
    type: object
    description: Parsed .github/agentic-review.json config (blocking, botMention, maxReviewTurns, merge.alwaysEscalateGlobs).
outputs:
  conclusion:
    type: string
    description: Terminal review conclusion — "approved", "changes_requested", or "comment".
  reviewBody:
    type: string
    description: The markdown review body that was posted.
  changesetWritten:
    type: boolean
    description: Whether a changeset was written to .changeset/.
  error:
    type: string
    description: Error message if the review failed.
steps:
  - id: review
    kind: agent
    adapter: claude-code
---

# Agentproto PR Review

One-step agentflow that carries the full PR review inside a single
`claude-code` session. The prompt embeds the review rubric, changeset rules,
and AIP conventions so the agent can operate without a custom toolset — it
uses claude-code's native bash/file-read tools to inspect the diff and the
`gh` CLI (already authenticated via `GITHUB_TOKEN`) to post the review and
commit the changeset.

The step runs `git diff origin/<baseRef>...HEAD` itself, so no pre-computed
diff is passed as input — the agent sees the live checkout.

## Review instructions (embedded in prompt)

When `lastReviewedSha` is set (and not `HEAD`), the review is **INCREMENTAL**:
the reviewer has already reviewed this PR through that commit, so it reviews
only the increment (`git diff <lastReviewedSha>...HEAD`) and uses the full
`git diff origin/<baseRef>...HEAD` only for context — not to re-raise findings
on unchanged lines. `priorReviewBody` carries the previous review for
continuity. When `lastReviewedSha` is empty, it's a first (full-diff) review.

1. Read the diff with `git diff origin/<baseRef>...HEAD`.
2. Inspect changed files with `read_file` / shell grep as needed.
3. Call `gh pr review <prNumber>` FIRST (mandatory) with:
   - `event`: --approve, --request-changes, or --comment
   - `body`: structured markdown review
4. Write a changeset to `.changeset/pr-<prNumber>-agentic.md` if the PR
   touches published packages.
5. Never add AI attribution trailers.

## Fallback behaviour

When `claudeCodeOauthToken` is absent, the calling job in `ci.yml` falls back
to the existing hand-rolled `scripts/review-pr.mjs` path (API-key billing).
This workflow is ONLY exercised when the OAuth token is present and valid.

## Local placement

`placement: "local"` runs the SAME review rubric against the current branch
diff with no PR involved: no `bootstrapBlock` clone, no `gh`/curl posting, no
changeset write. Instead of Phase 2 "Act", the agent's only job is Phase 2
"Report" — emit a single JSON object as its final message:

```json
{ "conclusion": "approve" | "request_changes", "summary": "...", "findings": [...] }
```

This placement exists so the local pre-push gate
(`scripts/agentflow/review.mjs`, currently its own single-shot
`primitives/review.mjs` implementation — see `scripts/agentflow/README.md`)
can eventually drive this SAME workflow through the daemon instead of a
separate review path, once a caller exists that can reach `workflow_run_file`
headless from a plain node script and read a structured verdict back out of
the finished run. Landing that caller is tracked separately — this entry only
adds the placement the caller will need.
