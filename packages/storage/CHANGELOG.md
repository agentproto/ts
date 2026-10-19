# @agentproto/storage

## 0.3.1

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [74f982c]
- Updated dependencies [74f982c]
  - @agentproto/define-doctype@0.1.4
  - @agentproto/policy@0.1.5

## 0.3.0

### Minor Changes

- 0bc2def: A2 — git workspace lifecycle in the sandbox:

  - `app_install`'s seed-clone follow-ups in `app-workspace`: a failed seed clone now removes the just-created empty mount dir again (nothing of the user's is ever deleted — `rmdir` only succeeds when the dir is empty), and a failed persisted-auth scrub (`git config --remove-section` after a clone) is warned about instead of silently dropped, so the "no credential at rest" guarantee is self-checking.
  - `appServe` pulls the app's declared `storage: github` `pull-push` workspace INSIDE the box after `app_install` and before the UI server launches: empty/missing mount path is cloned, an existing checkout is fetched and merged `--ff-only` (a diverged local branch fails the pull, never clobbered). Git runs through the box's per-command exec seam (`boxGitRunner` is passed to `createGithubWorkspaceSync`), never the host's `spawnSync` against an in-box path. The GitHub token is resolved through the daemon's secrets broker (`resolveGithubWorkspaceTokenFromBroker`) — never ambient `process.env` — and `persistAuth: false` keeps it off the box's command line and out of `.git/config` (every git call injects it via `SandboxExecOpts.env`). `pull`'s outcome is read from a real discriminant (`PullResult.ok`), not a message substring. An invalid declaration, a missing token, or a failed pull is warned about and never breaks the serve.
  - Opt-in push at session close: a declaration carrying BOTH a non-`main` `sync.push.branch_policy` AND a non-`none` `pr_policy` opts in; the hook runs on the box proxy's `onBeforeTeardown` (the last moment the box filesystem is reachable), pushing the working tree as `agentproto/<session>` / `agentproto/turn-<id>` per the branch policy, never the base branch. It is wired on the spawn path AND on the restart/re-attach paths, so a resumed session pushes like a fresh one. Without the declaration (or with `main`), nothing pushes. Failures are warned, never block the teardown.
  - `@agentproto/app-kit` gains `workspaceFromMarkdownText`: parse WORKSPACE.md text without touching the filesystem — the same manifest parse `loadAppHandle` runs on the file, lifted to a string so a caller holding text read from a box gets the identical validated handle (returns `undefined` for anything unparsable).
  - `@agentproto/storage-github`: `GithubWorkspaceSyncOpts.gitRunner` now also accepts an async runner (per-call `await`; sync runners unchanged), a new `persistAuth` opt (default `true`) can skip persisting the auth header for remote-seam runs, and `pull` now reports `PullResult.ok` on every path. `@agentproto/storage`'s `PullResult` gains that optional `ok` discriminant (a healthy refresh is `seeded: false, ok: true`; a failed clone/fetch/merge is `ok: false`).

## 0.2.0

### Minor Changes

- 4243c75: Wire AIP-38 policy block into storage; add AIP-16 IO schema well-formedness checks to tool manifests

## 0.1.4

### Patch Changes

- Updated dependencies [461df5e]
  - @agentproto/define-doctype@0.1.3

## 0.1.3

### Patch Changes

- c27f0b8: Weekly minor/patch dependency bumps across workspaces (zod, @mastra/*, react, yaml, claude-agent-sdk, etc.).

## 0.1.2

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [2f37e7b]
  - @agentproto/define-doctype@0.1.2

## 0.1.1

### Patch Changes

- f0c51a7: Weekly dependency bump: update 9 minor/patch dependencies to latest versions.
  - @anthropic-ai/claude-agent-sdk 0.3.241 → 0.3.251
  - @ast-grep/napi 0.45.2 → 0.45.3
  - @earendil-works/pi-tui 0.84.2 → 0.84.4
  - @tanstack/react-query 5.102.2 → 5.102.8
  - @testing-library/react 16.3.2 → 16.3.3
  - e2b 2.45.0 → 2.46.1
  - tsx 4.23.12 → 4.23.13
  - turbo 2.10.11 → 2.10.12
  - zod 4.4.3 → 4.5.4

  No code changes; pnpm-lock.yaml updated to reflect new dependency versions.

## 0.1.0

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- Updated dependencies [7b53b8c]
  - @agentproto/define-doctype@0.1.1
