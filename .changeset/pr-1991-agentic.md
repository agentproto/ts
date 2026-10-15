---
"@agentproto/runtime": minor
"@agentproto/app-kit": minor
"@agentproto/storage-github": minor
---

A2 — git workspace lifecycle in the sandbox:

- `@agentproto/runtime`: `appServe` pulls the app's declared `storage: github` `pull-push` workspace inside the box after `app_install` (new exports `readAppGithubWorkspaceSync`, `pullAppGithubWorkspace`, `boxGitRunner`, `boxSyncTree`), an opt-in close-time push rides `onBeforeTeardown` (`createGithubWorkspacePushAtClose`, `composeTeardownHooks`), token lookup via `resolveGithubWorkspaceToken`, and a failed seed clone in `app-workspace` now removes the just-created empty mount dir and warns on a failed auth scrub. New optional `exec` on `SandboxServeHost`.
- `@agentproto/app-kit`: new `workspaceFromMarkdownText` parses `WORKSPACE.md` text without touching the filesystem (same manifest parse `loadAppHandle` runs), returning `undefined` for anything unparsable or schema-invalid.
- `@agentproto/storage-github`: `GithubWorkspaceSyncOpts.gitRunner` now also accepts an `AsyncGitRunner`, so the sync contract can be driven over remote exec seams; `writeAuthConfig` is now async and accepts either runner shape.
