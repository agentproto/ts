---
"agentproto-vscode": minor
---

Enhance VS Code webview's long-running tool call handling with progressive elapsed time display, smooth label fade animations, intelligent fallback labels for stale tools, and de-alarming of the blocked note. The "$ now:" line now shows contextual information (Watching executor, activity summary, or Working) for steps older than 30 seconds, improving UX for supervision workflows. The blocked note is hidden when the live "$ now:" line already narrates the in-flight step, reducing redundancy.
