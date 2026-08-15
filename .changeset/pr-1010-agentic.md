---
"@agentproto/cli": minor
---

Add `agentproto pack build [dir]` command to centralize skill-pack build logic, eliminating per-package duplicate scripts. The command builds both a flat npm layout and a versioned bundle for the Anthropic consumer, with version sourced from the package's own package.json (aligned with changesets).
