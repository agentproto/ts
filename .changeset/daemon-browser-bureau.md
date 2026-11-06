---
"@agentproto/runtime": minor
---

Add `defaults.browser.builtin` (`off` | `proxy` | `on`, default `on`) to control the daemon's built-in browser tools. `off` registers only `fetch_page`; `proxy` forwards the daemon browser tools to Bureau (now including `browser_press_key`, with `tabId` and `instance` forwarded, `browser_list_tabs` mapped to `browser_list_owned_tabs`, and `list_browsers` to `browser_list_instances`) and refuses tools without a Bureau twin with `browser:use_bureau` instead of falling back to chrome-live. A config that sets only `proxyImport` keeps exactly its old `on` behaviour; `proxy` is opt-in. The tool list is fixed per `/mcp` session, so a change applies on the next MCP session.
