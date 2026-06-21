# Agent harness

The repo ships an AI agent that reviews PRs, fixes review comments, opens PRs,
and answers questions — driven by GitHub Actions + the Claude API. Two entry
surfaces share one core.

## Surfaces

### Automatic (on every PR push) — `.github/workflows/ci.yml`
1. `build-and-test` — build, type-check, test.
2. `changeset-check` — fast check that a changeset exists.
3. `pr-review` — agent reads the diff, writes an accurate changeset, posts a
   structured review (`APPROVE` / `REQUEST_CHANGES` / `COMMENT`).
4. `pr-fix` — if the review requested changes, the agent applies them and pushes
   to the PR branch. Bounded by `maxFixIterations`, then escalates to a human.

### Automatic (on issue open) — `.github/workflows/issue-triage.yml`
When an issue is opened/reopened, the agent reads it, applies existing labels,
and posts a concise triage note (type · area · actionable? · next step). Re-run
on demand with `/triage`.

### Automatic (on discussion) — `.github/workflows/discussion.yml`
New discussions get an agent answer grounded in the code; discussion comments
that `/answer` or @mention the bot get a reply. Requires the App permission
**Discussions: Read & write** (the API is GraphQL-only).

### On-demand (comment a command) — `.github/workflows/agent-command.yml`
Triggered by **slash-commands** or an **@mention** on a PR or issue. Only
write-access authors (OWNER / MEMBER / COLLABORATOR) can invoke it.

| Command | Where | Effect |
|---|---|---|
| `/review` | PR | Re-review and post a verdict + changeset |
| `/fix` | PR | Apply the latest review's changes to the PR branch |
| `/fix --pr` | PR | Apply them on `bot/fix-<pr>` and open a **stacked PR** |
| `/pr <request>` | PR/issue | Implement `<request>` on a new branch, open a PR |
| `/implement` | issue | Implement the issue, open a PR |
| `/triage` | issue | Re-triage: summarize, apply labels, suggest next step |
| `/wiki <page>: <instruction>` | PR/issue | Create/update a wiki page, grounded in the code |
| `/explain <question>` | PR/issue | Investigate and answer as a comment |
| `/help` | anywhere | Post the command list |
| `@agentproto-bot <free text>` | PR/issue | Interpret intent and act (defaults to proposing a PR) |

The bot reacts 👀 on the triggering comment, then ✅ / ❌ when done.

## Configuration — `.github/agentic-review.json`

```jsonc
{
  "blocking": true,                 // CHANGES_REQUESTED fails the merge gate
  "model": "claude-sonnet-4-6",     // model for all flows
  "fixDelivery": "commit",          // default for on-demand /fix: "commit" | "pr"
  "botMention": "@agentproto-bot",  // literal trigger word — see note below
  "maxFixIterations": 3,            // auto-fix loop bound
  "skills": ["aip-conventions"],    // injected into every flow
  "externalSkills": { "allow": ["DietrichGebert/ponytail@ponytail-review"] },
  "commands": {                     // per-command overrides (model, skills, fixDelivery)
    "review": { "skills": ["aip-conventions", "ponytail-review"] },
    "pr":     { "fixDelivery": "pr" }
  }
}
```

> **`botMention` is a fixed command word, decoupled from the App's name.** It's
> matched literally against comment text — set it to whatever handle you want to
> type to summon the bot. It does NOT have to equal the installed App's name: the
> bot's *identity* (how its comments/commits appear) is derived automatically
> from the App token's `app-slug` at runtime, so you can rename or swap the App
> with no change here. Example: trigger `@agentproto-bot` while the App installed
> is "Ponytail Coder" → replies appear as `ponytail-coder[bot]`.
>
> Caveat: the **job-level gate** in `agent-command.yml` (`if:`) also hardcodes
> `@agentproto-bot`, because a workflow `if:` can't read this JSON. If you change
> `botMention`, update that gate string too (two places). Keeping the default
> `@agentproto-bot` as a stable convention avoids ever touching either.

## Skills — `.github/agent-skills/*.md`

Markdown injected into the agent's system prompt. In-repo names resolve to
`<name>.md`; allow-listed `owner/repo@skill` refs are fetched at job time via
`npx skills`. See `.github/agent-skills/README.md`.

## Code layout

```
scripts/lib/agent-core.mjs   Anthropic loop · config · skills loader
scripts/lib/tools.mjs        developer toolbelt + buildToolset(names, ctx) + @groups
scripts/review-pr.mjs        auto/`/review` reviewer (thin)
scripts/apply-review.mjs     auto/`/fix` fixer, commit|pr delivery (thin)
scripts/agent-command.mjs    on-demand dispatcher (parses verb/@mention → flow)
```

A flow = a system prompt + a `buildToolset([...])` selection + a skill set. Add
a capability by adding a tool in `tools.mjs` and referencing it (or a `@group`)
from a flow.

## Secrets / vars (already configured)
- `secrets.ANTHROPIC_API_KEY` — Claude API.
- `vars.BOT_APP_ID` + `secrets.BOT_APP_PRIVATE_KEY` — GitHub App; mints a token
  so the bot acts under its own identity with `contents`/`pull-requests` write.
  Falls back to `secrets.GITHUB_TOKEN` when absent.

## Required App permission grants

The harness code is complete; two surfaces need the GitHub App's permissions
widened in **Settings → GitHub Apps → (this app) → Permissions** before they
work live:

- **Discussions: Read & write** — for `discussion.yml` / the `discussion` tools
  (GraphQL `addDiscussionComment`). Also enable Discussions on the repo.
- **Wiki** — enable the repo wiki (Settings → Features → Wikis). The App token
  pushes to `<repo>.wiki.git` via `contents` write (already granted).

Everything else (review, fix, PRs, issues/triage, explain) runs on the
permissions already configured.
