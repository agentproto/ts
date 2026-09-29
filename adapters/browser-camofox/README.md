# @agentproto/adapter-browser-camofox

The `camofox` browser provider for `@agentproto/driver-browser`: an idempotent
launcher, a REST client and a `BrowserDriver` for the camofox server, a stealth
Firefox (Camoufox) behind a small REST API.

```ts
import { camofox } from "@agentproto/adapter-browser-camofox"

const instance = await camofox.launch({ port: 9377 }, { log: console.log })
console.log(instance.wasAlreadyRunning) // true when a healthy server was already up
const driver = await instance.attach({ initialUrl: "https://example.com" })
await driver.close()
await instance.stop()
```

## What it does

- `launch()` probes `GET /health`. Any camofox answer, including a 503 while the
  browser is launching or crash-looping, counts as a running server, so no
  second one is spawned and `wasAlreadyRunning` is `true`. Only when nothing
  answers does it start one: `launchCmd`, then `CAMOFOX_SERVE_CMD`, then
  `launchctl start <label>` on macOS. A spawned server gets `CAMOFOX_PORT`.
- `health()` maps `/health` onto the kit's lifecycle fields (`bootId`,
  `startedAt`, `browserState`, `launchedAt`, `lastLaunchMs`,
  `lastRestartReason`). A 503 with `browserState: "crash-looping"` is a state
  (`ok: false`), not a thrown error.
- The driver has no CDP: `listRequests`, `getRequestBody` and `send` throw
  `BrowserUnsupportedError` (capability `cdp`), as does a full-page screenshot.
- The REST client throws `CamofoxHttpError` on any non-2xx answer.

## Auth

Set `CAMOFOX_API_KEY` (or pass `apiKey`) and every request carries
`Authorization: Bearer <key>`. The key is never logged and is scrubbed from
error text. `/health` stays unauthenticated on the server.

## Environment

| Variable | Use |
| --- | --- |
| `CAMOFOX_URL` | Server origin when a launch gives no `baseUrl` or `port`. Default `http://127.0.0.1:9377`. |
| `CAMOFOX_API_KEY` | Bearer key. |
| `CAMOFOX_SERVE_CMD` | Shell command that starts the server (required off macOS). |
| `CAMOFOX_NATIVE_VIDEO` | `true` when the server records video natively. |
| `BUREAU_BEHAVIOR` | Default pacing profile for attached drivers. |

## Server origin and license

The camofox server is `jo-inc/camofox-browser`, MIT licensed, copyright Jo, Inc.
Our patches live in the fork `bureau-sh/camofox-browser`; the HTTP contract this package
targets is that fork's `docs/BUREAU-API.md`. This package only talks to the
server over HTTP and contains none of its code. This package is Apache-2.0.
