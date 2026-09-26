---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

`remote_enable` (MCP tool and the new `POST /remote/enable` REST route) now returns a `phoneUrl` — the installed `@agentik/session-chat` app's UI, or the hosted panel fallback — with the token in a URL fragment; adds `GET/POST /remote/*` REST twins of the remote tools and a new `agentproto remote enable|disable|status [--qr]` CLI verb; `printQr` is extracted from `pair.ts` into a shared `util/qr.ts`.
