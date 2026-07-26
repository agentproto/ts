---
"@agentproto/runtime": patch
---

Fix Node `Buffer` to `BodyInit` incompatibility in Telegram outbound adapter by converting buffers to `Uint8Array<ArrayBuffer>` before passing them to `fetch()`.
