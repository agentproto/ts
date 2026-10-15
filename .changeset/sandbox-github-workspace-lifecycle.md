---
"@agentproto/runtime": minor
"@agentproto/app-kit": minor
"@agentproto/storage-github": minor
---

A2 — git workspace lifecycle in the sandbox:

- `app_install`'s seed-clone follow-ups in `app-workspace`: a failed seed clone now removes the just-created empty mount dir again (nothing of the user's is ever deleted — `rmdir` only succeeds when the dir is empty), and a failed persisted-auth scrub (`git config --remove-section` after a clone) is warned about instead of silently dropped, so the "no credential at rest" guarantee is self-checking.
- `appServe` pulls the app's declared `storage: github` `pull-push` workspace inside the box after `app_install` and before the UI server launches: empty/missing mount path is cloned, an existing checkout is fetched and merged `--ff-only` (a diverged local branch fails the pull, never clobbered). The git calls reuse `createGithubWorkspaceSync`'s pull contract through an async git runner over the box's per-command exec seam — the GitHub token travels only in `SandboxExecOpts.env`, never on a command line — and a seed clone's persisted auth header is scrubbed like the host-side clone. An invalid declaration, a missing token, or a failed pull is warned about and never breaks the serve.
- Opt-in push at session close: a declaration carrying BOTH a non-`main` `sync.push.branch_policy` AND a non-`none` `pr_policy` opts in; the hook runs on the box proxy's `onBeforeTeardown` (the last moment the box filesystem is reachable), pushing the working tree as `agentproto/<session>` / `agentproto/turn-<id>` per the branch policy, never the base branch. Without the declaration (or with `main`), nothing pushes. Failures are warned, never block the teardown.
- `@agentproto/app-kit` gains `workspaceFromMarkdownText`: parse WORKSPACE.md text without touching the filesystem — the same manifest parse `loadAppHandle` runs on the file, lifted to a string so a caller holding text read from a box gets the identical validated handle (returns `undefined` for anything unparsable).
- `@agentproto/storage-github`: `GithubWorkspaceSyncOpts.gitRunner` now also accepts an async runner (per-call `await`; sync runners unchanged), so the sync contract can be driven over remote exec seams, not only host-local spawnSync.
