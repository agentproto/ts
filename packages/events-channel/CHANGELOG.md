# @agentproto/events-channel

## 0.1.1

### Patch Changes

- 74f982c: Weekly dependency refresh (minor/patch within declared ranges) across the workspace. `@agentproto/runtime` moves to defuddle 0.19, which lifts a title-like `<h1>` into `title` instead of leading `text`, affecting `fetch_page`/`browser_extract_text` output.
- 74f982c: Weekly dependency refresh: minor/patch bumps within declared ranges across the workspace. `@agentproto/runtime` moves to defuddle 0.19 (GHSA-jg4p-g6xj-4qmf); `fetch_page`/`browser_extract_text` now return a title-like `<h1>` in `title` rather than repeating it at the top of `text`.

## 0.1.0

### Minor Changes

- a3a8e61: New package: a Claude Code channel for MCP Events. A Claude Code session subscribes to agentproto events (`events_list`, `events_subscribe`, `events_unsubscribe` tools) and receives matching events as `<channel>` notifications. The receiver verifies Standard Webhooks signatures, answers the subscribe challenge, drops duplicate deliveries and refreshes subscriptions before expiry; a cloudflared quick tunnel provides the public callback when `EVENTS_CALLBACK_BASE` is not set.
