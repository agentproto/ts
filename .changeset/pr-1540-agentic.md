---
"@agentproto/apps": minor
"@agentproto/runtime": minor
---

Review panel: the agent-lane reviewer-session link now deep-links the live-session widget as a real per-session URL (`/apps/@agentproto/live-session/ui?sessionId=<id>`), opened via `openLink` with a `window.open` fallback — the same convention session-chat's card link uses. Runtime's `handleAppUiPage` reads the `sessionId` query param, validates it (`isValidDeepLinkSessionId`), and bakes it into the live-session widget's `window.__APP_INIT__` so it boots already pinned to that session; invalid or absent ids are ignored and every other builtin's html is served byte-identical. `REVIEW_PANEL_UI_TOOLS` keeps only the review tools (the deep link is a navigation, not a `tools/call`), and the panel exports `liveSessionUrl`.