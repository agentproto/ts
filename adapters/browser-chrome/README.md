# @agentproto/adapter-browser-chrome

Two browser providers for `@agentproto/driver-browser`, both driven over raw
CDP:

- `chrome`: the Chrome installed on the machine, **launched** on a fresh
  dedicated profile directory (never your profile).
- `chrome-live`: a **dedicated headful Chrome** on its own persisted profile
  dir by default (no consent click) — attaching to your own running Chrome
  through its remote debugging toggle only happens on an explicit ask; see
  [chrome-live](#chrome-live-your-running-chrome).

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

## chrome-live: your running Chrome

`chrome-live` gives an agent a **dedicated headful Chrome**, on its own
persisted profile dir, by default — launched (or reused, hot) immediately,
with zero consent clicks and without ever dialing your own Chrome. Attaching
to the Chrome you already use (your logged-in profile, so an agent can work on
sites where you are signed in) only happens on an **explicit ask**: a pinned
`wsUrl`/`port` (launch opts, provider config, or `CHROME_LIVE_*` env), or
`attachIntent: true`. It never touches your tabs, and it never closes your
Chrome.

```ts
import { chromeLive } from "@agentproto/adapter-browser-chrome"

// Default: a dedicated Chrome, launched or reused hot — no consent wait.
const instance = await chromeLive.launch({}, { log: console.log })
const driver = await instance.attach({ initialUrl: "https://mail.example.com" })
await driver.evaluate({ expression: "document.title", awaitPromise: false, returnByValue: true, maxResultBytes: 10_000 })
await instance.stop() // closes the agent's tabs and its socket, nothing else

// Explicit ask: attach to the user's own, real Chrome instead.
const mine = await chromeLive.launch({ attachIntent: true }, { log: console.log }) // Chrome shows "Allow"
```

In the daemon it is the `chrome-live` browser adapter: `start_browser
{ adapter: "chrome-live" }` (dedicated by default; pass `attachIntent: true`
in the launch options to ask for the user's own Chrome instead).

### Attaching to your own Chrome (explicit ask only)

1. Use Chrome 144 or later and open `chrome://inspect/#remote-debugging`.
2. Turn on the remote debugging toggle. Chrome then listens on
   `127.0.0.1:9222`.
3. Launch with `attachIntent: true` (or a pinned `wsUrl`/`port`). Chrome shows
   a dialog asking whether to allow the debugging connection: click **Allow**.
   The provider waits up to `consentTimeoutMs` (default 60s).

Turn the toggle off again to cut every connection. Without `attachIntent` (or
a pin), the toggle is never dialed at all — the dedicated Chrome comes first
and the attach step doesn't run.

### Falling back to the dedicated Chrome from the attach path

When `attachIntent`/a pinned endpoint asked for attach and it is not possible,
the provider **auto-launches a dedicated, headful Chrome** and connects to it
instead — no Allow click:

- **No Chrome on the toggle** (`browser:remote-debugging-off`, nothing listens
  on 9222): a dedicated Chrome is launched.
- **Consent never granted** (`browser:consent-timeout`: no Allow click within
  `consentTimeoutMs`, or Chrome rejected the connection): the provider stops
  waiting and launches the dedicated Chrome instead of leaving the agent stuck.

The launched Chrome listens on a free port and uses a **persisted** profile dir,
`$CHROME_LIVE_LAUNCH_DATA_DIR` (default `~/.agentproto/browser/chrome/live`),
kept across runs so it stays warm. It is connected in discover mode (the uuid
`webSocketDebuggerUrl` from `GET /json/version`), and its pid is recorded on the
instance. `stop()` kills **only** that child (pid scissors, SIGTERM → grace →
SIGKILL) — an attach-only session has no owned child and its `stop()` never
signals your Chrome.

A pinned `wsUrl`/`port` (launch opts, config, or env) disables this fallback —
it is taken literally, so a failure there surfaces instead of substituting the
dedicated Chrome. `autoLaunch: false` disables dedicated launching globally
(attach becomes the only path, including as the default).

### Configuration

| Setting | Default | |
| --- | --- | --- |
| `createChromeLiveProvider({ port })` / `CHROME_LIVE_PORT` | `9222` | Port on 127.0.0.1 |
| `createChromeLiveProvider({ wsUrl })` / `CHROME_LIVE_WS_URL` | `ws://127.0.0.1:<port>/devtools/browser` | Full browser websocket URL; beats the port |
| `consentTimeoutMs` | `60000` | How long to wait for the Allow click |
| `discover` | `false` | Opt-in: try `GET /json/version` for a `webSocketDebuggerUrl` first |
| `autoLaunch` | `true` | May the provider ever launch a dedicated Chrome at all (as the default, or as the attach path's fallback) |
| `preferDedicated` | `true` | `false` restores the old attach-first default for every call on this provider instance |
| `launch({ attachIntent })` | `false` | Per-call explicit ask to attach to the user's own Chrome instead of the dedicated default |
| `createChromeLiveProvider({ cookieSource })` | none | Injects granted cookies into the **dedicated** Chrome on every `attach()` (never into your own); same `BrowserCookieSource` shape as `chrome`. Filtered by the launch's `domains`; cookie values are never logged, only a count |
| `CHROME_LIVE_LAUNCH_DATA_DIR` | `~/.agentproto/browser/chrome/live` | Persisted profile dir for the auto-launched Chrome |

`launch({ wsUrl, port })` wins over the provider config, which wins over the
env. In toggle mode Chrome answers only the browser websocket without an id:
`/json/version` and `/json/list` come back empty. So by default the provider
connects straight to `ws://127.0.0.1:<port>/devtools/browser` and sends no HTTP
request at all, which also avoids any extra consent prompt. `discover: true`
probes `/json/version` first (for a Chrome started with
`--remote-debugging-port`) and falls back to the fixed URL. `DevToolsActivePort` in the Chrome profile is not
read (macOS does not let other apps read it); the port comes from config.

### One connection, one consent

Every new websocket makes Chrome ask for consent again, so the provider keeps
**one** connection per websocket URL. `launch()` is memoized on that URL,
including the connect in flight: concurrent launches share one socket, and
calling `launch()` again (Bureau does this on every control-tool attach) returns
the live instance with `wasAlreadyRunning: true`. `health()` runs
`Browser.getVersion` over the existing socket and never opens a new one;
`check()` is a bare TCP probe of the port and never opens a websocket either.
A new connection is only opened after the previous one dropped or was stopped,
and the log then says that Chrome will ask for consent again.

### The agent's own window

The first `attach()` opens a dedicated window with
`Target.createTarget { url, newWindow: true }`. Later attaches open tabs in that
same window, never a second window. The protocol has no window parameter on
`Target.createTarget` (checked against the `devtools-protocol` definitions in
the repo: only `newWindow`, `background`, `left`/`top`/`width`/`height` and the
like), and a new tab opens in the last active window. So the provider first runs
`Target.activateTarget` on one of its own tabs, creates the tab, and checks it
with `Browser.getWindowForTarget`. If another window took focus in between and
the tab landed elsewhere, that tab is closed at once and the attach is retried,
then fails with a clear error. It never stays among your tabs. Once you close the
agent window, the next attach opens a new one. CDP has no tab-group API, so the
agent's tabs are not grouped.

### Screencast of the agent's own tab

`chrome-live` is the only provider that can screencast
(`driver.capabilities.canScreencast`). The screencast rides CDP
`Page.startScreencast` inside the driver's own flat session, on a tab the
provider opened — so it stays inside the same ownership rules as a
screenshot (`Page.*` only, never a foreign tab, never the desktop).

```ts
const { targetId, index } = await instance.screencastStart({ everyNthFrame: 1, quality: 80 })
const latest = await instance.screencastFrame() // null until the first frame lands
const { frameCount, frames } = await instance.screencastStop()
```

Options mirror `Page.startScreencast`: `format` (default `jpeg`),
`quality` (1–100), `everyNthFrame`, `maxWidth`, `maxHeight`. Frames are
normalized to `{ data /* base64 */, format, timestampMs, index, width?,
height? }` and buffered in a bounded ring (2000 frames) so a later stop
can hand every buffered frame to a recording encoder. `screencastStart`
reuses an owned agent tab when one exists and opens a fresh one
otherwise, and is idempotent per driver. The screencast pointer lives on
the connection entry, so a second `launch()` handle that reuses the
already-running connection (`wasAlreadyRunning`) reaches the same
frames.

The daemon projects the same instance methods as the MCP tools
`browser_screencast_start` / `browser_screencast_frame` /
`browser_screencast_stop` and the HTTP routes
`GET /sessions/<id>/screencast` (HTML viewer), `.mjpg` (MJPEG stream)
and `.jpg` (latest frame).

### Safety guarantees

- **Never touches your Chrome.** When it attached, `stop()` sends
  `Target.closeTarget` for the targets this provider created, then closes its
  own websocket; it never sends `Browser.close`. A handle returned by a reused
  `launch()` closes only the tabs it opened and leaves the connection to the
  first launch. When instead it **auto-launched** a dedicated Chrome, `stop()`
  kills only that child by pid (SIGTERM → grace → SIGKILL) — your Chrome is
  never signalled.
- **Never touches your tabs.** The provider only knows the target ids it
  created. It never calls `Target.getTargets` and never attaches to a target it
  did not create. Through `driver.send` (the agent's `cdp_send`), the whole
  `Target.*` and `Browser.*` domains are refused, as are cookie and storage
  writes.
- **Cookies are read-only on your profile.** When attached to the Chrome you
  already run, nothing is written into that profile: no `Network.setCookies`,
  granted-cookie payloads are ignored, and the driver reports
  `canCookies: false`. Reading (`Network.getCookies`) works. On the
  auto-launched **dedicated** Chrome a host-configured `cookieSource` (or a
  session-payload cookie list) may inject cookies through
  `Network.setCookies` at attach time — the agent still cannot write cookies
  through `cdp_send`, and your own Chrome stays untouched either way.
- **Declared capabilities:** `cdp`, `isUserVisible`, `canMultiTarget` (tabs of
  the agent window), `headed`, `canScreencast` (see
  [Screencast](#screencast-of-the-agents-own-tab)). Not `headless`, not
  `persistentProfile`.

**This is not a bypass of F11.** The F11 guard above stays as it is: neither
provider ever launches Chrome on the **default** profile. When the toggle is
off, `chrome-live` auto-launches a dedicated Chrome on its **own** persisted
profile dir (never your default profile) and writes nothing to your profile; it
otherwise only uses a connection you turned on and allowed in Chrome's own UI,
which you can cut at any time.

### Errors

Each error is a `ToolError` with a stable `code`, exported as a constant:

| Code | Constant | When |
| --- | --- | --- |
| `browser:remote-debugging-off` | `BROWSER_REMOTE_DEBUGGING_OFF_CODE` | Nothing listens on the port (ECONNREFUSED). Message: "Enable remote debugging at chrome://inspect/#remote-debugging" |
| `browser:consent-timeout` | `BROWSER_CONSENT_TIMEOUT_CODE` | No Allow click within `consentTimeoutMs`, or Chrome rejected the connection |
| `browser:disconnected` | `BROWSER_DISCONNECTED_CODE` | Chrome closed or the websocket dropped mid-task |

After a drop, the next `launch()` reconnects (with a new consent dialog) and
still knows the tabs it opened before, so `stop()` can close them.

## Deferred

Not in this package yet: extension handling, a multi-profile UI, headed
takeover polish, and full-profile access. The `cookieSource` seam is here
(both providers); the grant model that *supplies* a source lives in
`@agentproto/browser-profiles`.

## Tests

The suite drives a stub Chrome (a node script that speaks minimal CDP) so no
real browser is needed. `chrome-live` runs against an in-process fake of a
toggle-mode Chrome that already has user tabs and flags any command addressing
a target the provider did not create. An optional real-binary smoke runs `runConformance`
when `CHROME_SMOKE_BIN` names a Chrome or Chromium executable.
