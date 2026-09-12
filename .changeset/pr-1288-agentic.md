---
"@agentproto/runtime": minor
---

Opt-in inbound sender attribution: new `displayName`/`surface` fields on `InboundMessage`, new exported `attributeInboundText` helper prefixing routed turns as `[Name · surface]`, HTTP `display_name`/`surface` pass-through with validation, and Telegram `from.first_name`/`username` extraction. 1:1 bindings keep receiving raw text.