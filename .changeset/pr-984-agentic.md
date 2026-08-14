---
"@agentproto/cli": minor
"@agentproto/runtime": minor
"agentproto-vscode": minor
---

Add session pinning — a server-persisted, list-visibility-only favorite flag. Pinned sessions sort to the top of `agentproto sessions` table and the VS Code webview's dedicated "Pinned" group. Includes new CLI `pin`/`unpin` subcommands, the `session_set_pinned` MCP verb, HTTP route `POST /sessions/:id/pin`, and dedicated UI in VS Code. Deliberately orthogonal to `keepAlive`, reaper eligibility, and notifications — pin is a quiet, structural sort/display flag with zero operational side effects.
