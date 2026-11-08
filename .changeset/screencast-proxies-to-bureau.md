---
"@agentproto/runtime": minor
---

In `defaults.browser.builtin: "proxy"` mode, `browser_screencast_start` / `browser_screencast_frame` / `browser_screencast_stop` now forward to Bureau's `browser_record_start` / `browser_record_frame` / `browser_record_stop` instead of refusing with `browser:use_bureau`. `tabId` and `instance` pass through (the tools gain both fields, plus `fps` on start and `encode` on stop); `sessionId` is never forwarded; `quality`, `everyNthFrame`, `maxWidth` and `maxHeight` have no Bureau equivalent and are dropped and listed in the result's `notes`. Bureau results and error codes come back unchanged. `"on"` and `"off"` modes are unchanged.
