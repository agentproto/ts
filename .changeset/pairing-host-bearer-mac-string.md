---
"@agentproto/pairing-host": patch
---

Fix local-device bearer verification: compare the presented base64url MAC string in constant time instead of the decoded buffer. The trailing bits of a 32-byte HMAC are dropped by base64url decoding, so a bearer with a flipped final character decoded to the same buffer and was accepted as valid.