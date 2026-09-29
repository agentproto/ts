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

## Scope

This package holds the model only. Concrete providers and the runtime tool
wiring live in other packages.

License: Apache-2.0.
