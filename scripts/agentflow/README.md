# agentflow — local agentic dev helpers

Composable, opt-in helpers that run the same engines locally that CI runs in
the cloud — so you can get a changeset (and, soon, a review) **before** you
push, instead of waiting for the CI bot to generate one and re-trigger the
pipeline.

## Two axes, per feature

| axis     | values                     | meaning                                              |
| -------- | -------------------------- | ---------------------------------------------------- |
| `stage`  | `manual` · `commit` · `push` | when a git hook runs it (`manual` = only on demand)  |
| `engine` | `local` · `cloud` · `daemon` | `local` = Claude Code CLI (your sub); `cloud` = API; `daemon` = `review` only — the CI lane's full pr-review WORKFLOW.md, run through your local `agentproto serve` daemon (see below) |

### `review`'s three engines

| engine   | what runs                                                                             | diff cap                     | needs                                                     |
| -------- | -------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------- |
| `local`  | single-shot judge over the diff (`primitives/review.mjs#reviewDiff`), Claude Code CLI  | `DIFF_CAP` (16k chars)         | Claude Code CLI (subscription)                              |
| `cloud`  | same single-shot judge, via `api.anthropic.com`                                       | `DIFF_CAP` (16k chars)         | `ANTHROPIC_API_KEY`                                          |
| `daemon` | the SAME agentic review CI runs — `.github/agentproto-workflows/pr-review/WORKFLOW.md`, `placement: "local"`, full tool access (reads the live checkout, greps, follows references) | none — the agent reads the checkout itself | `agentproto serve` running locally (default port 18790) |

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
- `pnpm cli-docs:check` — deterministic. A verb with no `docs/cli/verbs/` page
  is an **error** (exits non-zero) — wired as `pretest`, so it gates `pnpm test`.
  A drifted `agentproto <ver>` example is an **advisory warning** (never fails
  the gate, so a version bump can't strand CI); `cli-docs:ai` fixes it.
- `pnpm cli-docs:ai`    — the fix flow: the detector's gaps become a goal the
  `code` actor writes (new verb pages, version fixes), then it re-checks
  coverage. Edits are uncommitted — commit, then `pnpm review:ai` (or CI) judges.
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

`review.mjs` reviews the branch vs `origin/main` before you push, via one of
three engines (see the table above). `local`/`cloud` are a fast single-shot
diff review — the lightweight sibling of the CI agentic reviewer
(`../review-pr.mjs`). `daemon` runs the CI reviewer's own workflow, unabridged,
on your machine — see "`review`'s three engines" above.

To bypass the cloud reviewer, run `pnpm review:ai --stamp` **before** you push:
an *approving* review writes an empty `[agentflow-reviewed]` marker commit,
which the CI `pr-review` job detects and **skips the cloud reviewer** — you
reviewed locally, so it isn't re-done.

Stamping must happen before `git push` (manual `--stamp`, or `bypassCi: true` on
a non-hook run): a commit created *inside* the pre-push hook is **not** part of
the in-flight push, so the push-stage hook reviews for feedback but never
stamps — it just reminds you to run `--stamp` if you want the bypass.

Default OFF: the marker is a trust convenience (any in-range commit can carry
it), not a security boundary. When you bypass, make sure a changeset exists
too. (This caveat used to also note that the local pass is lighter than CI's
— that's still true for `local`/`cloud`, but engine `daemon` runs the exact
same workflow CI does, so there's no strength gap to weigh there.)

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
| `primitives/review.mjs`       | review primitive — `gatherDiff`/`gatherChangedFiles` + `reviewDiff` (single-shot judge) + `reviewViaDaemon` (engine `daemon`) |
| `primitives/code.mjs`         | code primitive — `runCode` (actor, session-carrying)        |
| `../lib/daemon-mcp.mjs`       | local-daemon MCP contract: read the bearer token, connect, drive `workflow_run_file` to a terminal status, read a session's output tail — what `reviewViaDaemon` is built on |
| `loop.mjs`                    | review→fix→re-review loop (composes the two primitives)     |
| `docs.mjs`                    | cli-docs flow — deterministic coverage detector + `code` (+ `review`) |
| `hook.mjs`                    | git-hook dispatcher (`commit`/`push` → matching features)   |
| `review.mjs`                  | single-shot review CLI (uses the primitives) + bypass marker|
| `../auto-changeset.mjs`       | changeset engine (engine-routed via `llm.mjs`)              |

## Extending

- **New engine** (e.g. `ollama`): add a branch in `llm.mjs#runLlm` and accept
  it in `config.mjs#resolveEngine`.
- **New flow** (e.g. `describe` = PR-body generator, or `lint`): compose the
  primitives — `review` for read-only analysis, `code` to act — keyed off config.
  CI and local share the engine + primitives; that's the point. `docs.mjs` is a
  worked example: a **deterministic** detector (verb-set ↔ pages, version drift)
  finds the gap and feeds the goal, `code` writes the fix, and the detector
  doubles as a `--check` gate so the same drift can't return.
