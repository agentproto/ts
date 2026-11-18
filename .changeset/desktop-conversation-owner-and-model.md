---
"@agentproto/runtime": patch
---

`desktop_conversation_create` now records the calling session as the owner of the thread it creates (`ownerSessionId` on the external row, a `parent` messaging relation), so the same session can `desktop_conversation_ask` it afterwards; every other session is still refused. Without `model`, a Codex first turn refused with "not supported" (the model of `~/.codex/config.toml` is rejected by the ChatGPT account) now fails with an error naming the models that did work on this account (read from the Codex thread history, e.g. `gpt-5.6-terra`).
