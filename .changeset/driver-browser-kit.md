---
"@agentproto/driver-browser": minor
---

New `@agentproto/driver-browser` package: the browser provider kit. `defineBrowser` (zod-validated manifest plus an idempotent `launch`, built on `createDoctype`), the `BrowserProvider`, `BrowserInstance` and `BrowserDriver` ports, `BrowserCapabilities` (page-level and process-level flags), a provider registry, a `@agentproto/provider-kit` lister, and a typed capability gate: `BrowserUnsupportedError` (AIP-14 `ToolError`, code `browser:unsupported`, message and `cause.capability` name the missing capability). `BrowserInstance.health()` carries the optional lifecycle fields Bureau reads (`bootId`, `startedAt`, `browserState`, `launchedAt`, `lastLaunchMs`, `lastRestartReason`).
