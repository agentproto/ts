# agentproto-vscode

## 0.2.0

### Minor Changes

- d14fc55: Add per-window workspace pinning feature to prevent the daemon's global `active` workspace from being mutated across VS Code windows. Includes new `agentproto.selectWorkspace` command, status bar indicator, and spawn wizard integration.
- ed0c269: Add terminal input endpoint and UI toggle for conversation/terminal view switching.
  - HTTP endpoint `POST /sessions/:id/terminal/input` for writing raw input to PTY sessions (FIX 2)
  - DaemonClient method `writeTerminalInput` for terminal input requests
  - VSCode UI: Conversation⇄Terminal segmented toggle for sessions with both representations
  - Routing: Terminal sessions now use `writeTerminalInput` instead of `prompt` endpoint
  - View toggle logic for agent-cli and native-conversation PTY sessions

- 4632ec7: Session management feature set: terminal input routing via POST /sessions/:id/terminal/input, session renaming via PATCH /sessions/:id and session_rename MCP tool, explicit --title flag for spawn, and structured↔terminal view toggle for dual-representation sessions. Includes code-point-aware name truncation, field-independent rename operations, and comprehensive test coverage.
- acd978d: Cut the VS Code extension stable Marketplace release to catch up with the features accumulated on `main` since v0.1.2: mid-session model switch from the conversation panel, capability-resolved session-config picker, workspace-grouped sessions panel with a create-workspace CTA, continuous restart-history transcript with resumed-from dedupe, archivable terminal sessions, and workspace-registry mutation over HTTP.

  The pre-release channel (`vscode-release.yml`, per push) already shipped these; the extension is `private` and excluded from the reviewer's auto-changeset on purpose, so the stable channel is cut deliberately rather than on every push. This is that deliberate cut.

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
