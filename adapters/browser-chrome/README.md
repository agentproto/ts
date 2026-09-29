# @agentproto/adapter-browser-chrome

The `chrome` browser provider for `@agentproto/driver-browser`: the Chrome
already installed on the machine, launched on a fresh dedicated profile
directory and driven over raw CDP.

```ts
import { chrome } from "@agentproto/adapter-browser-chrome"

const instance = await chrome.launch({ profile: "work" }, { log: console.log })
const driver = await instance.attach({ initialUrl: "https://example.com" })
await driver.close()
await instance.stop()
```

Use `createChromeProvider({ cookieSource })` to inject cookies at attach time.

## Finding Chrome

`launch({ executablePath })` and the provider config win. Otherwise
`resolveChrome` reads `CHROME_EXECUTABLE_PATH`, which must be an absolute path
to an existing file (a wrong value throws instead of falling back), then the
standard install paths for the OS (Chrome, Edge and Brave on macOS and Windows;
well-known paths and `PATH` names on Linux). When nothing is found, `launch()`
fails with an error that names `CHROME_EXECUTABLE_PATH`.

## F11: never the default Chrome profile

Chrome 136+ refuses `--remote-debugging-port` on the default user-data-dir, so
this provider never attaches to it or launches against it, and it never touches
or closes the Chrome you are using. Every launch spawns a new Chrome process on
a fresh dedicated dir under `~/.agentproto/browser/chrome/profiles/<name>`
(override the root with `AGENTPROTO_HOME` or `dataDir`), with
`--remote-debugging-port=0`. The port is read from `DevToolsActivePort`.

These requests are refused with the typed error `browser:profile-refused`
(`BrowserProfileRefusedError`, from `@agentproto/driver-browser`):

- a `userDataDir`, or a `profile` given as a path, that is or sits inside the
  default dir of Chrome, Chromium, Brave or Edge on this OS (symlinks resolved);
- a `profile` naming a real Chrome profile (`Default`, `Profile 1`, ...);
- `fullProfile: true`, or a `--full-profile` argument, until the grant model
  lands;
- extra `args` that set `--user-data-dir` or `--remote-debugging-*`.

The argv is checked again immediately before the spawn. Tests use a stub binary
and assert the launch args carry the fresh dir and never a default one.

## Cookies

Granted cookies are injected through CDP `Network.setCookies` when a driver
attaches. They come from `attach({ sessionPayload })` and from the provider's
`cookieSource` parameter (`BrowserCookieSource`); the grant model supplies the
real source in a later lane. Only the cookie count is logged, never a value.

## Deferred

Not in this package yet: extension handling, a multi-profile UI, headed
takeover polish, the grant-backed cookie source, and full-profile access.

## Tests

The suite drives a stub Chrome (a node script that speaks minimal CDP) so no
real browser is needed. An optional real-binary smoke runs `runConformance`
when `CHROME_SMOKE_BIN` names a Chrome or Chromium executable.
