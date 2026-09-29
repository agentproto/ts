---
"@agentproto/runtime": minor
"@agentproto/cli": patch
---

The daemon, the `POST /sessions/browser` route and the CLI now resolve browser adapters through one shared table, `defaultBrowserAdapterResolution()`, backed by the `@agentproto/adapter-browser` facade (`camofox`, `bureau`, `chromium`). The "Available adapters" hints derive from that table instead of hardcoded copies. `start_browser`, `stop_browser`, `list_browsers`, `browser_status`, `browser_adapter_list`, `POST /sessions/browser` and every `agentproto browser` / `agentproto serve` flag keep their request and response shapes.

New `projectBrowserTools(instance, { provider })` in `@agentproto/runtime` projects a `@agentproto/driver-browser` `BrowserInstance` onto the page-level MCP tools (`browser_navigate`, `browser_evaluate`, `browser_click`, `browser_fill`, `browser_screenshot`, `browser_get_dom`, `browser_list_requests`, `browser_get_request_body`, `browser_cdp_send`). A tool whose capability the provider lacks answers with a typed `browser:unsupported` result naming the capability (for example `cdp` for `browser_list_requests`), before any driver is attached.
