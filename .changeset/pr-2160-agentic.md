---
"@agentproto/worktree": minor
---

Worktree setup/teardown hooks and `depsCmd` installs now run non-interactively:
they receive `CI=true` and `npm_config_confirm_modules_purge=false` as defaults
(an explicit ambient or caller-supplied value still wins) and their stdin is
closed rather than piped. This fixes `pnpm install` aborting with
`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` during `agent_start` worktree
provisioning. The non-interactive env helpers `nonInteractiveEnv` and
`NON_INTERACTIVE_ENV_DEFAULTS` are newly exported from `@agentproto/worktree`.
