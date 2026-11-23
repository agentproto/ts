---
"@agentproto/runtime": minor
"@agentproto/cli": minor
"@agentproto/apps": patch
---

Repo maintenance covers every repo the operator's own config names, from the CLI and from the daemon.

- New `maintain` section in `~/.agentproto/config.json` (`discover`, `repos`, `exclude`, `maxReviews`, `reviewPreset`, `notify`), typed and validated like the rest of the config.
- New `@agentproto/runtime/maintain-repos` module: worktree-owning repo discovery plus `resolveMaintainRepos(config, extra)` (discover/repos/exclude, deduped by realpath of the main repo root), shared by the CLI and the daemon.
- New daemon tool `maintain_run` (`all` or `repos`, `applyMerged`, `applyReviewed`, `requireOperatorBelowGuard`, `maxReviews`, `reviewPreset`, `notify`): installs the repo-maintenance app, starts one background `maintain` run per repo and returns `{repo, runId}` at once. A repo that fails to start does not stop the others. Usable from MCP and as a routine `target.tool`.
- `agentproto maintain --all` honors `maintain.discover/repos/exclude`, and every `maintain` run takes `maxReviews`/`reviewPreset`/`notify` from the config when the flags are absent (flags win). An invalid `maintain` section exits 2.
- The shipped `repo-maintenance-daily`/`-weekly` routines now target `maintain_run` with `all: true` and hold no repo path and no chat id.
