# Authoring agentflow CI lanes (agentic review / fix / pr)

How the `agentproto/ts` repo makes a **sandboxed agent** review PRs, apply
review fixes, and open PRs from an issue/request — all config-driven, one
composable block, billing our **subscription**. This is the dev-SOP for
building and extending those lanes. Everything below is grounded in
`.github/`.

> **Scope.** These are GitHub-Actions CI lanes that drive an agent over the
> agentproto daemon's MCP. Do NOT confuse with agentproto's in-daemon
> **workflow-engine** (`workflow_start` / `workflow_run_file` — `workflowRunner`;
> `routine_start` was a DEPRECATED alias over the same engine — removed
> entirely in B3, it no longer exists) — different thing. The word
> "workflow" here = an agentflow lane defined by a `WORKFLOW.md`.

---

## The four layers (where each concern lives)

```
.github/agentic-review.json          ← CONFIG: the single source of truth
      │  (lane selection + per-verb overrides + merge policy)
      ▼
.github/agentproto-workflows/<lane>/  ← LANE: WORKFLOW.md (manifest) + entry.mjs (prompt builder)
      │   pr-review/      verb: review
      │   agent-verb/     verbs: pr, fix (+ implement alias)
      │   docs-audit/     doc-drift audit; also host-runnable via workflow_run_file
      │   lib/sandbox-agent.mjs   ← the command-AGNOSTIC block builders (shared)
      ▼
.github/actions/agentproto-run/       ← RUNNER: daemon boot + driver + auth env + observability
      │   action.yml · driver.mjs · write-config.mjs
      ▼
.github/workflows/ci.yml              ← WIRING: mode-select, secrets→inputs, gate, legacy fallback
.github/workflows/agent-command.yml   ← WIRING: /pr /fix /review comment commands
```

**Golden rule of the split:** the *prompt* (what the agent is told to do) lives
in `entry.mjs`; the *plumbing* (how it's spawned, billed, observed, gated) lives
in the action + `ci.yml`. The `lib/sandbox-agent.mjs` block builders are the
seam — both `pr-review` and `agent-verb` compose the SAME bootstrap / delivery /
hard-rules blocks so there is exactly one sandbox recipe.

---

## Layer 1 — `agentic-review.json` config keys

```jsonc
{
  "blocking": true,               // request-changes fails the gate job
  "model": "claude-sonnet-5",     // model passed to the adapter
  "fixDelivery": "commit",        // GLOBAL default: commit | pr  (see verb model)
  "botMention": "@agentproto-bot",// review footer handle = the NATIVE discriminator
  "maxFixIterations": 3,
  "maxReviewTurns": 50,

  // ---- lane selection (the sandboxed-agent machinery) ----
  "cliSource": "workspace",       // workspace = local build (unpublished fixes); else npm
  "cliVersion": "0.8.0",
  "reviewerAdapter": "claude-sdk",// claude-sdk authenticates HEADLESS; claude-code no-ops in CI
  "reviewerSandbox": "e2b",       // provider slug; absent/"" ⇒ host spawn on the runner
  "reviewerSandboxEnv": ["ANTHROPIC_AUTH_TOKEN", "GITHUB_TOKEN"], // env passthrough into the box

  // ---- merge policy (read from the BASE branch, out of any PR's reach) ----
  "merge": {
    "auto": false,
    "method": "squash",
    "requireAck": false, "ackLabel": "agentflow:ack",
    "maintainer": true, "escalateTo": "agentiknet",
    "alwaysEscalateGlobs": [       // these paths escalate to a HUMAN, never auto-merge
      "**/migrations/**", "**/*.sql", "**/auth/**", "**/security/**",
      ".github/workflows/**", "**/*.env*"
    ]
  },

  "skills": ["aip-conventions"],   // default skills read from the clone

  // ---- per-verb overrides (shallow-merge over globals) ----
  "commands": {
    "review":  { "skills": ["aip-conventions", "ponytail-review"] },
    "fix":     { "skills": ["aip-conventions"], "fixDelivery": "pr" },
    "pr":      { "skills": ["aip-conventions"], "fixDelivery": "pr" },
    "triage":  { "skills": ["aip-conventions"] },
    "explain": { "skills": [] }
  }
}
```

Resolution (`resolveCommandConfig` in `lib/sandbox-agent.mjs:26`): a verb reads
`{ ...global, ...commands[verb] }` — per-verb keys win, `commands` itself is
stripped. So `reviewerAdapter`, `reviewerSandbox`, `reviewerSandboxEnv` can all
be overridden per verb, not just `skills`/`fixDelivery`.

---

## Layer 2 — the verb model

| Verb | Entry | Job | Delivery |
|---|---|---|---|
| `review` | `pr-review/entry.mjs` | read diff → POST a structured review → write changeset | posts a review (+ pushes changeset to PR head) |
| `fix` | `agent-verb/entry.mjs` | apply the latest review's CHANGES_REQUESTED | `fixDelivery`: `commit` (push to PR branch) or `pr` (`bot/fix-<n>` PR) |
| `pr` (`implement` alias) | `agent-verb/entry.mjs` | implement a free-text request or an issue end-to-end | always opens a fresh PR (`bot/request-*` / `bot/issue-<n>`) |
| `docs-audit` | `docs-audit/entry.mjs` (2 steps: `audit` → `deliver` via `sessionRef`) | audit docs against a shipped surface → report drift | per-run **`delivery`** input: `review` (report only) / `commit` / `pr` — NOT an `agentic-review.json` key |

**`docs-audit` is the odd one out — read it before copying the pattern.** Unlike
the CI-only lanes above, it's designed to **also run locally** via
`workflow_run_file` (omit `reviewConfig` ⇒ host spawn, `claude-code`, the
daemon's subscription billing), so it bridges the "lane" and "in-daemon
workflow-engine" worlds the Scope note separates. Its delivery is a per-run
**input** (`delivery: review|commit|pr`), deliberately not an
`agentic-review.json`/`fixDelivery` key, so the lane needs no merge-machinery
edit to be useful. And it is **two-step**: a single "report THEN deliver" prompt
is unreliable (the model treats the report as terminal and stops), so `deliver`
is a separate step that continues the same session via `sessionRef` — the
`review-fix-demo` shape. Copy THAT when a lane both reports and acts.

**`fixDelivery`** is THE knob for "commit vs open-a-PR", resolved
`commands.<verb>.fixDelivery → global → default`. `entry.mjs:47` (`fixDeliveryOf`)
defaults the `fix` verb to `pr`; `commitDeliveryBlock` vs `restOpenPrBlock`
switches the Phase-3 prompt (`entry.mjs:94-128`).

**Two distinct fixer paths — don't conflate:**
- **On-demand** `/fix`, `/pr` (comment commands) → the sandboxed `agent-verb`
  lane → config-driven `fixDelivery`. `/fix --pr` forces PR delivery even if
  config says commit (`agent-command.yml:128`).
- **Automatic post-review loop** (fires `if CHANGES_REQUESTED`) → the LEGACY
  in-runner `scripts/apply-review.mjs --delivery commit` (`ci.yml:817`),
  hard-pinned to commit "so the review→fix→re-review cycle stays tight." This
  one is NOT yet config-driven — the one spot to touch if you want the auto
  loop to open PRs.

---

## Layer 3 — the shared block builders (`lib/sandbox-agent.mjs`)

Every verb composes these; they are placement-aware (host runner vs sandbox):

| Builder | Emits |
|---|---|
| `bootstrapBlock` | Phase 0: clone via `x-access-token:$GITHUB_TOKEN`, optional PR-head fetch. States "NO `gh` CLI" up front. |
| `restPostReviewBlock` | POST a review via curl REST (write body to file → safe JSON quoting). |
| `restOpenPrBlock` | create branch + commit + push + `POST /pulls` via curl. |
| `commitDeliveryBlock` | commit directly onto an existing branch. |
| `skillsBlock` | "read `.github/agent-skills/<slug>.md` FIRST, from your clone". |
| `changesetRulesBlock` | patch/minor/major bump rules (CI/workflow ⇒ no bump). |
| `hardRulesBlock` | no AI attribution; sandbox ⇒ curl-not-gh; never echo token. |
| `adapterFor` / `sandboxRefFor` / `workspaceCwdFor` | resolve adapter, sandbox spec, in-box cwd (`/home/user`). |

Why gh-free: a fresh sandbox has **git, node, npm, curl — no `gh`**. Every
GitHub interaction is curl against `api.github.com` with `$GITHUB_TOKEN`. The
host-runner path keeps using `gh` (authenticated via `GITHUB_TOKEN`).

---

## Layer 4 — the runner action (`agentproto-run`)

`action.yml` inputs that matter:

| Input | Meaning |
|---|---|
| `adapter` | slug to spawn (from `reviewerAdapter`) |
| `workflow-path` | the lane's `WORKFLOW.md` |
| `workflow-input` | JSON bound to `$input` (prNumber, repo, reviewConfig, …) |
| `auth-mode` | **`subscription`** (default) or `api-key` |
| `oauth-token` | `secrets.CLAUDE_CODE_OAUTH_TOKEN` — required in subscription mode |
| `api-key` | `secrets.ANTHROPIC_API_KEY` — required in api-key mode |
| `model`, `base-url`, `thinking`, `provider-key*`, `langfuse-*` | adapter + observability |

The action `serve`s a daemon in the box/runner, then `driver.mjs` drives the
compiled `WORKFLOW.md` over MCP. `write-config.mjs` lays down daemon config.

---

## AUTH: subscription vs api-key (the load-bearing bit)

This is what took the most work to get right.

- **Subscription mode** (default, what main runs): the durable token is a
  `sk-ant-oat01…` (108 chars) minted by `claude setup-token` (**interactive
  only** — the user must mint it). Stored as the GH secret
  **`CLAUDE_CODE_OAUTH_TOKEN`**. When `auth-mode=subscription`, `action.yml`
  exports it as BOTH `CLAUDE_CODE_OAUTH_TOKEN` and **`ANTHROPIC_AUTH_TOKEN`** —
  the latter is the name `claude-sdk` actually reads. So
  `reviewerSandboxEnv` must include `ANTHROPIC_AUTH_TOKEN` (not
  `ANTHROPIC_API_KEY`) for the token to reach the box's daemon.
- **api-key mode**: exports `ANTHROPIC_API_KEY`; `reviewerSandboxEnv` lists it.

- **Adapter choice matters:** `claude-code` (drives the Claude Code *CLI*)
  no-ops headless in CI ("Authentication required" / empty turn). **`claude-sdk`
  authenticates headless** — that's why `reviewerAdapter: claude-sdk`.

- **Mode selection** (`ci.yml`): the agentproto lane runs if
  `CLAUDE_CODE_OAUTH_TOKEN` OR `ANTHROPIC_API_KEY` is present (`ci.yml:438`);
  `AUTH_MODE` is read from `reviewerAuthMode` in the config (`ci.yml:455`),
  defaulting to `subscription`.

- **Config is read from the PR checkout**, so a config-flip PR validates itself
  (no chicken-and-egg with main).

---

## Sandbox (e2b) gotchas

`sandboxRefFor` returns `{ provider, config:{installPackages}, env:{passthrough} }`:

- **`installPackages` is mandatory.** The box's boot-time CLI update runs a
  fresh `npm i -g` that WIPES the template-baked adapters. So the spec
  re-installs `@agentproto/adapter-<adapter>@latest` (plus
  `@anthropic-ai/claude-code@latest` when the adapter is claude-code) in that
  same install. Miss this ⇒ "adapter not found" in the box.
- **`env.passthrough`** names the daemon-process env vars injected into the box;
  the box's OWN daemon + adapter resolve auth from that env (there is no
  `~/.agentproto/config.json` inside a fresh box).
- **Why sandbox at all:** the daemon-internal spawn failure (`-32001`) on the CI
  runner does not reproduce inside a box — the box's own daemon spawns the
  adapter cleanly. `workspaceCwdFor` lands the session in `/home/user` and the
  Phase-0 bootstrap clones there.

---

## Native vs legacy reviewer — how to tell them apart

BOTH the native lane and the legacy `scripts/review-pr.mjs` fallback post under
the same `ponytail-coder[bot]` GitHub App identity. Discriminators, most → least
reliable:

1. **The run log (authoritative).** `Using agentproto CLI source=… adapter=claude-sdk
   auth-mode=subscription` in the "Resolve agentproto CLI source/version" step ⇒
   the native subscription lane ran.
2. **The review rubric.** The native `entry.mjs` prompt yields
   `## Summary / ## Changeset / ## Findings / ## Simplify / ## Verdict`; the
   legacy fallback's format differs.
3. **The `--- @agentproto-bot` footer** — the *intended* sign, but it's
   **model-emitted, so it can be ABSENT on a genuine native review** (observed:
   PR #511's native review omitted it). Footer-absence is INCONCLUSIVE, not proof
   of legacy — don't gate on it.

```bash
# Authoritative check — the run log, NOT the footer:
gh run view <RUN_ID> --repo agentproto/ts --log | grep -iE "auth-mode=subscription|adapter=claude-sdk"
```

> **Gap (follow-up):** the footer should be appended **deterministically in
> `entry.mjs`** (in code, after the model writes the body) instead of trusting
> the model to emit it — only then does footer-presence become a reliable
> discriminator, and the fallback-gate's "already posted?" detection could key on
> it too.

---

## HOW TO: add a new verb to the `agent-verb` lane

1. Add it to the `VERBS` set + `verbOf` in `agent-verb/entry.mjs`.
2. Give it a `taskBlock` branch (the Phase 1/2 instructions) and a
   `deliveryBlock` branch (reuse `restOpenPrBlock` / `commitDeliveryBlock` /
   `restPostReviewBlock`).
3. Add `commands.<verb>` to `agentic-review.json` (skills, fixDelivery, any
   adapter/sandbox override).
4. Wire the trigger in `agent-command.yml` (comment `/verb`) or `ci.yml`.
5. Everything else — daemon boot, auth, sandbox, observability, fallback — is
   already verb-agnostic in `agentproto-run` + the calling job. Don't rebuild it.

## HOW TO: add a whole new lane (like `pr-review`)

1. `mkdir .github/agentproto-workflows/<lane>/`; write `WORKFLOW.md` (frontmatter:
   `id`, `inputs`, `outputs`, `steps:[{id,kind:agent,adapter}]`) + a Markdown
   body describing the embedded instructions.
2. Write `entry.mjs` — `export default { name, id, version, inputs, outputs,
   steps:[{ id, kind:"agent", adapter:(b)=>adapterFor(...), sandbox:sandboxRefFor,
   cwd:workspaceCwdFor, prompt:<builder> }] }`. The `prompt` builder is where all
   the work is; compose the `lib/` blocks.
3. Call it from `ci.yml` via `uses: ./.github/actions/agentproto-run` with the
   lane's `workflow-path`, `auth-mode`, `oauth-token`, and a `workflow-input`
   JSON carrying `reviewConfig: <parsed agentic-review.json>`.

---

## Merge gates & the capability model (design direction)

Merge is deliberately **out of any PR's / agent's reach**: conditions are read
from the **base branch** (`ci.yml` maintainer judge + `alwaysEscalateGlobs` +
the `AGENTFLOW_AUTOMERGE` repo var). A PR touching the merge machinery itself
(`.github/workflows/**`, `agentic-review.json`, `.github/actions/**`,
`scripts/maintainer.mjs`, `scripts/agentflow/**`) is escalated outright
(`ci.yml:558-579`). **Never `gh pr merge`** from an agent — that routes around
every gate (the 2026-07-15 incident `AGENTS.md` exists to prevent).

The forward-looking unification is a **capability model** — collapse the
scattered flags (`fixDelivery`, `blocking`, `merge.*`) into explicit grants and
compose roles from them:

| Capability | Grants | Backed by today |
|---|---|---|
| `canReview` | post APPROVE/CHANGES_REQUESTED | reviewer sandbox |
| `canCommit` | push fixes onto the PR branch | `fixDelivery: commit` |
| `canPR` | open a new/stacked PR | `fixDelivery: pr`, `pr` verb |
| `canMerge` | **satisfy** the auto-merge gate (NOT bypass it) | maintainer judge + `AGENTFLOW_AUTOMERGE` |

Roles = capability sets: `coder` (canPR), `fixer` (+canReview+canCommit),
`maintainer` (+canMerge), `reviewer` (canReview only). Constraint: `canMerge`
means "this role's approval may *satisfy* the existing base-branch gate", never
"run `gh pr merge`" — escalate-globs stay authoritative.

---

## Verify / smoke-test recipes

```bash
# 1) Prove a run billed the SUBSCRIPTION (not api-key):
gh run view <RUN_ID> --repo agentproto/ts --log \
  | grep -iE "auth-mode=subscription|adapter=claude-sdk"
#   → "Using agentproto CLI source=workspace (version=…) adapter=claude-sdk auth-mode=subscription"

# 2) Prove the NATIVE reviewer posted (footer discriminator):
gh api repos/agentproto/ts/pulls/<N>/reviews \
  --jq '.[] | {user:.user.login, state, native:(.body|test("@agentproto-bot"))}'

# 3) Full smoke test: open a throwaway docs-only PR (avoid alwaysEscalateGlobs —
#    no workflows/sql/auth/security/env/migrations), watch its own review lane fire.
```

Trap: `gh run view` needs the run to be `completed` — wait on a real
`until [ "$(gh run view <id> --json status --jq .status)" = completed ]` loop,
not a fixed sleep.

---

## Hard rules (non-negotiable)

- **No AI attribution** in commits/PR bodies (`hygiene-check` fails the PR).
- **Never `gh pr merge`** from an agent session.
- **Never echo** `GITHUB_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` / any secret — the
  prompt blocks reference env vars by name only.
- **Don't hand-write changesets** — the reviewer writes them; `changeset-check`
  only needs *a* changeset to exist, and only for `packages/**`/`adapters/**`.
- Docs-only PRs need no changeset.
```
