---
"@agentproto/secrets": major
"@agentproto/acp": minor
"@agentproto/cli": patch
"@agentproto/runtime": patch
---

Crypto portability refactor: `@agentproto/secrets` gains a `CryptoProvider` seam (node:crypto / WebCrypto) and a browser-safe `@agentproto/secrets/pairing/browser` entry; all public crypto APIs (`seal`/`unseal`, identity, pairing handshakes, offer URLs, pair-root/epoch-token derivation) are now async and take an optional trailing `crypto` provider — a breaking change. `@agentproto/acp` gains an `E2eAead` seam, a browser-safe `@agentproto/acp/tunnel/browser` entry, `holdFrames`, and async-derivation callbacks in the handshake-over-sink helpers, with the Node entry keeping its `Buffer`-typed `decodeData`. `@agentproto/cli` and `@agentproto/runtime` adapt call sites to the async APIs.
