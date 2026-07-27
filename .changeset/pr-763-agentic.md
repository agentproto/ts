---
"@agentproto/runtime": patch
"agentproto-vscode": patch
"@agentproto/sandbox-box": patch
---

## Progressive Sessions Webview Loading

Introduces a new `GET /sessions/summaries` endpoint on the runtime that returns lightweight `SessionSummary` projections with pagination support. The VS Code Sessions webview now uses this endpoint to load the first page (50 summaries) instantly, then offers a "Load more" affordance for older sessions, improving first-paint performance when the daemon holds hundreds of sessions.

### Runtime (@agentproto/runtime)
- Added `SessionSummary` interface — a lightweight projection of `SessionDescriptor` excluding large resume/transcript/policy context
- Added `listSummaries()` method to `SessionsRegistry` with `limit`/`offset` pagination
- Added `GET /sessions/summaries` HTTP endpoint

### VS Code Extension (agentproto-vscode)
- Refactored Sessions webview to consume `SessionSummary` instead of full `SessionDescriptor`
- Implemented progressive loading: bounded first page + "Load more" button
- Pending optimistic rows merged from store on each render for instant spawn feedback
- Intelligent refresh: re-fetches the currently loaded slice on SessionStore changes
- Removed workspace dropdown filter (simplification for paginated model)

### Sandbox Box (@agentproto/sandbox-box)
- Fixed flaky test: strip ANSI color codes from stdout when `FORCE_COLOR=1` is set
