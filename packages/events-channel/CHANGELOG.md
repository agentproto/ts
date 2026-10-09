# @agentproto/events-channel

## 0.1.0

### Minor Changes

- a3a8e61: New package: a Claude Code channel for MCP Events. A Claude Code session subscribes to agentproto events (`events_list`, `events_subscribe`, `events_unsubscribe` tools) and receives matching events as `<channel>` notifications. The receiver verifies Standard Webhooks signatures, answers the subscribe challenge, drops duplicate deliveries and refreshes subscriptions before expiry; a cloudflared quick tunnel provides the public callback when `EVENTS_CALLBACK_BASE` is not set.
