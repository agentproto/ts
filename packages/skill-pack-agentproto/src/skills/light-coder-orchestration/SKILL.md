---
name: light-coder-orchestration
description: >-
  Orchestrate "light"/budget code models (glm-5.2, deepseek-v4-pro, kimi, qwen…
  via hermes/OpenRouter, or claude-code) from a cowork session via the
  agentproto daemon, with a Sonnet VERIFICATION SAFETY NET. Trigger this skill
  when the user wants to "have a cheap model code a task", "try glm / deepseek /
  another model on real code", "run several agents in parallel on WPs",
  "babysit an agent", or industrialize a task breakdown → light-model execution
  → verification pipeline. Complements the
  agent-session-orchestration-agentproto skill by adding: light-model
  selection/wiring, a systematic green gate, a Sonnet verification pass,
  cautious parallelism, and commit discipline.
---

# Light-coder orchestration (budget models + Sonnet safety net)

Methodology proven on a real project (monorepo extraction, ~10 WPs delivered
green). **The orchestrator (you, in cowork) does not code**: it breaks work
into bounded WPs, has a light model execute via agentproto, and has **Sonnet
verify**. Light models are good at bounded implementation but have blind spots
→ the Sonnet verification is not optional.

## One-line principle

`bounded brief → execution (light model) → green gate (check-types/tests) → Sonnet verification pass → commit`

## 1. Wiring up a light model (hermes via OpenRouter)

- Adapters via `adapter_list`. `claude-code` and `hermes` are ACP.
- **hermes** routes lots of OpenRouter models (glm-5.2, deepseek-v4-pro, kimi,
  qwen, grok, gpt-5.x…). Selection: `agent_start(adapter:"hermes")` **then**
  send `/model <id>` as the **first prompt** — `/model` works in hermes ACP
  (≠ claude-code, where `/model` is blocked and there is no `model` param at
  spawn). Check the output: `Model switched to: … · Provider: openrouter`.
- **Daemon prerequisite**: the provider key must be in the **daemon's**
  environment (e.g. `OPENROUTER_API_KEY`) — `hermes acp` inherits the daemon's
  env. Symptom when missing: "No LLM provider configured" on `/model`. (A
  selection made in the interactive hermes TUI is NOT inherited by ACP
  sessions.)
- grok-4.3 often works out of the box (Nous OAuth, file
  `~/.hermes/auth.json`); the other models go through their env key.

## 2. The brief (bounded, self-contained)

A good WP brief:

- **Explicit file scope** + clear no-go zones ("do not touch X").
- **Recent context** the model cannot guess (recent migrations, API
  renames…).
- **Gate**: the exact commands that must be green (`check-types`, `test`).
- **STOP-if-fork**: "if a non-trivial design choice comes up, STOP and ask" +
  name the likely forks and the preferred default.
- Ask for a **final report**: files touched, design choices, exit codes.
- Before delegating, paste the Brief Contract from `supervisor-session` into
  each brief.

## 3. Autonomous vs babysit

- **Autonomous** (launch-and-leave) for low-risk, additive, test-gated WPs:
  one complete brief → the model runs through it → you verify at the end.
  This is where you really see a model's quality.
- **Babysit** (step-by-step) for risky/ambiguous work: 1 step per turn, you
  **re-read the diff** between each, then give the next step. Babysitting
  masks a model's weaknesses (it keeps it from spiraling) — useful for
  shipping, misleading for evaluation.

## 4. The Sonnet verification safety net (at the end) — NOT optional

After a light model reports "green", launch a **separate Sonnet
(claude-code) session** that:

1. **Re-runs** `check-types` + `test` (real exit codes — don't take the
   report at its word).
2. **Root-causes** every failure: bug introduced by the WP vs pre-existing —
   **demand proof**, not an assertion. (Do NOT use `git stash` on a shared
   repo.)
3. **Scope review**: `git diff --stat` — nothing out of scope, no secrets.
4. **Regression**: existing invariants/tests still hold.

Why: light models (a) sometimes write a **buggy test** then **misdiagnose**
the failure ("it's pre-existing") and dead-end; (b) stall on **test infra**
(missing vitest devDep, dist not rebuilt); (c) can **degrade** (tool format
leaking). Sonnet catches all of that in a few minutes.

## 5. Cautious parallelism

- Run multiple WPs in parallel **only on disjoint file scopes**. Give each the
  instruction "ignore errors confined to files you are not touching (parallel
  work)".
- **Unavoidable shared point** (e.g. a package `index.ts` that two WPs export
  from) → do a single **consolidation pass** (one writer only) that reconciles
  and re-runs the combined gate. Without it, the last writer clobbers the
  other.

## 6. Gotchas (lived)

- **A queued prompt does not interrupt an in-flight turn** → to stop an agent
  going off the rails, you must **kill** it, not prompt it "stop". Code
  already written is on disk, so nothing is lost by killing.
- **Sessions get killed in waves** (env cleanup / concurrent sessions) → work
  off the **disk** (truth = `git status`/files), not a session's in-memory
  state.
- **Autonomous mode: the model often stops partway** → a nudge "continue,
  finish, run the gate until green" is usually enough.
- **Migrations**: schema → `db:generate` (never hand-write the `.sql`). Check
  `snapshot`/`_journal` consistency.
- **Commit**: go through a **host session** (claude-code), not the sandbox
  (the husky hook + `.git/objects` perms break in the sandbox).
- **Repo shared between agents**: broad `git add`s from concurrent sessions
  **vacuum up** your files into their commits → interleaved commits.
  Countermeasure: run agents in an **isolated worktree**, or stage
  **narrowly** (`git add <paths>`, never `-A`) + commit quickly.
- **Do not commit working docs/plans** unless asked; commit = code.

## 7. Commit discipline

- Stage **narrowly** (explicit paths), never `git add -A` on a shared tree.
- Exclude `.md`/plans if the user wants "code only".
- Check `git diff --cached --name-only` (0 out-of-scope files, 0 secrets).
- Commit **without push** unless there is an explicit go.

## 8. Choosing the model

- No absolute winner among the light models: all good at bounded impl, all
  capable of a blind spot. **The differentiator is the Sonnet safety net**,
  not the model.
- Large context (e.g. glm-5.2 ~1M) = useful for tasks that churn through many
  files.
- To **ship** fast and safe: Sonnet executes + Sonnet/you verify. To **save
  money**: light model executes + Sonnet verifies.

## Per-WP checklist

- [ ] Bounded brief (scope, no-go zones, gate, STOP-if-fork, report)
- [ ] Model wired (`/model` confirmed) if using a light model
- [ ] Execution (autonomous or babysit depending on risk)
- [ ] Nudge on premature stop
- [ ] **Sonnet verification pass** (re-run gate + root cause + scope +
      regression)
- [ ] Consolidation if scopes overlap
- [ ] Targeted commit (host, scoped, no push) — or isolated worktree
