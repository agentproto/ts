---
name: light-coder-orchestration
description: >-
  Orchestrate "light"/economical coding models (glm-5.2, deepseek-v4-pro,
  kimi, qwen… via hermes/OpenRouter, or claude-code) from a cowork session
  via the agentproto daemon, with a Sonnet VERIFICATION SAFETY NET. Trigger
  this skill when the user wants "have a task coded by a cheap model", "try
  glm / deepseek / another model on real code", "launch several agents in
  parallel on work packages", "babysit an agent", or industrialize a
  breakdown of task → light-model execution → verification. Complements the
  agent-session-orchestration-agentproto skill by adding: light-model
  selection/wiring, a systematic green gate, a Sonnet verification pass,
  careful parallelism, and commit discipline.
---

# Light-coder orchestration (economical models + Sonnet safety net)

Methodology proven on a real project (monorepo extraction, ~10 work
packages delivered green). **The orchestrator (you, in cowork) doesn't
code**: it breaks work into bounded work packages, has them executed by a
light model via agentproto, and has them **verified by Sonnet**. Light
models are good at bounded implementation but have blind spots → the
Sonnet verification isn't optional.

## Principle in one line

`bounded brief → execution (light model) → green gate (check-types/tests) → Sonnet verification pass → commit`

## 1. Wiring up a light model (hermes via OpenRouter)

- Adapters via `adapter_list`. `claude-code` and `hermes` are over ACP.
- **hermes** routes to plenty of OpenRouter models (glm-5.2, deepseek-v4-pro,
  kimi, qwen, grok, gpt-5.x…). Selection: `agent_start(adapter:"hermes")`
  **then** send `/model <id>` as the **first prompt** — `/model` works over
  hermes ACP (≠ claude-code, where `/model` is blocked and there's no
  `model` param at spawn). Check the output:
  `Model switched to: … · Provider: openrouter`.
- **Daemon prerequisite**: the provider's key must be in the **daemon's**
  environment (e.g. `OPENROUTER_API_KEY`) — `hermes acp` inherits the
  daemon's env. Symptom if missing: "No LLM provider configured" on
  `/model`. (A selection made in the interactive hermes TUI is NOT
  inherited by ACP sessions.)
- grok-4.3 often works by default (Nous OAuth, `~/.hermes/auth.json`
  file), other models go through their own env key.

## 2. The brief (bounded, self-contained)

A good work-package brief has:

- **Explicit file scope** + clear prohibitions ("don't touch X").
- **Recent context** the model can't guess (recent migrations, API
  renames…).
- **Gate**: the exact commands that must be green (`check-types`, `test`).
- **STOP-if-fork**: "if a non-trivial design choice comes up, STOP and
  ask" + name the likely forks and the desired default.
- Ask for a **final report**: files touched, design choices, exit codes.
- Before delegating, paste `supervisor-session`'s Brief Contract into
  every brief.

## 3. Autonomous vs babysit

- **Autonomous** (launch-and-leave) for low-risk, additive work packages
  gated by tests: a single complete brief → the model runs it through →
  you check at the end. This is where you really see a model's quality.
- **Babysit** (step-by-step) for anything risky/ambiguous: 1 step per
  turn, **re-read the diff** between each, then hand out the next step.
  Babysitting masks a model's weaknesses (it keeps it from spiraling) —
  useful for delivering, misleading for evaluating.

## 4. The Sonnet verification safety net (at the end) — NOT optional

Once a light model reports "green", launch a **separate Sonnet
(claude-code) session** that:

1. **Re-runs** `check-types` + `test` (real exit codes — don't take the
   report at its word).
2. **Root-causes** any failure: bug introduced by the work package vs.
   pre-existing — **demands proof**, not an assertion. (Do NOT use `git
   stash` on a shared repo.)
3. **Scope review**: `git diff --stat` — nothing out of scope, no secrets.
4. **Regression**: existing invariants/tests still hold.

Why: light models (a) sometimes write a **buggy test** then
**misdiagnose** the failure ("it's pre-existing") and go down a dead end;
(b) stumble on **test infra** (missing vitest devDep, dist not rebuilt);
(c) can **degrade** (a tool-call format that garbles). Sonnet catches all
of this in a few minutes.

## 5. Careful parallelism

- Launch several work packages in parallel **only over disjoint file
  scopes**. Give each one the instruction "ignore errors confined to
  files you don't touch (parallel work)".
- **Unavoidable shared point** (e.g. a package's `index.ts` that two work
  packages both export from) → do a single **consolidation pass** (one
  writer) that reconciles and re-runs the combined gate. Without this,
  the last writer overwrites the other.

## 6. Gotchas (real-world)

- **Queuing a prompt doesn't interrupt an in-progress turn** → to stop an
  agent that's going off the rails, you have to **kill** it, not prompt it
  "stop". Code already written is on disk, so nothing is lost by killing
  it.
- **Sessions get killed in waves** (env cleanup / concurrent sessions) →
  work off of **disk** as the source of truth (`git status`/files), not a
  session's in-memory state.
- **Autonomous mode: the model often stalls partway through** → a nudge
  "continue, finish, get the gate to green" is usually enough.
- **Migrations**: schema → `db:generate` (never hand-write the `.sql`).
  Check `snapshot`/`_journal` consistency.
- **Commit**: go through a **host session** (claude-code), not the
  sandbox (the husky hook + `.git/objects` perms break in the sandbox).
- **Repo shared between agents**: broad `git add`s from concurrent
  sessions **suck up** your files into their commits → interleaved
  commits. Workaround: launch agents in an **isolated worktree**, or stage
  **narrowly** (`git add <paths>`, never `-A`) + commit promptly.
- **Don't commit working docs/plans** unless asked; commit = code.

## 7. Commit discipline

- Stage **narrowly** (explicit paths), never `git add -A` on a shared
  tree.
- Exclude `.md`/plans if the user wants "code only".
- Check `git diff --cached --name-only` (0 files out of scope, 0 secrets).
- Commit **without pushing** unless explicitly told to.

## 8. Choosing the model

- No absolute winner among the light models: all are good at bounded
  implementation, all capable of a blind spot. **The differentiator is
  the Sonnet safety net**, not the model.
- Large context (e.g. glm-5.2 ~1M) = useful for tasks that touch a lot of
  files.
- To **deliver** fast and safe: Sonnet executes + Sonnet/you verify. To
  **save cost**: light model executes + Sonnet verifies.

## Checklist per work package

- [ ] Bounded brief (scope, prohibitions, gate, STOP-if-fork, report)
- [ ] Model wired up (`/model` confirmed) if light model
- [ ] Execution (autonomous or babysit depending on risk)
- [ ] Nudge if it stalls prematurely
- [ ] **Sonnet verification pass** (re-run gate + root cause + scope +
      regression)
- [ ] Consolidation if scopes overlap
- [ ] Scoped commit (host, scoped, no push) — or isolated worktree
