---
"@agentproto/runtime": patch
---

Add Telegram bot support to transmitter system via new provider-agnostic outbound abstraction. Includes telegram-bot-creds store with MCP tools (telegram_bot_token_set, telegram_bot_token_status, telegram_bot_set_webhook) for secure bot token management, telegram-proxy HTTP reverse proxy for webhook ingress, and sendOutbound dispatch supporting agentpush and Telegram. Updated transmit_message tool to accept provider parameter (defaults to agentpush for backward compatibility). Added comprehensive test coverage for security (path traversal, method validation), credential storage, and integration.
