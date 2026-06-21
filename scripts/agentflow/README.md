# agentflow — local agentic dev helpers

Composable, opt-in helpers that run the same engines locally that CI runs in
the cloud — so you can get a changeset (and, soon, a review) **before** you
push, instead of waiting for the CI bot to generate one and re-trigger the
pipeline.

## Two axes, per feature

| axis     | values                     | meaning                                              |
| -------- | -------------------------- | ---------------------------------------------------- |
| `stage`  | `manual` · `commit` · `push` | when a git hook runs it (`manual` = only on demand)  |
| `engine` | `local` · `cloud`          | `local` = Claude Code CLI (your sub); `cloud` = API  |

## Config (deep-merged, later wins)

- `.agentflow.json` — committed team defaults. Conservative: everything
  `manual`, so a fresh clone never blocks a commit on an AI call.
- `.agentflow.local.json` — your gitignored opt-in. Copy from
  `.agentflow.local.json.example`:

  ```json
  { "changeset": { "stage": "push", "engine": "local" } }
  ```

Engine precedence: `--engine` flag → `AGENTFLOW_ENGINE` env → config → default.

## Run it

- `pnpm changeset:ai`  — generate a changeset now (engine from config).
- `pnpm changeset:auto` — same, pinned to `--engine cloud` (CI path).
- `pnpm review:ai`      — review the branch vs `origin/main` now (engine from
  config). Add `--stamp` to also write the CI-bypass marker, `--fix` to be
  offered a y/n auto-fix, or `--fix-auto` to apply without asking.
- `pnpm review:loop`    — review → fix → re-review until approve or `maxLoops`
  (`--max N` to override). Fixes edit the working tree (uncommitted).
- On `git commit` / `git push` — the husky hooks (`.husky/pre-commit`,
  `.husky/pre-push`) call `scripts/agentflow/hook.mjs <trigger>`, which runs
  any feature whose `stage` matches. Failures warn but don't block (a
  `review` with `blocking: true` is the one exception — it can stop a push).

  **changeset at `stage: "push"`:** a pre-push hook can't add a file to the
  in-flight push, so when a changeset is generated the hook commits it and
  **holds the push** with `run git push again` — the second push includes it.
  At `stage: "commit"` it's folded straight into the commit instead.

## Auto-fix after review

`review.fix` (or the `--fix` / `--fix-auto` flags) controls what happens when a
review surfaces findings:

| `review.fix` | behavior (manual run)                                              |
| ------------ | ----------------------------------------------------------------- |
| `off`        | report only (default)                                             |
| `prompt`     | show findings, ask **y/n**, then apply with the local Claude CLI  |
| `auto`       | apply with the local Claude CLI without asking                    |

Fixes edit your **working tree** (uncommitted) via the Claude Code CLI
(`--permission-mode acceptEdits`); you review the diff and commit. Auto-fix is a
**manual** flow — a hook can't usefully edit a push, so the push hook just
prints `run \`pnpm review:ai --fix\``. The y/n prompt reads `/dev/tty`, so it
works even when stdin is busy.

**Blocking a push:** set `review.blocking: true` + `review.stage: "push"`. Then a
`request_changes` review makes the pre-push hook exit non-zero — a "nope" with
fix instructions (`pnpm review:ai --fix`, or `git push --no-verify` to skip
once).

## Review + CI bypass

`review.mjs` is a fast single-shot diff review (vs `origin/main`) — the
lightweight sibling of the CI agentic reviewer (`../review-pr.mjs`). Run it
locally for quick feedback before pushing.

To bypass the cloud reviewer, run `pnpm review:ai --stamp` **before** you push:
an *approving* review writes an empty `[agentflow-reviewed]` marker commit,
which the CI `pr-review` job detects and **skips the cloud reviewer** — you
reviewed locally, so it isn't re-done.

Stamping must happen before `git push` (manual `--stamp`, or `bypassCi: true` on
a non-hook run): a commit created *inside* the pre-push hook is **not** part of
the in-flight push, so the push-stage hook reviews for feedback but never
stamps — it just reminds you to run `--stamp` if you want the bypass.

Default OFF: the local single-shot pass is lighter than CI's agentic review, and
the marker is a trust convenience (any in-range commit can carry it), not a
security boundary. When you bypass, make sure a changeset exists too.

## Two primitives, composed into flows

There aren't really separate "review / fix / changeset" features — there are
**two primitives over the repo**, told apart by what they may do:

- **`review`** (`primitives/review.mjs`) — read-only **judge** → a verdict
  `{decision, findings}`. Fresh every call (independence is what makes it
  trustworthy). A re-review takes `priorFindings` as *data* to verify resolution.
- **`code`** (`primitives/code.mjs`) — read-write **actor** → mutates the working
  tree toward a goal, carrying a Claude session (`--session-id` then `--resume`)
  so it remembers its prior rounds.

Everything else composes them: **fix** = `code(goal from findings)`, **changeset**
= `code(goal: "write a changeset")`, **review-loop** = review → code → review.
The loop keeps the *actor* on one session (continuity) but the *judge* fresh
(independence) — `loop.mjs`.

## Pieces (the composable seams)

| file                          | role                                                        |
| ----------------------------- | ----------------------------------------------------------- |
| `config.mjs`                  | load + merge config, resolve engine                         |
| `llm.mjs`                     | engine router: `runLlm({engine})` → CLI or API; `stripFences`|
| `primitives/review.mjs`       | review primitive — `gatherDiff` + `reviewDiff` (judge)      |
| `primitives/code.mjs`         | code primitive — `runCode` (actor, session-carrying)        |
| `loop.mjs`                    | review→fix→re-review loop (composes the two primitives)     |
| `hook.mjs`                    | git-hook dispatcher (`commit`/`push` → matching features)   |
| `review.mjs`                  | single-shot review CLI (uses the primitives) + bypass marker|
| `../auto-changeset.mjs`       | changeset engine (engine-routed via `llm.mjs`)              |

## Extending

- **New engine** (e.g. `ollama`): add a branch in `llm.mjs#runLlm` and accept
  it in `config.mjs#resolveEngine`.
- **New flow** (e.g. `describe` = PR-body generator, or `lint`): compose the
  primitives — `review` for read-only analysis, `code` to act — keyed off config.
  CI and local share the engine + primitives; that's the point.
