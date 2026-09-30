# Secrets — GitHub Copilot CLI

The adapter injects nothing itself; the `copilot` binary reads its own
credentials from the spawn environment (or its stored login). The env vars it
honors, in documented precedence order:

| Variable | Scope | Notes |
| -------- | ----- | ----- |
| `COPILOT_GITHUB_TOKEN` | github.com / ghe.com | Highest precedence. |
| `GH_TOKEN` | github.com / ghe.com | Common ambient `gh` var. |
| `GITHUB_TOKEN` | github.com / ghe.com | |
| `GH_ENTERPRISE_TOKEN` | GitHub Enterprise Server | |
| `GITHUB_ENTERPRISE_TOKEN` | GitHub Enterprise Server | Lower precedence than `GH_ENTERPRISE_TOKEN`. |

Supported token types: OAuth (`gho_`), fine-grained PAT with the **"Copilot
Requests"** permission (`github_pat_`, owned by a personal account), and GitHub
App user-to-server (`ghu_`). **Classic PATs (`ghp_`) are not supported.**

When no token env var is set, the CLI falls back to its stored OAuth login
(system keychain, or `~/.copilot/config.json` / `COPILOT_HOME`), then to
`gh auth token`.

For GitHub Enterprise, also set `GH_HOST` to the enterprise hostname — the
adapter's `github_host` option does this.
