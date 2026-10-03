---
"@agentproto/pairing-host": patch
"@agentproto/cli": patch
"@agentproto/relay": patch
---

Fix daemon crash when a rendezvous/tunnel/terminal-input WebSocket dial is aborted or times out while still connecting: keep a permanent `error` listener on the socket and use `terminate()` for a CONNECTING socket, so the late "closed before the connection was established" error becomes a normal dial failure instead of an unhandled `error` event that crashes the process.
