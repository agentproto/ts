---
"@agentproto/adapter-browser-chrome": minor
"@agentproto/adapter-browser": minor
---

Add the `chrome-live` browser provider: it attaches to the user's already running Chrome through the remote debugging toggle (chrome://inspect/#remote-debugging) over one memoized websocket, works in its own window, only addresses targets it created, never sends `Browser.close`, and keeps cookies read-only. Typed errors `browser:remote-debugging-off`, `browser:consent-timeout` and `browser:disconnected`. The `@agentproto/adapter-browser` facade registers it as the `chrome-live` adapter.
