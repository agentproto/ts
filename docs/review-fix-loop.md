# Review-Fix Loop

Automated pipeline that applies review feedback, re-reviews, and escalates to a human when the loop is exhausted.

## Flow

```
PR opened / push
      │
      ▼
 build-and-test  ──────────────────────────────────────────────────────┐
      │ (passes)                                                        │
      ▼                                                                 │
  pr-review  (agentic reviewer — scripts/review-pr.mjs)               │
      │                                                                 │
      ├── APPROVE ──► merge gate passes, human merges                  │
      │                                                                 │
      └── CHANGES_REQUESTED                                            │
              │                                                         │
              ▼                                                         │
          pr-fix  (scripts/apply-review.mjs)                          │
              │                                                         │
              ├── iter < MAX (3) ──► apply fixes, commit, push         │
              │                              │                          │
              │                              └── re-triggers CI ────────┘
              │
              └── iter >= MAX ──► post escalation comment, exit 0
                                      (no commit → loop terminates)
```

## Components

| File | Role |
|------|------|
| `scripts/review-pr.mjs` | Agentic reviewer: reads PR diff, greps codebase, writes changeset, posts APPROVE or CHANGES_REQUESTED |
| `scripts/apply-review.mjs` | Agentic fixer: reads review comments, reads files, writes fixes to working tree |
| `.github/workflows/ci.yml` → `pr-review` job | Runs the reviewer after `build-and-test` passes |
| `.github/workflows/ci.yml` → `pr-fix` job | Runs the fixer after `pr-review`; only active on `CHANGES_REQUESTED` |

## Iteration bounding

`apply-review.mjs` counts past fix commits via `gh pr view --json commits`, filtering on the
sentinel string `"auto-fix from review"` in the commit headline.

**MAX_ITER = 3** (constant in `apply-review.mjs`).

- Iterations 1–3: fixer applies changes, commits `chore: auto-fix from review (iter N)`, pushes.  
  The push re-triggers CI. `pr-review` runs again. If it approves, done. If not, `pr-fix` picks up.
- Iteration 4 attempt: fixer detects `pastIter >= MAX_ITER`, posts escalation comment, exits 0.  
  No files written → `git diff --cached --quiet` → no commit → CI cycle terminates.

### Escalation comment

Posted on the PR by the fixer when the limit is reached:

> ⚠️ **Auto-fix loop exhausted** after 3 iterations without approval.
> A human must now review the remaining comments and address them manually.
>
> **To force-merge** (repository admins only):
> ```
> gh pr merge --admin <PR_NUMBER>
> ```

## Fix commit convention

```
chore: auto-fix from review (iter N)
```

The sentinel substring `auto-fix from review` is what the loop counter matches.
Do not use `[skip ci]` — the push must re-trigger CI to re-review.

## Gate: requiring approval before merge

The branch ruleset (`id: 16835849`, "No Delete Main") requires the **"Agentic review"** check
to pass before any PR can be merged into `main`.

### How the gate works (wired in CI)

The `pr-review` job ends with a **"Gate — fail if changes requested"** step
(`.github/workflows/ci.yml`). It runs _after_ the changeset is committed and pushed, then
checks `gh pr view --json reviewDecision`:

- `CHANGES_REQUESTED` → `exit 1` → job fails → check turns **red** → merge blocked.
- `APPROVED` or `COMMENT` → `exit 0` → job passes → check turns **green** → merge allowed.

The `pr-fix` job uses `always()` so it still runs even when `pr-review` fails, applies
auto-fixes, and re-triggers CI.

### Ruleset applied (run once by admin)

```bash
gh api repos/agentproto/ts/rulesets/16835849 \
  --method PATCH \
  --input - <<'EOF'
{
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "required_status_checks",
      "parameters": {
        "required_status_checks": [
          { "context": "Agentic review", "integration_id": null }
        ],
        "strict_required_status_checks_policy": false
      }
    }
  ]
}
EOF
```

**Impact:** every PR targeting `main` must have a passing "Agentic review" check before
it can be merged — including human-authored PRs. PRs with `APPROVED` pass; PRs with
`CHANGES_REQUESTED` are blocked until the auto-fix loop resolves it or an admin
force-merges.

## Force-merge (bypass)

When the loop is exhausted and you are confident the code is correct:

```bash
# Admin bypass — merges regardless of failing checks or pending reviews
gh pr merge --admin <PR_NUMBER>
```

Alternatively, a repository admin can temporarily set the ruleset enforcement to `disabled`
or `evaluate` via **Settings → Rules**, merge, then restore it.

## Secrets required

| Secret | Used by |
|--------|---------|
| `ANTHROPIC_API_KEY` | Both `pr-review` and `pr-fix` jobs (Claude API calls) |
| `GITHUB_TOKEN` | Both jobs (posting reviews, comments, pushing commits) |

Both are already configured in the repository (used by the existing `pr-review` job).
