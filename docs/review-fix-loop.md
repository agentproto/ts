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
      │  ↳ posts explicit "Agentic review" commit-status on HEAD       │
      │                                                                 │
      ├── APPROVE ──► status=success, merge gate passes, human merges  │
      │                                                                 │
      └── CHANGES_REQUESTED                                            │
              │ (status=failure when AGENTIC_REVIEW_BLOCKING=true)     │
              ▼                                                         │
          pr-fix  (scripts/apply-review.mjs)                          │
              │                                                         │
              ├── iter < MAX (3) ──► apply fixes, commit, push         │
              │                              │                          │
              │         (BOT_PAT present?) ──┤                         │
              │              yes → re-triggers CI ──────────────────────┘
              │              no  → HEAD moves, status must be re-posted │
              │                   by the NEXT pr-review run             │
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
  If `BOT_PAT` is configured, the push re-triggers CI and `pr-review` runs again.  
  If only `GITHUB_TOKEN` is available, re-triggering does NOT happen (see below).
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

### Root cause: GITHUB_TOKEN does not re-trigger workflows

GitHub's anti-recursion policy means **a workflow that pushes via `GITHUB_TOKEN` will NOT
trigger a new workflow run on that commit**. This is by design and cannot be overridden.

Consequence: when `pr-review` (or `pr-fix`) commits the changeset/fixes and pushes via
`GITHUB_TOKEN`, the PR HEAD advances to a new commit with **no CI run and no check-run or
commit-status attached to it**. The required `Agentic review` status check therefore never
lands on the new HEAD, and the PR stays permanently blocked — even when a human approves it.

### Fix level 1 — explicit status on HEAD (always active)

After committing and pushing the changeset, `pr-review` now **explicitly posts a
`Agentic review` commit-status** on the current HEAD SHA via `gh api
repos/{repo}/statuses/{sha}`. The ruleset accepts either a check-run or a commit-status
with the same context name, so this guarantees the required check is always present on the
correct commit — regardless of whether CI was re-triggered.

The status state is determined by the `gate` step:

| `AGENTIC_REVIEW_BLOCKING` | review decision | status posted | job result |
|--------------------------|-----------------|---------------|------------|
| `true` (default)         | `CHANGES_REQUESTED` | `failure` | exit 1 |
| `true` (default)         | `APPROVED` / other  | `success` | exit 0 |
| `false`                  | any             | `success` | exit 0 |

### Fix level 2 — bot identity (optional, enables full re-trigger loop)

Both `pr-review` and `pr-fix` mint a short-lived token before checkout, with this
precedence:

```
App token (BOT_APP_ID set?) ──yes──► mint via actions/create-github-app-token@v1
        │ no
        ▼
BOT_PAT set? ──yes──► use PAT
        │ no
        ▼
GITHUB_TOKEN  (default — no re-trigger)
```

The checkout token is:

```yaml
token: ${{ steps.bot.outputs.token || secrets.BOT_PAT || secrets.GITHUB_TOKEN }}
```

When a bot identity is in use, pushes are attributed to a different actor and bypass
GitHub's anti-recursion guard — a new CI run fires on every bot commit, fully activating
the review-fix loop. The explicit status step (level 1) remains idempotent alongside it.

#### Option A — GitHub App (recommended)

Short-lived installation tokens, no rotation needed, scoped to the repo.

**Setup (one-time, in the GitHub UI):**

1. Go to **github.com/settings/apps** → **New GitHub App**.
2. Set permissions: `Contents: Read & write`, `Pull requests: Read & write`.
3. Install the App on the `agentproto/ts` repository.
4. Download the **private key** (PEM file).
5. Note the **App ID** from the App's settings page.

**Wire it up:**

```bash
# Repository variable (public — just an integer ID)
gh variable set BOT_APP_ID --body "<your-app-id>"

# Repository secret (the PEM content, including header/footer lines)
gh secret set BOT_APP_PRIVATE_KEY < /path/to/private-key.pem
```

#### Option B — Fine-grained PAT (simpler, requires rotation)

```bash
# Create a fine-grained PAT with Contents + Pull requests write on this repo
gh secret set BOT_PAT --body "<your-pat>"
```

- **`BOT_PAT` present, `BOT_APP_ID` absent**: PAT is used.
- Both absent: falls back to `GITHUB_TOKEN` (no re-trigger; level 1 still posts the status).

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
it can be merged — including human-authored PRs.

### Blocking mode configuration

Two sources control whether a `CHANGES_REQUESTED` decision blocks the merge,
resolved in this order of precedence:

1. **`vars.AGENTIC_REVIEW_BLOCKING`** (repository variable) — if set and non-empty,
   this value wins. Use for instant, no-PR-required overrides (e.g. emergency disable).
2. **`.github/agentic-review.json`** (versioned file, field `blocking`) — read when
   the variable is absent. Changing this goes through a PR and the review gate itself,
   making the intent traceable in git history.
3. **`true`** (hard-coded fallback) — if both sources are absent or unreadable.

```
vars.AGENTIC_REVIEW_BLOCKING set? ──yes──► use it
         │ no
         ▼
.github/agentic-review.json present? ──yes──► use .blocking field
         │ no
         ▼
       true  (fallback)
```

**`.github/agentic-review.json`** (committed in repo, default):

```json
{
  "blocking": true
}
```

| `blocking` value | Behaviour |
|-----------------|-----------|
| `true` (default) | `CHANGES_REQUESTED` → status `failure`, job exits 1, merge blocked |
| `false` | Status always `success`; review is informative only, never blocks merge |

**Emergency disable** (no PR needed — takes effect on the next CI run):

```bash
gh variable set AGENTIC_REVIEW_BLOCKING --body "false"
# restore default behaviour
gh variable delete AGENTIC_REVIEW_BLOCKING
```

**Permanent change** (versioned, goes through review gate):

Edit `.github/agentic-review.json` and open a PR.

## Force-merge (bypass)

When the loop is exhausted and you are confident the code is correct:

```bash
# Admin bypass — merges regardless of failing checks or pending reviews
gh pr merge --admin <PR_NUMBER>
```

Alternatively, a repository admin can temporarily set the ruleset enforcement to `disabled`
or `evaluate` via **Settings → Rules**, merge, then restore it.

## Secrets and variables required

| Name | Kind | Required | Used by |
|------|------|----------|---------|
| `ANTHROPIC_API_KEY` | Secret | Yes | Both `pr-review` and `pr-fix` jobs (Claude API calls) |
| `GITHUB_TOKEN` | Secret (auto) | Yes | Both jobs (posting reviews, comments, pushing commits) |
| `BOT_APP_PRIVATE_KEY` | Secret | No (App path) | Mint step — PEM private key of the GitHub App |
| `BOT_PAT` | Secret | No (PAT path) | Checkout fallback if App not configured |
| `BOT_APP_ID` | Variable | No (App path) | Mint step — integer App ID; activates App token minting |
| `AGENTIC_REVIEW_BLOCKING` | Variable | No | `pr-review` gate step — overrides `.github/agentic-review.json` |
