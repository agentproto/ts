---
"agentproto-vscode": minor
"@agentproto/runtime": patch
---

Unify the VS Code sessions webview into a single continuous list with a sticky workspace selector and per-row workspace tags. Rows now show deterministic workspace colors, lifecycle actions (Stop for live sessions, Archive/Unarchive for terminal sessions), and an archived style. Status tabs and the active-session indicator are preserved from the existing tree semantics. Also fix a pre-existing TypeScript cast in runtime outbound adapters so `Buffer` multipart bodies satisfy `fetch` under stricter type configurations.
