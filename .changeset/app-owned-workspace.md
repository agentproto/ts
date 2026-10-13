---
"@agentproto/runtime": minor
---

Every installed app now owns a registered workspace (`app-<slug>`, marked with `ownerApp` in `workspaces.json`). `app_install`/`app_apply` register it (WORKSPACE.md `local-fs.mount_path` / `dev-local.root` when present, else the app dir), `app_uninstall` removes it only when that app owns it, and `app_run` plus app-attributed workflow runs spawn sessions into it instead of `default` unless the caller passes an explicit `cwd`. Apps installed earlier are backfilled lazily at `app_run`. App-owned entries never become the implicit active workspace, and a user workspace with the same slug is never overwritten.
