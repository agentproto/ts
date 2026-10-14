---
"@agentproto/runtime": minor
"@agentproto/apps": patch
"@agentproto/cli": patch
"agentproto-vscode": patch
---

Add typed `SessionRestartError` (with helpers and types) to the runtime, and surface the typed restart failure reason through the apps panel bridge, the CLI `describeRestartFailure` output, and the VS Code extension.
