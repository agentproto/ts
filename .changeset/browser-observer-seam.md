---
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Added an optional, empty-by-default observer seam on the browser tools (AIP-63 section 7). An operator registers an observer with `registerBrowserObserver` (or points `AGENTPROTO_BROWSER_OBSERVER_MODULE` at an absolute, user-owned, non-world-writable module that default-exports `(api) => void`) to receive `onAttach` / `onDetach` / `beforeCall` / `afterCall` for every `browser_*` call and to transform `browser_screenshot` images before they reach the caller. Observers fail open with a short time budget; only a `required` screenshot transform can fail a call (`browser:transform_failed`). Call arguments are redacted before the observer sees them: a `fill` value and an `evaluate` expression are never passed, not even their length. With no observer registered every tool behaves exactly as before.

`onAttach` also receives an optional `capture` handle (`screenshot`, `evaluate`) for providers that implement both, so an observer can take its own frames and probe the page without a tool call. `@agentproto/runtime/browser-screencast` is now a public subpath (`encodeScreencastFramesToMp4`, `hasFfmpeg`).
