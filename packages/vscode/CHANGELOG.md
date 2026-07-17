# agentproto-vscode

## 0.1.1

### Patch Changes

- 6a8b548: Fix Stop painted as crash; replace lifecycle with activity axis in tree icons and status bar
- 6fda931: Fix sidebar: auto-refresh on clock, unread dot read-receipt, optimistic spawn row

## 0.1.0

### Minor Changes

- af7ab1f: Fix transcript-writer seq collision after daemon restart; add structured VS Code conversation rendering
- eaa33b5: Add sessions tree filters/search/grouping, workspace autodetect on spawn, and session restart via MCP
- f913b43: Add agentproto.openTerminal — real Pseudoterminal mirror for PTY and agent-cli sessions

### Patch Changes

- c430b9f: Harden SSE reconnect sleep cancellation, poll-loop disposal guards, and webview hydration
- 4fce66e: Add pack registry, tool-header wildcard filtering, and vscode VSIX packaging script
