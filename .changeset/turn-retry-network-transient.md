---
"@agentproto/runtime": minor
---

Turn retry now treats network-level provider failures as transient. A one-off TLS handshake failure (`EPROTO: The TLS handshake failed`), a reset, timed-out or broken socket (`ECONNRESET`, `ETIMEDOUT`, `EPIPE`, `socket hang up`, undici `UND_ERR_SOCKET` / `UND_ERR_CONNECT_TIMEOUT`) and a transient DNS miss (`EAI_AGAIN`) are classified `upstream-5xx` instead of `other`, so an opted-in session re-prompts with its normal backoff instead of stopping mid-work. `ENOTFOUND` and `ECONNREFUSED` stay non-transient: a wrong host or port does not recover with backoff.
