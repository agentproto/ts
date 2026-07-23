---
"@agentproto/runtime": minor
"agentproto-vscode": minor
---

Dynamic session activity line: secondary, auto-regenerating label showing what each session is doing now. Regenerated on turn-end from heuristics (ANSI-stripped last assistant/tool line + lifecycle state); frozen for human-renamed sessions; throttled to ≥60s interval. Displayed as the leading segment of the sessions tree row (sidebar-truncated to 72 chars) and in full in the tooltip.
