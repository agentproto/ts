---
"@agentproto/auth": minor
---

Add a pluggable `CredentialStore` (Keychain / Memory / AES-256-GCM File backends) and decouple the `pat` / `service-auth` flow engines from the macOS Keychain, plus a `CredentialBroker.resolveHeaders(path)` that serves cached bearer credentials and auto-refreshes expired ones through the flow engine. Backward compatible: the default store stays the Keychain.
