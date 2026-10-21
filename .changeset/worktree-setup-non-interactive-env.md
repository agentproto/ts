---
"@agentproto/worktree": patch
---

Make daemon-spawned worktree setup hooks non-interactive: `worktree.setup` and
`depsCmd` now run with `CI=true` and
`npm_config_confirm_modules_purge=false` (unless the caller already set
them), and with stdin closed instead of a pipe. Fixes
`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` killing `agent_start`
worktree provisioning.
