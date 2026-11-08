---
"@agentproto/runtime": minor
---

The daemon's browser tools go through Bureau only. `browser_navigate`, `browser_click`, `browser_fill`, `browser_evaluate`, `browser_get_dom`, `browser_press_key`, `browser_screenshot`, `browser_list_tabs` (to `browser_list_owned_tabs`), `list_browsers` (to `browser_list_instances`) and `browser_screencast_start/frame/stop` (to `browser_record_*`) forward to the imported Bureau MCP with the calling session id. `browser_extract_text` reads Bureau's `browser_get_dom` and extracts the text on the daemon; `browser_scroll` sends Bureau's `browser_evaluate` a fixed scroll script, with the selector passed as data. `sessionId` is now optional and ignored.

Removed, with no Bureau twin: `browser_select`, `browser_wait_for`, `browser_upload_file`, `browser_new_tab`, `start_browser`, `stop_browser`, `browser_status`, `browser_adapter_list`.

`defaults.browser.builtin` accepts `off` and `proxy` and defaults to `proxy`. A legacy `"on"` is read as `proxy` with a one-line warning in the daemon log, so an old config still boots. `defaults.browser.proxyImport` defaults to `bureau`; when that import is absent, the browser tools answer an error naming Bureau.
