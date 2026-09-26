---
"@agentproto/secrets": major
"@agentproto/pair-client": minor
"@agentproto/runtime": minor
"@agentproto/cli": minor
---

Widen the daemon identity fingerprint from 64 to 128 bits and default `pairing.pairPage` to the new per-daemon `{fingerprint}.agentproto.cloud` pair page (`DEFAULT_PAIR_PAGE`); offer URLs now require the 32-hex fingerprint id.
