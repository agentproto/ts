---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

`@agentproto/runtime`: adds an optional, empty-by-default observer seam over the `browser_*` MCP tools (AIP-63 section 7). New exports `registerBrowserObserver`, `unregisterBrowserObserver`, `loadBrowserObserverModule`, and `configureBrowserObservers` let an operator observe `onAttach` / `onDetach` / `beforeCall` / `afterCall` and transform `browser_screenshot` images. Observers fail open inside a short budget; only a `required` screenshot transform can fail a call (`browser:transform_failed`). Call arguments are redacted before observers see them: a `fill` value and an `evaluate` expression are never passed, not even their length. With no observer registered every tool behaves exactly as before.

`@agentproto/cli`: the `serve` daemon now loads an operator browser-observer module from `AGENTPROTO_BROWSER_OBSERVER_MODULE` (absolute, user-owned, non-world-writable path default-exporting `(api) => void`); `AGENTPROTO_BROWSER_OBSERVER_REQUIRED=1` makes a load failure fatal, otherwise the daemon boots without observers.
