---
spec: harness/v1
id: pr-reviewer
name: PR Reviewer
version: 1.0.0
description: Agentic PR reviewer — greps the codebase, understands context, writes accurate changesets, and posts structured reviews on GitHub PRs.

modes:
  - id: analyze
    default: true
    name: Analyze
    description: >
      Reads the git diff, commit log, and any referenced files.
      Greps for patterns and cross-references in the codebase.
      Produces a structured review plan.
    builtins:
      submit_plan: required
    transitionsTo: post
    tools:
      - git_diff
      - git_log
      - grep_repo
      - read_file
      - list_changed_packages

  - id: post
    name: Post
    description: >
      Posts the review to the GitHub PR: comment, approve or request-changes,
      and optionally write/update the changeset.
    builtins:
      submit_plan: false
    tools:
      - gh_pr_comment
      - gh_pr_review
      - write_changeset
---

# PR Reviewer Harness

## Purpose

Provides automated, context-aware code review for PRs in the `@agentproto/ts`
monorepo. Unlike simple diff-based tools, this harness can:

- Follow file references across the codebase
- Grep for usages of changed symbols
- Understand AIP spec evolution by reading `.specs/`
- Write accurate changesets covering all touched packages
- Post structured reviews: summary → findings → verdict

## Modes

### `analyze` (default)

The agent enters `analyze` with the full diff and commit log already injected
into its context. It then calls tools freely:

```
git_diff()         → understand what changed
git_log()          → understand intent (commit messages)
list_changed_packages() → determine bump scope
grep_repo(pattern) → find call-sites, spec references, type usages
read_file(path)    → inspect specific files mentioned in the diff
```

When satisfied, the agent calls `submit_plan` with a structured review object:

```json
{
  "verdict": "APPROVE | REQUEST_CHANGES | COMMENT",
  "changeset": [
    { "name": "@agentproto/agent", "bump": "minor" }
  ],
  "summary": "one-liner for the changeset",
  "review_body": "full markdown review text"
}
```

`submit_plan` is gated: the human can inspect and veto before the `post` mode fires.

### `post`

Receives the approved plan and executes:

1. `write_changeset(packages, summary)` — replaces any existing auto-changeset
2. `gh_pr_review(verdict, body)` — submits APPROVE / REQUEST_CHANGES / COMMENT
3. `gh_pr_comment(body)` — optional inline comment for nit-level findings

## Running locally

```bash
# Review a specific PR (posts the review to GitHub)
node scripts/review-pr.mjs --pr 23

# Analyze only, dry-run (no posting, prints review to stdout)
node scripts/review-pr.mjs --pr 23 --dry-run

# Review current branch against main (no PR number needed)
node scripts/review-pr.mjs --dry-run
```

## CI integration

Triggered by the `pr-review` job in `.github/workflows/ci.yml` after
`build-and-test` passes. Requires `ANTHROPIC_API_KEY` and standard
`GITHUB_TOKEN` permissions (`pull-requests: write`, `contents: write`).

## Tool reference

| Tool | Description |
|---|---|
| `git_diff(from?, to?)` | Unified diff between refs (default: `origin/main...HEAD`) |
| `git_log(from?, to?)` | Commit log with subjects |
| `grep_repo(pattern, glob?)` | ripgrep-style search across the repo |
| `read_file(path)` | Read a repo file (relative to repo root) |
| `list_changed_packages()` | Auto-detect `@agentproto/*` packages touched in the diff |
| `gh_pr_comment(body)` | Post a markdown comment on the PR |
| `gh_pr_review(event, body)` | Submit APPROVE / REQUEST_CHANGES / COMMENT review |
| `write_changeset(packages, summary)` | Write `.changeset/<slug>.md` |
