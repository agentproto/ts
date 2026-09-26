# @agentproto/mcp-app-host

Framework-free [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) host
(spec `2026-01-26`). A thin wrapper over the official `AppBridge` from
`@modelcontextprotocol/ext-apps/app-bridge`, used by both the VS Code
extension and session-chat, so there's only one host implementation.

- `@agentproto/mcp-app-host` exports `createMcpAppHost(transport, opts)`,
  the transport-agnostic core.
- `@agentproto/mcp-app-host/dom` exports `mountMcpApp(opts)`, which mounts
  the view in a sandboxed `srcdoc` iframe. It also exports the pure helpers
  `buildCspPolicy`, `buildCspMeta` and `injectCsp`.

## Mounting a view

```ts
import { mountMcpApp } from "@agentproto/mcp-app-host/dom"

const { iframe, host, dispose } = await mountMcpApp({
  container: document.getElementById("app")!,
  ui, // { html, csp, permissions, prefersBorder } from mcp_app_ui_read
  hostInfo: { name: "session-chat", version: "1.0.0" },
  hostContext: { theme: "dark", displayMode: "inline", availableDisplayModes: ["inline"] },
  handlers: {
    callTool: ({ name, arguments: args }) => relayToDaemon(name, args), // required
    sendMessage: async (params) => queuePrompt(params), // omitted ⇒ accepted and dropped
    onSizeChanged: ({ height }) => { if (height) iframe.style.height = `${height}px` },
  },
})

await host.sendToolInput(toolUse.input) // queued until the view is ready
await host.sendToolResult(toolResult) // same; flushed in call order
await host.setHostContext({ theme: "light" }) // merged; only changed keys sent
await dispose() // ui/resource-teardown (2s timeout), then removes the iframe
```

The iframe gets `sandbox="allow-scripts allow-forms allow-popups
allow-popups-to-escape-sandbox"` (never `allow-same-origin`). Its `allow`
attribute comes from `permissions`. A CSP `<meta>` built from `csp` is
injected as the first child of `<head>`, and it defaults to `'none'` for
connect, frame and base-uri. The transport only accepts messages whose
`event.source` is that iframe.

Capabilities are advertised only when a handler exists: `openLinks`,
`logging`, `message` and `updateModelContext`. Without a handler,
`ui/open-link` returns "Method not found", and `ui/request-display-mode`
returns the current mode.

## Known limits

- **No sandbox-proxy double iframe.** The view runs in an opaque-origin
  `srcdoc` iframe inside the host page. The spec's separate-origin proxy
  isn't implemented yet. The view still can't reach the host's DOM or
  storage, but some servers' `_meta.ui.domain` assumptions won't hold.
