---
"@agentproto/runtime": minor
"agentproto-vscode": minor
---

feat(runtime): expose session-story-panel module in package exports

feat(vscode): live session-story webview panel with "Open story" command

Reuses SESSION_STORY_PANEL_HTML from @agentproto/runtime byte-for-byte inside a VS Code webview panel (srcdoc iframe relay pattern). Adds agentproto.openStory command to open any session's live timeline, wired into the spawn wizard and session tree context menu.

The panel drives itself over JSON-RPC 2.0 postMessage, calling session_list/agent_export/agent_prompt via StoryPanelController — a testable bridge mapping the panel's three tools onto DaemonClient.
