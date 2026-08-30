---
"agentproto-vscode": minor
---

Add slash-command popup UI for browsing and quickly inserting available harness commands. Users can type `/` at the start of the composer to filter commands by name with keyboard navigation (arrow keys, enter/tab to choose, escape to close). Includes a new optional `availableCommands` field in `SessionDescriptor` mirroring `@agentproto/runtime`, aligned with ACP's `available_commands_update` standard.
