---
"@agentproto/runtime": patch
---

Stop turn-retry from retrying an out-of-funds refusal as a transient 5xx. pi prints provider errors as `402: {"type":"server_error","message":"... Insufficient account funds"}`: `extractHttpStatus` now reads a status that leads the message (`NNN: ...`), the billing match covers `insufficient <word> funds/credits/balance`, and the reviewer host's wallet-exhausted cooldown recognises the same wording. The turn is classified `auth` and is no longer retried.
