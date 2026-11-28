---
"@agentproto/runtime": patch
---

fix(runtime): apply the browser-origin gate to every read route that returns local state. GET/HEAD routes other than `/health` now refuse a foreign browser `Origin` (including `null`) unless the request carries the daemon bearer, the per-boot token, a widget embed token or a link-session credential; allowlisted origins and native clients (no `Origin`) are unchanged, and `/health` keeps its permissive CORS. Previously only some read routes (`/conversations`, `/events`, `/workspaces`, `/worktrees`) were gated.
