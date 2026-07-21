---
"@agentproto/runtime": patch
---

Security fix: add `guardBrowserOrigin()` to reject untrusted cross-origin browser requests to read routes that leak local session state (/conversations, /events, /workspaces, /worktrees). Also tighten CORS to only expose credentials to allowlisted origins, and redact query strings in logs to prevent token leakage.
