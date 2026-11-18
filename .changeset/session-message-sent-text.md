---
"@agentproto/runtime": minor
"@agentproto/transcript-fixtures": minor
---

`session-message-sent` transcript records now carry the message body (`text`, bounded to 4000 chars, with `textTruncated: true` when cut). A viewer can show what a session sent without reading the recipient's transcript, which a desktop chat (`cc:`/`codex:`) or a scoped Telegram link cannot offer. Records written before this have no `text`.
