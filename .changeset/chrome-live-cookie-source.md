---
"@agentproto/adapter-browser-chrome": minor
"@agentproto/adapter-browser": minor
"@agentproto/driver-browser": minor
"@agentproto/runtime": minor
---

`chrome-live` gains a `cookieSource` seam (`ChromeLiveProviderConfig.cookieSource`, same `BrowserCookieSource` shape `chrome` already uses) that injects cookies through `Network.setCookies` into ONLY the dedicated, zero-consent Chrome this provider auto-launches — the user's own, attached-to Chrome stays read-only exactly as before. Injection runs on every `attach()` of a dedicated instance, is filtered to the launch's `domains` option (both by the source's own request and, belt-and-suspenders, by this package again), and never logs a cookie value, only a count. This package has no opinion on where cookies come from or who may grant them: `cookieSource` is a pure injection point, no selection or consent logic lives here.

`BrowserCookieSource`'s request shape (`@agentproto/driver-browser`) grows two optional fields, `domains` and `chromeProfile`, additive and ignored by existing callers (e.g. `chrome`'s own cookie source).

`@agentproto/adapter-browser` adds `chromeProfile`/`domains` to `BrowserAdapterStartOptions` (chrome-live only, ignored by every other adapter) and a new `createChromeLiveAdapter(config)` factory so a host can build its own `chrome-live` adapter handle over a custom `ChromeLiveProviderConfig` (e.g. with a concrete `cookieSource`) without touching the default `chromeLiveAdapter` singleton, which ships with no `cookieSource` configured.

`@agentproto/runtime`'s `start_browser` MCP tool grows matching `chromeProfile`/`domains` parameters, forwarded verbatim into the resolved adapter's `ensure()` — chrome-live only, every other adapter ignores them.
