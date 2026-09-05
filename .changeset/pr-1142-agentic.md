---
"@agentproto/sandbox-e2b": patch
---

Fix adapter installation in e2b template: use one ARG per package instead of space-separated list (E2B's builder mangles spaces in ENV values), consolidate toolchain into single `npm i -g` invocation, and generate Dockerfile from versions.json to prevent pin drift.
