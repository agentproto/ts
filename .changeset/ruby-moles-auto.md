---
"@agentproto/cli": minor
"@agentproto/runtime": minor
---

Answer the terminal queries a PTY child sends (device attributes, XTVERSION, cell size, mode state, graphics probe). The most recently attached terminal answers them; the other clients get the output without the queries, so the child never receives two replies. With no terminal attached, the daemon answers a minimal set itself. New config keys `sessions.terminalQueries` (`auto` | `off`), `sessions.terminalGraphics`, `sessions.terminalCellSize` and `sessions.terminalName` (env `AGENTPROTO_PTY_QUERIES`, `AGENTPROTO_PTY_GRAPHICS`, `AGENTPROTO_PTY_CELL_SIZE`, `AGENTPROTO_PTY_TERMINAL_NAME`). `WS /sessions/:id/pty?answers=0` attaches a client that never answers queries. The PTY resize now passes the window pixel size, which node-pty uses from 1.2 on.
