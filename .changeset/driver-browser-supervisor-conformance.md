---
"@agentproto/driver-browser": minor
---

Add the browser supervisor and the conformance kit to `@agentproto/driver-browser`. `createBrowserSupervisor`: health loop over `BrowserInstance.health()`, a launch-loop detector (N failed starts in a window flips to `crash-looping` and stops retrying until an explicit `restart()`; a slow launch inside the launch budget is not a failure), `onBackendRestart` on a `bootId` change, and orphan sweep by process marker behind an injected process lister. `KeepAlivePolicy`: idle tab reaper that never closes a keepAlive session's tabs, plus an idle-browser-shutdown gate that refuses while a keepAlive session exists. `runConformance(provider, { levels })` with levels `core | interaction | network | download | profile`, a per-level per-check report, unsupported capabilities skipped with `browser:unsupported`, an in-memory fake provider (with injectable faults) and a fake remote provider server for `location: "remote"` conformance.
