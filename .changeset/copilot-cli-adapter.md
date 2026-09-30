---
"@agentproto/adapter-copilot-cli": minor
"@agentproto/cli": minor
---

Add `@agentproto/adapter-copilot-cli`, an AIP-45 adapter for GitHub's official
Copilot CLI, and register it in the CLI's install catalog.

- New `adapters/copilot-cli` package: drives the CLI's first-party ACP server
  (`copilot --acp --stdio`) — NDJSON JSON-RPC 2.0 over stdio, public preview
  since Copilot CLI 0.0.397. Model and reasoning effort are applied via ACP
  session config options; sessions are persistent and resumable (`session/load`,
  0.0.410+). Auth is the documented GitHub token set
  (`COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN`, plus
  `GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN` for GitHub Enterprise Server),
  with a `github_host` option setting `GH_HOST` for Enterprise. No catalog
  `provider` is declared — Copilot bills through the GitHub subscription.
- `@agentproto/cli`: new `copilot-cli` entry in the bundled install catalog.
