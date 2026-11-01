# @agentproto/storage-github

## 0.2.3

### Patch Changes

- @agentproto/storage@0.4.1

## 0.2.2

### Patch Changes

- Updated dependencies [d3dd524]
- Updated dependencies [5ab8114]
- Updated dependencies [5ab8114]
  - @agentproto/storage@0.4.0

## 0.2.1

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.
- Updated dependencies [74f982c]
- Updated dependencies [74f982c]
  - @agentproto/storage@0.3.1

## 0.2.0

### Minor Changes

- 0bc2def: A2 — git workspace lifecycle in the sandbox:

  - `@agentproto/runtime`: `appServe` pulls the app's declared `storage: github` `pull-push` workspace inside the box after `app_install` (new exports `readAppGithubWorkspaceSync`, `pullAppGithubWorkspace`, `boxGitRunner`, `boxSyncTree`), an opt-in close-time push rides `onBeforeTeardown` (`createGithubWorkspacePushAtClose`, `composeTeardownHooks`), token lookup via `resolveGithubWorkspaceToken`, and a failed seed clone in `app-workspace` now removes the just-created empty mount dir and warns on a failed auth scrub. New optional `exec` on `SandboxServeHost`.
  - `@agentproto/app-kit`: new `workspaceFromMarkdownText` parses `WORKSPACE.md` text without touching the filesystem (same manifest parse `loadAppHandle` runs), returning `undefined` for anything unparsable or schema-invalid.
  - `@agentproto/storage-github`: `GithubWorkspaceSyncOpts.gitRunner` now also accepts an `AsyncGitRunner`, so the sync contract can be driven over remote exec seams; `writeAuthConfig` is now async and accepts either runner shape.

- 0bc2def: A2 — git workspace lifecycle in the sandbox:

  - `app_install`'s seed-clone follow-ups in `app-workspace`: a failed seed clone now removes the just-created empty mount dir again (nothing of the user's is ever deleted — `rmdir` only succeeds when the dir is empty), and a failed persisted-auth scrub (`git config --remove-section` after a clone) is warned about instead of silently dropped, so the "no credential at rest" guarantee is self-checking.
  - `appServe` pulls the app's declared `storage: github` `pull-push` workspace INSIDE the box after `app_install` and before the UI server launches: empty/missing mount path is cloned, an existing checkout is fetched and merged `--ff-only` (a diverged local branch fails the pull, never clobbered). Git runs through the box's per-command exec seam (`boxGitRunner` is passed to `createGithubWorkspaceSync`), never the host's `spawnSync` against an in-box path. The GitHub token is resolved through the daemon's secrets broker (`resolveGithubWorkspaceTokenFromBroker`) — never ambient `process.env` — and `persistAuth: false` keeps it off the box's command line and out of `.git/config` (every git call injects it via `SandboxExecOpts.env`). `pull`'s outcome is read from a real discriminant (`PullResult.ok`), not a message substring. An invalid declaration, a missing token, or a failed pull is warned about and never breaks the serve.
  - Opt-in push at session close: a declaration carrying BOTH a non-`main` `sync.push.branch_policy` AND a non-`none` `pr_policy` opts in; the hook runs on the box proxy's `onBeforeTeardown` (the last moment the box filesystem is reachable), pushing the working tree as `agentproto/<session>` / `agentproto/turn-<id>` per the branch policy, never the base branch. It is wired on the spawn path AND on the restart/re-attach paths, so a resumed session pushes like a fresh one. Without the declaration (or with `main`), nothing pushes. Failures are warned, never block the teardown.
  - `@agentproto/app-kit` gains `workspaceFromMarkdownText`: parse WORKSPACE.md text without touching the filesystem — the same manifest parse `loadAppHandle` runs on the file, lifted to a string so a caller holding text read from a box gets the identical validated handle (returns `undefined` for anything unparsable).
  - `@agentproto/storage-github`: `GithubWorkspaceSyncOpts.gitRunner` now also accepts an async runner (per-call `await`; sync runners unchanged), a new `persistAuth` opt (default `true`) can skip persisting the auth header for remote-seam runs, and `pull` now reports `PullResult.ok` on every path. `@agentproto/storage`'s `PullResult` gains that optional `ok` discriminant (a healthy refresh is `seeded: false, ok: true`; a failed clone/fetch/merge is `ok: false`).

### Patch Changes

- efd7192: Fix GitHub token authentication for git commands: `buildGitEnv` now carries the token as an `http.https://github.com/.extraheader` config entry via git's native `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0` mechanism instead of the non-existent `GIT_HTTP_EXTRAHEADER`, restoring authenticated clone/fetch/push against private repos.
- efd7192: Fix GitHub token authentication for git commands: `buildGitEnv` now injects the token as an `http.https://github.com/.extraheader` config entry via `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` instead of `GIT_HTTP_EXTRAHEADER` (a variable git does not implement — the header never reached the wire, so private-repo clones 401'd and pushes were unauthenticated).
- Updated dependencies [0bc2def]
  - @agentproto/storage@0.3.0

## 0.1.6

### Patch Changes

- Updated dependencies [4243c75]
  - @agentproto/storage@0.2.0

## 0.1.5

### Patch Changes

- @agentproto/storage@0.1.4

## 0.1.4

### Patch Changes

- Updated dependencies [c27f0b8]
  - @agentproto/storage@0.1.3

## 0.1.3

### Patch Changes

- 2f37e7b: Bump third-party dependency versions (weekly deps update)
- Updated dependencies [2f37e7b]
  - @agentproto/storage@0.1.2

## 0.1.2

### Patch Changes

- Updated dependencies [f0c51a7]
  - @agentproto/storage@0.1.1

## 0.1.1

### Patch Changes

- 7b53b8c: Relicense all packages from MIT to Apache-2.0
- a32bb69: Bump test timeouts on subprocess/IO-heavy tests that flake under parallel load
- Updated dependencies [7b53b8c]
  - @agentproto/storage@0.1.0

## 0.1.0

### Minor Changes

- f6d2ddd: Add @agentproto/storage-github — AIP-35 GitHub WorkspaceSync provider

### Patch Changes

- 6cc9e25: Dedupe sandbox capability constant, drop redundant author guard + unused token-env export
