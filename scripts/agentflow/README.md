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
- On `git commit` / `git push` — the husky hooks (`.husky/pre-commit`,
  `.husky/pre-push`) call `scripts/agentflow/hook.mjs <trigger>`, which runs
  any feature whose `stage` matches. Failures warn but don't block.

## Pieces (the composable seams)

| file                          | role                                                        |
| ----------------------------- | ----------------------------------------------------------- |
| `config.mjs`                  | load + merge config, resolve engine                         |
| `llm.mjs`                     | engine router: `runLlm({engine})` → CLI or API; `stripFences`|
| `hook.mjs`                    | git-hook dispatcher (`commit`/`push` → matching features)   |
| `../auto-changeset.mjs`       | changeset engine (now engine-routed via `llm.mjs`)          |

## Extending

- **New engine** (e.g. `ollama`): add a branch in `llm.mjs#runLlm` and accept
  it in `config.mjs#resolveEngine`.
- **New feature** (e.g. `lint`, `review`): add a key to `DEFAULTS` in
  `config.mjs`, a block in `hook.mjs`, and an engine script that calls
  `runLlm`. CI and local share the engine — that's the point.
- **CI bypass** (Task 2): a local feature that passes will stamp a commit
  trailer the CI step checks, so local work isn't re-done in the cloud.
