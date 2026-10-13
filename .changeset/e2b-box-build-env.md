---
"@agentproto/sandbox-e2b": minor
---

The e2b provider sizes Node builds to the box: it derives `NODE_OPTIONS=--max-old-space-size=…` plus `npm_config_workspace_concurrency` / `TURBO_CONCURRENCY` from the resolved size preset (probed from the box with `nproc` / `free -m` for an explicit custom `template`) and ships them to every in-box process through the daemon's start env and `/etc/profile.d/agentproto-build.sh`, tunable or disableable via `config.buildEnv`, with a caller-provided value for the same var always winning.
