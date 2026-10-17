---
"@agentproto/adapter-browser-chrome": minor
"@agentproto/adapter-browser": minor
"@agentproto/driver-browser": minor
"@agentproto/runtime": minor
---

`chrome-live` gains a `cookieSource` seam (`ChromeLiveProviderConfig.cookieSource`) that injects granted cookies through `Network.setCookies` into only the dedicated, zero-consent Chrome this provider auto-launches; the user's own attached-to Chrome stays read-only. Injection is filtered to the launch's `domains` option and never logs cookie values.

`BrowserCookieSource`'s request shape (`@agentproto/driver-browser`) grows two optional, additive fields, `domains` and `chromeProfile`.

`@agentproto/adapter-browser` adds `chromeProfile`/`domains` to `BrowserAdapterStartOptions` and a new `createChromeLiveAdapter(config)` factory, and re-exports `chromeLiveLaunchOptionsFrom`.

`@agentproto/runtime`'s `start_browser` MCP tool grows matching `chromeProfile`/`domains` parameters, forwarded verbatim into the resolved adapter's `ensure()`.
