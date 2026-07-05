---
"@agentproto/runtime": patch
---

fix(runtime): trust the hosted panel origin (cli.agentproto.sh) so the panel's
PTY terminal connects

The `/sessions/:id/pty` WebSocket upgrade is gated by `checkSessionsToken`,
which accepts a trusted browser `Origin` in place of the per-boot token (a
browser can't set an `Authorization` header on a WS upgrade). The hosted panel
at `cli.agentproto.sh` drives the user's local daemon from the browser: its
read-only GETs (session list, SSE output stream) are ungated and worked, but the
PTY terminal's WS upgrade 401'd because that origin wasn't in
`DEFAULT_ALLOWED_ORIGINS` — so PTY sessions showed nothing while agent/ACP
sessions worked. Adds `https://cli.agentproto.sh` to the default allowlist,
scoped to agentproto's own first-party panel (a malicious page can't forge the
`Origin` header; removable via `strictOrigins`), matching how `guilde.work` is
trusted.
