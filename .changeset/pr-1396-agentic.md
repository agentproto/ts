---
"@agentproto/cli": minor
---

New `agentproto doctor` verb: a read-only health check of the whole install (Node, workspace, daemon, agent harnesses, auth, MCP clients, skills), with `--json`, `--only`/`--skip` step selection, actionable fix commands, and an exit code driven by required steps. Backed by a new `onboarding` step framework shared with the upcoming setup wizard.
