# @agentproto/pairing-host

## 0.2.6

### Patch Changes

- @agentproto/secrets@2.0.1
- @agentproto/acp@0.10.0

## 0.2.5

### Patch Changes

- Updated dependencies [fdaaf7d]
- Updated dependencies [fdaaf7d]
  - @agentproto/secrets@2.0.0
  - @agentproto/acp@0.10.0

## 0.2.4

### Patch Changes

- 0dd095d: Fix daemon crash when a rendezvous/tunnel/terminal-input WebSocket dial is aborted or times out while still connecting: keep a permanent `error` listener on the socket and use `terminate()` for a CONNECTING socket, so the late "closed before the connection was established" error becomes a normal dial failure instead of an unhandled `error` event that crashes the process.
- Updated dependencies [38b5538]
- Updated dependencies [5787677]
  - @agentproto/secrets@1.3.0
  - @agentproto/acp@0.10.0

## 0.2.3

### Patch Changes

- Updated dependencies [3959962]
  - @agentproto/acp@0.10.0

## 0.2.2

### Patch Changes

- 11c1e09: Controller→host-session prompt path + E2E channel flap diagnostics (BOOTSTRAP P4)

  - `runtime`: `device_prompt` MCP tool + `POST /devices/:id/sessions/:sessionId/prompt` —
    write a turn to a session on a registered HOST device (the write counterpart of
    `device_sessions`), forwarded over the host's E2E channel with `agent_prompt`'s
    queueing rules (fire-and-forget default, FIFO behind an in-flight turn,
    `interrupt`/`force`; `wait` blocks until the turn drains). The host side serves
    `POST /device-prompt/:sessionId`, self-proxying onto its own
    `POST /sessions/:id/prompt`, gated by the same two gates as `/device-spawn/*`
    (host-scoped pairing + `features.deviceSpawnAllow` — a plain remote-control
    pairing never gets it). CLI: `agentproto devices prompt <fp|name> --session <id>
--prompt <text> [--wait]`.
  - `runtime`: post-handshake E2E diagnostics in `HostRegistry.connectToHost` —
    each failed attempt logs the host name/fingerprint, attempt number, and the step
    it died at; a host that closes AFTER completing the Noise handshake now fails
    immediately with the remote close reason instead of masking it behind a 10s
    tunnel-hello timeout (the step the observed flaps break at), and the re-pair
    hint now also fires on a hello timeout.
  - `pairing-host`: the daemon's pairing accept-loop no longer swallows handshake
    failures silently — the gated log names the step (`transport closed during
handshake: <reason>` vs a hello timeout), and the channel-closed log carries the
    remote close reason.
  - `acp`: `daemonHandshakeOverSink` takes an optional `log` hook that surfaces the
    remote's POST-REPLY close reason — the exact step the observed E2E flaps break
    at (Noise OK, reply sent, controller hangs up). Wired into the pairing accept
    loop (gated, labelled with the loop key) and the join-token accept loop; the
    reason was previously captured at this layer and discarded.

- Updated dependencies [11c1e09]
  - @agentproto/acp@0.9.2

## 0.2.1

### Patch Changes

- @agentproto/secrets@1.2.1
- @agentproto/acp@0.9.1

## 0.2.0

### Minor Changes

- a68d1d6: Publish the browser stack packages that consumer apps depend on. Camofox, Chrome and Chromium browser providers, the browser session/profile model, the BrowserDriver, and the embedded pairing-host library are now published to npm under their existing public versions; adapter-browser, browser-process, driver, secrets and workflow-runtime carry forward their current versions so dependent bumps resolve.

### Patch Changes

- Updated dependencies [a68d1d6]
  - @agentproto/secrets@1.2.0
  - @agentproto/acp@0.9.1

## 0.1.0

### Minor Changes

- f058a9b: Extract the host-side pairing registry into a new `@agentproto/pairing-host` package so a non-daemon host can embed AIP-59 pairing without depending on the runtime. The package also ships a default `dialRendezvous`, `serveLoopbackHttp` (forward a paired channel to a local HTTP app with injected headers and an optional path allow-list), and an optional local-device credential (`mintLocalDevice` / `verifyDeviceBearer`, revocable like any pairing, stored as an optional `localDevices` field in `pairings.json`). `@agentproto/runtime` re-exports the registry unchanged and `@agentproto/cli` imports `dialRendezvous` from the package; daemon behaviour is identical.

### Patch Changes

- c86b801: Fix local-device bearer verification: compare the presented base64url MAC string in constant time instead of the decoded buffer. The trailing bits of a 32-byte HMAC are dropped by base64url decoding, so a bearer with a flipped final character decoded to the same buffer and was accepted as valid.
  - @agentproto/acp@0.9.1
  - @agentproto/secrets@1.1.1
