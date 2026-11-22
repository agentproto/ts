---
"@agentproto/adapter-browser": patch
"@agentproto/adapter-browser-chrome": patch
"@agentproto/agent": patch
"@agentproto/catalog-sync": patch
"@agentproto/delivery": patch
"@agentproto/model-routing": patch
"@agentproto/operator": patch
"@agentproto/plugin-local-browser": patch
"@agentproto/policy": patch
"@agentproto/review": patch
"@agentproto/tooling": patch
"@agentproto/work": patch
"agentproto-vscode": patch
---

Covers the packages the PR's own changesets (`remove-private-names.md`, `voice-kit-turn-settings.md`) miss. Private product and repository names were scrubbed from comments, docs, changelogs, fixtures and tests in these packages; no runtime behavior changes (changelog/docs/test-only edits, plus the catalog-sync ledger key noted in the review).
