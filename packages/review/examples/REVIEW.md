---
kind: review
id: agentproto-ts
name: agentproto/ts review
description: Pre-push and PR review for the agentproto/ts monorepo.
target:
  kind: git-range
  base: origin/main
checks:
  - {id: types, kind: command, run: "turbo run check-types --filter={changed}"}
  - {id: changeset, kind: command, run: "pnpm changeset:auto", effects: true}
  - {id: build, kind: command, run: "turbo run build --filter={changed}"}
  - {id: correctness, kind: agent, preset: kimi, fallbackPresets: [opencode-default-go], rubric: ./rubrics/correctness.md, blockOn: high}
bindings:
  local: {on: pre-push, prepare: [changeset], checks: [types, correctness]}
  ci:    {on: pr, checks: [build, correctness]}
verdict:
  exportDir: .reviews
---

# agentproto/ts review

- **local** (`pre-push`): writes the changeset first (`changeset` is
  `effects: true`, so it may only ever run in `prepare`), then freezes the
  range and runs `types` + the `correctness` reviewer in parallel.
- **ci** (`pr`): `build` + the same `correctness` reviewer.

`correctness` reviews with `kimi`; if that reviewer is unavailable (spawn or
transport error, empty turn) the lane falls back to `opencode-default-go`. A
reviewer's verdict is never second-guessed: fallbacks apply only to an
unavailable reviewer, and the lane records which preset actually ran.

`{changed}` is the host's changed-package filter for the frozen range.
