---
"@agentproto/apps": minor
---

Review panel: the agent-lane reviewer-session link now deep-links the live-session widget via the existing `live_session` tool (same `_meta.ui.resourceUri` auto-render mechanism as agent_start's session-chat launcher) instead of a session-less `openLink`, so the host opens/focuses the widget pinned to that exact session. `live_session` was added to `REVIEW_PANEL_UI_TOOLS`, and the panel now exports `SESSION_LINK_TOOL`/`sessionLinkCall`.
