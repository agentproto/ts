---
"@agentproto/acp": patch
"@agentproto/pairing-host": patch
"@agentproto/runtime": patch
---

Close sandboxed transports after failed handshakes, remove stale abort listeners on settle, and make `tunnelClient.ready()` fail promptly on a pre-hello tunnel error or transport close instead of waiting out the hello timeout.
