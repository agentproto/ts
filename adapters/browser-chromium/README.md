# @agentproto/adapter-browser-chromium

The `chromium` browser provider for `@agentproto/driver-browser`: Chromium driven
by Playwright on its own dedicated profile directory, with CDP access, network
capture (including response bodies), screenshots and cookie injection.

```ts
import { chromium } from "@agentproto/adapter-browser-chromium"

const instance = await chromium.launch({ profile: "work" }, { log: console.log })
const driver = await instance.attach({ initialUrl: "https://example.com" })
await driver.close()
await instance.stop()
```

## Install the binary

`playwright-core` is loaded lazily, on the first `launch()`. Importing this
package needs no browser and no Playwright download. To get a Chromium build:

```sh
npx playwright install chromium
```

Or point `CHROMIUM_EXECUTABLE_PATH` (or `launch({ executablePath })`) at any
Chromium build. Without a binary, `launch()` fails with a message that names
this command.

## F11: never the default Chrome profile

Chrome 136+ refuses `--remote-debugging-port` on the default user-data-dir, so
this provider never attaches to it or launches against it. Every launch uses a
fresh dedicated dir under `~/.agentproto/browser/chromium/profiles/<name>`
(override the root with `AGENTPROTO_HOME` or `dataDir`) and receives granted
cookies by injection through `attach({ sessionPayload })`.

These requests are refused with the typed error `browser:profile-refused`
(`BrowserProfileRefusedError`, from `@agentproto/driver-browser`):

- a `userDataDir`, or a `profile` given as a path, that is or sits inside the
  default dir of Chrome, Chromium, Brave or Edge on this OS (symlinks resolved);
- a `profile` naming a real Chrome profile (`Default`, `Profile 1`, ...);
- `fullProfile: true`, or a `--full-profile` argument, until the grant model
  lands;
- extra `args` that set `--user-data-dir` or `--remote-debugging-*`.

The check runs in `resolveDedicatedProfileDir`, and once more on the exact
argv before Chromium starts. Tests cover each refusal.

## Behaviour

- `launch()` is idempotent per dedicated dir: a second launch of the same
  profile returns the same instance id with `wasAlreadyRunning: true` and never
  starts a second browser. A dir held by a live process outside this one is
  refused instead of shared.
- Chromium starts with `--remote-debugging-port=0`; the real port is read from
  `DevToolsActivePort`, and `endpoints.cdp` is the browser websocket URL.
- Headless by default; pass `headless: false` for a window (needs a display).
- `downloads` is not offered: the driver port has no download verb, so the
  `download` conformance level is skipped.
- `stealth` is `false`. For a stealth browser use `@agentproto/adapter-browser-camofox`.
- Cookie values are never written to logs.

## Tests

`runConformance` (core, interaction, network) runs against a local fixture
server when a Chromium binary is available, and skips with a printed reason
when it is not.
