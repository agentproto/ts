---
name: Agentproto Review Fix
id: agentproto-review-fix
description: >
  Applies the latest CHANGES_REQUESTED review on a PR to the CI checkout, using
  the OpenCode Go subscription model. Writes the working tree only; the calling
  job commits and pushes. No Anthropic API key is involved.
version: 0.1.0
entry: ./entry.mjs
inputs:
  prNumber:
    type: number
    description: Pull request number whose review must be addressed.
    default: 0
  baseRef:
    type: string
    description: Base branch ref (e.g. "main").
    default: main
  repo:
    type: string
    description: owner/repo slug.
    default: ""
  githubToken:
    type: string
    description: >
      Unused placeholder: the host checkout already has GITHUB_TOKEN in its
      environment for the gh CLI. Never print it.
    default: ""
  reviewConfig:
    type: object
    description: Parsed .github/agentic-review.json config.
    default: {}
outputs:
  summary:
    type: string
    description: What the fixer changed, for the job log.
steps:
  - id: fix
    kind: agent
    adapter: opencode
---

# Agentproto Review Fix

One agent step that applies the latest `CHANGES_REQUESTED` review on a PR.

The session runs on the CI runner's checkout (host spawn). It must edit files in
place and stop: the calling `pr-fix` job is responsible for `git add`, commit and
push. It must never post a review, open a PR, or run `gh pr merge`.

## Instructions

1. Read the PR (`gh pr view`), the latest reviews, and their inline comments.
2. Read the full diff (`git diff origin/<baseRef>...HEAD`) for context.
3. Apply the minimal edits that resolve every actionable finding, grounding each
   change in the actual code. Prefer surgical edits over whole-file rewrites.
4. Verify what can be verified cheaply (type-check or test the touched package
   when the toolchain is already installed). Do not install the world.
5. Stop with the working tree dirty. Do not commit, do not push, do not comment.
6. Never add AI-attribution trailers.
