# @agentproto/pairing-host

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
