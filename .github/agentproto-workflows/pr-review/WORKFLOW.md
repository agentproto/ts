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

This placement exists so the local pre-push gate can drive this SAME workflow
through the daemon instead of a separate review path — and now it does: `node
scripts/agentflow/review.mjs --engine daemon` (or `.agentflow.local.json` /
`.agentflow.json`'s `review.engine: "daemon"`) is the caller. It reads the
bearer token from `~/.agentproto/daemons/<port>.json` (the developer's own
already-running `agentproto serve`, default port 18790 — NOT the CI driver's
`.agentproto/runtime.json`, which only a daemon *this repo's own tooling*
booted writes), connects over MCP
(`scripts/lib/daemon-mcp.mjs`), calls `workflow_run_file` against this
WORKFLOW.md with `input: { placement: "local", baseRef, prNumber: 0,
reviewConfig }` (`reviewConfig` = `.github/agentic-review.json` with
`reviewerSandbox` stripped — a local run is always a HOST spawn on the dev's
daemon), polls `workflow_status` to a terminal state, and parses the JSON
verdict off the last session's output tail
(`scripts/agentflow/primitives/review.mjs#reviewViaDaemon`). No diff cap: the
agent reads the live checkout itself, same as every other placement.
