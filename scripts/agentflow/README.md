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
  config). Add `--stamp` to also write the CI-bypass marker.
- On `git commit` / `git push` — the husky hooks (`.husky/pre-commit`,
  `.husky/pre-push`) call `scripts/agentflow/hook.mjs <trigger>`, which runs
  any feature whose `stage` matches. Failures warn but don't block (a
  `review` with `blocking: true` is the one exception — it can stop a push).

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

## Pieces (the composable seams)

| file                          | role                                                        |
| ----------------------------- | ----------------------------------------------------------- |
| `config.mjs`                  | load + merge config, resolve engine                         |
| `llm.mjs`                     | engine router: `runLlm({engine})` → CLI or API; `stripFences`|
| `hook.mjs`                    | git-hook dispatcher (`commit`/`push` → matching features)   |
| `review.mjs`                  | local diff review (engine-routed) + CI-bypass marker        |
| `../auto-changeset.mjs`       | changeset engine (engine-routed via `llm.mjs`)              |

## Extending

- **New engine** (e.g. `ollama`): add a branch in `llm.mjs#runLlm` and accept
  it in `config.mjs#resolveEngine`.
- **New feature** (e.g. `lint`): add a key to `DEFAULTS` in `config.mjs`, a
  block in `hook.mjs`, and an engine script that calls `runLlm`. CI and local
  share the engine — that's the point.
