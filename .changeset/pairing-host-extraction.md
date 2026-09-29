---
"@agentproto/pairing-host": minor
"@agentproto/runtime": patch
"@agentproto/cli": patch
---

Extract the host-side pairing registry into a new `@agentproto/pairing-host` package so a non-daemon host can embed AIP-59 pairing without depending on the runtime. The package also ships a default `dialRendezvous`, `serveLoopbackHttp` (forward a paired channel to a local HTTP app with injected headers and an optional path allow-list), and an optional local-device credential (`mintLocalDevice` / `verifyDeviceBearer`, revocable like any pairing, stored as an optional `localDevices` field in `pairings.json`). `@agentproto/runtime` re-exports the registry unchanged and `@agentproto/cli` imports `dialRendezvous` from the package; daemon behaviour is identical.
