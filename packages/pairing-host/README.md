# @agentproto/pairing-host

Host-side AIP-59 pairing for anything that wants to be a pairing host, not only
the agentproto daemon. Depends on `@agentproto/acp`, `@agentproto/secrets` and
`ws` only.

- `createPairingRegistry(deps)`: offers, accept handshake over an untrusted
  rendezvous, `pairings.json` persistence, epoch reconnect, revocation.
  Dependency-injected (`loadIdentity`, `dial`, `serve`, `pairingsPath`).
- `dialRendezvous(url, signal, { agent? })`: default WebSocket dial.
- `serveLoopbackHttp({ target, injectHeaders?, allowPaths? })`: a `serve`
  that forwards the paired, E2E-wrapped channel to a loopback HTTP app.
- `registry.mintLocalDevice({ name })` / `registry.verifyDeviceBearer(bearer)`:
  optional local-device credential for loopback clients. The bearer is derived
  from a per-device secret kept in `pairings.json` (`localDevices`, optional,
  mode 0600); it is shown once at mint time, never logged, and `revoke()` makes
  the very next verify fail.

```ts
import { createPairingRegistry, dialRendezvous, serveLoopbackHttp } from "@agentproto/pairing-host"

const registry = createPairingRegistry({
  loadIdentity,
  pairingsPath,
  dial: (url, signal) => dialRendezvous(url, signal),
  serve: serveLoopbackHttp({
    target: new URL("http://127.0.0.1:8123"),
    injectHeaders: { authorization: `Bearer ${localToken}` },
    allowPaths: ["/mcp"],
  }),
})
```
