---
"agentproto-vscode": minor
---

Cut the VS Code extension stable Marketplace release to catch up with the features accumulated on `main` since v0.1.2: mid-session model switch from the conversation panel, capability-resolved session-config picker, workspace-grouped sessions panel with a create-workspace CTA, continuous restart-history transcript with resumed-from dedupe, archivable terminal sessions, and workspace-registry mutation over HTTP.

The pre-release channel (`vscode-release.yml`, per push) already shipped these; the extension is `private` and excluded from the reviewer's auto-changeset on purpose, so the stable channel is cut deliberately rather than on every push. This is that deliberate cut.
