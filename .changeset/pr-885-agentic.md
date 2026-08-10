---
"@agentproto/runtime": patch
"agentproto-vscode": minor
---

Parked-background-task detection, watch/unwatch sessions, watcher visibility.

**Runtime** (`@agentproto/runtime`, patch):
- Detect sessions parked with pending background tasks (run_in_background tool calls that end a turn without triggering a wake-up). Emit session:bg-tasks-parked / session:bg-tasks-cleared events; stamp pendingBgTasks count on descriptor.
- Watcher attach/detach events: emit session:watcher-attached / session:watcher-detached when a blocking wait subscribes/unsubscribes, reporting the watcher count and supervising session id (when the wait came through the scoped orchestrator).

**VS Code** (`agentproto-vscode`, minor):
- Watch/unwatch commands: pin an eye on sessions so transitions into needs-you / stalled / parked-bg / failed / done raise toasts (debounced per state). Persisted per workspace; toggleable from tree and command palette.
- Parked-bg activity state (needs-you > stalled > parked-bg > working > idle) with clock/warning icon, bg-task count in tree description + tooltip, '⏳ N bg tasks' webview chip.
- Watcher visibility: info banner when a watcher attaches to the session you're watching, user-prompt badges when another session injected the message, and attributed history in the transcript.
