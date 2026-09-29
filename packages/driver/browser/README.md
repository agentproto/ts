# @agentproto/driver-browser

The browser provider kit. It gives every browser backend (a stealth Firefox
behind REST, Playwright-managed Chromium, the system Chrome, a hosted browser
service) one shape, so a host can list, launch, attach to and gate them the
same way.

Spec: the BROWSER AIP (working title `BROWSER.md`, `agentbrowser/v1`), draft in
[agentproto/agentproto#53](https://github.com/agentproto/agentproto/pull/53).
The AIP number is provisional until the editors assign it.

## What is in the box

| Piece | What it is |
|---|---|
| `defineBrowser` | Validates a manifest (zod) and returns a frozen `BrowserProvider`. Built on `createDoctype`, like `defineDriver`. Pure construction, no I/O. |
| `BrowserProvider` | Manifest fields plus `launch(opts, ctx)`, an idempotent ensure that returns a `BrowserInstance`. |
| `BrowserInstance` | `id`, `endpoints {rest?, cdp?}`, `pid?`, `wasAlreadyRunning`, `health()`, `attach(opts)`, `stop()`. |
| `BrowserDriver` | The page and tab control port (navigate, evaluate, click, fill, screenshot, network, raw CDP), with zod schemas for its option and result shapes. |
| `BrowserCapabilities` | Page-level flags (`canFullPageScreenshot`, ...) and process-level flags (`stealth`, `headless`, `cdp`, `downloads`, `recording`, ...). All default to off. |
| `createBrowserRegistry` | Register, look up and list providers. A duplicate id throws. |
| `makeBrowserProviderLister` | A standard `@agentproto/provider-kit` lister over a registry. |
| `assertCapability`, `BrowserUnsupportedError` | The capability gate. |

## Define a provider

```ts
import { defineBrowser } from "@agentproto/driver-browser"

export const camofox = defineBrowser({
  id: "camofox",
  name: "Camoufox (stealth Firefox)",
  description: "Stealth Firefox behind a local REST service.",
  version: "1.0.0",
  transport: "http", // sdk | http | cli
  location: "local", // local | remote (remote = a third party sees session data)
  capabilities: { stealth: true, downloads: true, headless: true, persistentProfile: true },
  async launch(opts, ctx) {
    // Return the running instance if one is healthy: wasAlreadyRunning: true.
    // Otherwise start one.
  },
})
```

## The capability gate

A call that needs a capability the provider lacks fails with a typed error,
not an opaque transport failure:

```ts
import { assertToolSupported, isBrowserUnsupportedError } from "@agentproto/driver-browser"

try {
  assertToolSupported(provider.capabilities, "browser.list_requests", provider.id)
} catch (err) {
  if (isBrowserUnsupportedError(err)) {
    err.code // "browser:unsupported" (stable)
    err.capability // "cdp"
    err.message // '"browser.list_requests" needs the "cdp" capability, which is not supported on provider "camofox"'
  }
}
```

`BrowserUnsupportedError` extends the AIP-14 `ToolError`, so `toToolResult`
puts `code` and `cause: { capability }` into the standard envelope.

## Health

`BrowserInstance.health()` returns `{ ok, reason?, lifecycle? }`. `lifecycle`
carries the fields a supervising host reads from a service `/health`, all
optional (a server reports `null` for a field it has not set yet): `bootId`,
`startedAt`, `browserState` (`launching | running | idle | crash-looping`),
`launchedAt`, `lastLaunchMs`, `lastRestartReason`.

## Supervisor

`createBrowserSupervisor` runs a provider under a health loop. Time and
process access are injected (`clock`, `orphanSweep.listProcesses/kill`), so
tests need no real sleeps or processes.

```ts
import { createBrowserSupervisor, browserInstanceMarker } from "@agentproto/driver-browser"

const supervisor = createBrowserSupervisor({
  provider,
  launchOptions: { label: "work" },
  healthIntervalMs: 10_000,
  launchBudgetMs: 120_000, // a slow launch inside the budget is not a failure
  crashLoop: { maxFailures: 3, windowMs: 300_000 },
  orphanSweep: { marker: browserInstanceMarker("work") },
  onBackendRestart: ({ previousBootId, bootId }) => {},
})
await supervisor.start()
```

- **Launch-loop detector.** `maxFailures` failed starts inside `windowMs`
  (a launch over `launchBudgetMs` counts as one) flip the state to
  `crash-looping`. No further launch is attempted, by `start()` or by the
  health loop, until an explicit `restart()`, which clears the counters.
- **Health loop.** Reads `BrowserInstance.health()`. A changed `bootId` means
  the backend restarted and fires `onBackendRestart`. `browserState:
  "crash-looping"` (even on a 503 with `ok: false`) is a state the supervisor
  reports, not "down": relaunching would not help. `launching` is not a
  failure. A plain `ok: false` for `unhealthyThreshold` probes in a row
  triggers a relaunch.
- **Orphan sweep.** `sweepOrphans` signals only processes whose command
  carries the exact marker token (`--agentproto-browser=<key>`), from an
  injected process lister. It never matches by process name and never signals
  the current process. Pass the marker to the browser's argv when launching.
- **`KeepAlivePolicy`.** An idle-tab reaper policy that never reaps the tabs
  of a `keepAlive` session, and an idle-browser-shutdown gate
  (`shouldShutdownIdleBrowser`) that refuses while any keepAlive session
  exists.

## Conformance kit

```ts
import { createFakeBrowserProvider, runConformance } from "@agentproto/driver-browser"

const { provider } = createFakeBrowserProvider()
const report = await runConformance(provider, { levels: ["core", "interaction", "network"] })
report.ok // false if any check failed
report.failed // ["core/launch-idempotent", ...]
```

Levels: `core` (manifest, instance shape, idempotent launch, health,
navigate, idempotent stop, remote providers report no local pid),
`interaction` (evaluate, DOM, screenshot, click/fill with a fixture),
`network` (needs `cdp`), `download` (needs `downloads`) and `profile` (needs
`persistentProfile`). A level whose capability the provider does not declare
is reported as `skipped` with the typed `browser:unsupported`, never as a
failure; the `network` level still checks that the missing capability fails
with `browser:unsupported` rather than an opaque error. The `download` level
only checks that the declared capability is consistent with the tool gate for
now, because the driver port has no download verb; add provider checks with
`extraChecks`.

For `location: "remote"` providers pass `launch: { baseUrl }`. The kit ships
`startFakeRemoteBrowserServer()` (local http, random port) and
`createFakeRemoteBrowserProvider()` so remote conformance can be exercised
without a third party. `createFakeBrowserProvider({ faults })` builds
deliberately broken variants.

## Scope

This package holds the model, the supervisor and the conformance kit.
Concrete providers and the runtime tool wiring live in other packages.

License: Apache-2.0.
