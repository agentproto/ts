---
"@agentproto/runtime": patch
---

A live external session (`cc:<id>`) whose row the daemon itself ended (`endedReason` `daemon-restart` or `crashed`) is now revived by its next hook touch: status returns to `running` and `endedAt`/`endedReason` are cleared, so `message_send` no longer fails with "session is not alive". Rows ended by an operator kill, retire, archive or supersede stay ended.
