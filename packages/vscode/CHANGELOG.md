# agentproto-vscode

## 0.1.2

### Patch Changes

- d29d7fb: Re-resolve daemon bearer on stale-token 401 and fix token resolution order

## 0.1.1

### Minor Changes

- bbc5070: Composer: stop button, and prompt history on ↑/↓
- 702cb00: Composer: drag-and-drop, `@file` mentions, and attachment chips
- 67dda1f: Composer: paste an image straight into the transcript
- 9cf0cd8: Collapse the transcript header to one line
- 90bc763: Render a step as a row rather than a box
- dee0923: Let the stop confirmation be dismissed for good
- 41e46b7: The transcript tab wears the read-receipt too

### Patch Changes

- 6a8b548: Fix Stop painted as crash; replace lifecycle with activity axis in tree icons and status bar
- 6fda931: Fix sidebar: auto-refresh on clock, unread dot read-receipt, optimistic spawn row
- 5a7ed25: Fix a reaped-after-finishing subagent reading as stopped rather than complete
- 9cec8c5: Fix picking claude-sdk's kimi-k2.7-code spawning against real Anthropic
- bf23320: Fix emphasis failing to span a code span in the transcript renderer
- 8f8d048: Fix VSIX packaging and auto-publish to the Marketplace

## 0.1.0

### Minor Changes

- af7ab1f: Fix transcript-writer seq collision after daemon restart; add structured VS Code conversation rendering
- eaa33b5: Add sessions tree filters/search/grouping, workspace autodetect on spawn, and session restart via MCP
- f913b43: Add agentproto.openTerminal — real Pseudoterminal mirror for PTY and agent-cli sessions

### Patch Changes

- c430b9f: Harden SSE reconnect sleep cancellation, poll-loop disposal guards, and webview hydration
- 4fce66e: Add pack registry, tool-header wildcard filtering, and vscode VSIX packaging script
