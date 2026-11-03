# Host a service with your app

An app can declare **services** (AIP-53 `services[]`): processes the daemon
runs for it, such as a web server for a bot's mini app. By default the daemon
starts each one when the app is installed and when it boots, and keeps it
running. A service that is only used now and then does not need that. This
page shows how to declare one, and how to have the daemon run it only while
somebody is using it.

## Declare a service

In `.agentproto/APP.md`, or through `defineApp({ services })`:

```yaml
services:
  - name: viewer
    command: node
    args: [dist/viewer.js]
    port: 8789
```

`command` and `args` are run directly, with no shell (`entry` is the legacy
shell-line form). `cwd` is relative to the app directory. The daemon runs the
process detached, adds it to the session list as a `command` row labelled
`app:<appId>:service:<name>`, appends its output to `<state>/services/<name>.log`
and restarts it with a growing delay when it exits unexpectedly.

Add `expose` to give it a public URL through a tunnel; `AGENTPROTO_PUBLIC_URL`
then carries that origin to the process.

## Run it only when it is used

```yaml
services:
  - name: viewer
    command: node
    args: [dist/viewer.js]
    port: 8789
    expose:
      auth: service
    activation:
      mode: on-demand
      idleStopMs: 600000     # stop after 10 minutes with no open request or connection (default 5 minutes)
      startTimeoutMs: 30000  # a request waits at most this long for the cold start (default 30 seconds)
```

With `on-demand` the daemon, not the process, listens on `port`, on the
loopback interface, from install and boot on. No process runs until a request
arrives:

1. **The first request starts it.** The daemon spawns the command with `PORT`
   set to a free loopback port and waits until the process accepts
   connections there. Requests that arrive during the start wait for it
   (one start serves them all).
2. **It proxies.** HTTP requests and WebSocket upgrades are forwarded as they
   came in, with `Host` and the body untouched, and the response is streamed
   back. The process behaves as if it were listening on `port` itself.
3. **It stops when idle.** While a forwarded request or an upgraded
   connection is open the service is busy, and a request is never cut off
   however long it runs. `idleStopMs` after the last one ended, the daemon
   stops the process and its children. The next request starts it again.

If the process does not start, the caller gets `503` with a `Retry-After`
header and no detail in the body; the reason is in the daemon log. After an
unexpected exit the daemon waits 1s, then 2s, 4s, up to 60s, before it starts
the process for another request, so a crashing service is not respawned at the
rate requests come in. It never gives up for good: it keeps listening.

### What the process has to do

- **Listen on `PORT`**, and only there. The declared `port` belongs to the
  daemon, so a service that hardcodes it cannot be on demand. Bind the loopback
  interface (`127.0.0.1`): `PORT` is otherwise reachable on every interface you
  bind, without the daemon in front.
- **Only react to requests.** A poller, a queue consumer, a long-lived
  connection to a third party or a timer does its work while nobody is calling
  it. The daemon would stop it as idle and it would miss that work, so it must
  stay on the default (`mode: always`, or no `activation` at all).
- **Expect a cold start.** The first request after an idle period pays for the
  process starting. Keep that under `startTimeoutMs`.
- **Do not hold connections open for nothing.** An open streaming response or
  WebSocket counts as busy and keeps the process up until it ends.

### Exposure

`expose` works as before: the tunnel targets `http://127.0.0.1:<port>`, which is
now the daemon's listener, so the public URL answers while no process runs and
the first request through it starts the service. With `auth: guard` a request
the guard refuses never reaches the listener and starts nothing. With
`auth: service`, anyone who holds the URL can start the process, which is the
price of an unguarded URL.

### Seeing what it is doing

`app_status` lists `services.activations` for the app: each on-demand service
with its state (`idle`, `starting`, `running`, `stopping`, or `absent` when the
daemon could not take the port). Every start is a row in the session list
(an idle stop leaves it as `killed`), and the log file keeps every run.

### Switching an existing service

Changing a running service between `always` and `on-demand` and reinstalling
(or restarting the daemon) replaces it: the keep-alive process is stopped
first, so the daemon can take the port. If something else still holds the
declared port, for example a copy started by hand, the install reports
`port <n> is already in use` for that service and the rest of the install goes
on.
