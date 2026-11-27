# @agentproto/mcp-app-host

Framework-free [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) host
(spec `2026-01-26`). A thin wrapper over the official `AppBridge` from
`@modelcontextprotocol/ext-apps/app-bridge`, used by both the VS Code
extension and session-chat, so there's only one host implementation.

- `@agentproto/mcp-app-host` exports `createMcpAppHost(transport, opts)`,
  the transport-agnostic core.
- `@agentproto/mcp-app-host/dom` exports `mountMcpApp(opts)`, which mounts
  the view in an iframe (on a dedicated sandbox origin when the daemon offers
  one, else in a restricted opaque-origin `srcdoc`). It also exports the pure
  helpers `buildCspPolicy`, `buildCspMeta` and `injectCsp`.
- `@agentproto/mcp-app-host/csp` exports the pure CSP builders on their own
  (also used by the daemon): `buildCspPolicy` and `buildSandboxCspHeader`.

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

### Isolation modes

**Sandbox origin** (MCP Apps spec, "Rendering the MCP App"). `mountMcpApp`
registers the view with a server the host controls
(`POST <daemon>/mcp-app-sandbox/views`, found automatically when the page is
served by the daemon; or pass `sandbox: resolver`) and loads it by URL in an
iframe with `sandbox="allow-scripts allow-same-origin allow-forms
allow-popups allow-popups-to-escape-sandbox"`. The document lives on an origin
that differs from the host's (the resolver's answer is refused otherwise), its
CSP is an HTTP header, and the transport only accepts messages from that
iframe's window *and* origin and addresses every message to that origin.
Views that need IndexedDB, a real origin or OAuth callbacks (emulators, for
instance) run in this mode.

**Restricted** (fallback when no sandbox origin is available, or
`sandbox: false`): an opaque-origin `srcdoc` iframe, `sandbox` without
`allow-same-origin`, with a CSP `<meta>` injected ahead of any author content (only the
document prologue is read: doctype, comments, `<html>`, a leading `<head>`). Safe, but such views cannot run. `mountMcpApp` logs
"view in restricted mode" and reports `mode: "restricted"`.

In both modes the `allow` attribute comes from `permissions`, and the CSP
defaults to `'none'` for connect, frame and (restricted) base-uri.

Capabilities are advertised only when a handler exists: `openLinks`,
`logging`, `message` and `updateModelContext`. Without a handler,
`ui/open-link` returns "Method not found", and `ui/request-display-mode`
returns the current mode. With a `requestDisplayMode` handler, a mode that
`hostContext.availableDisplayModes` does not list is declined the same way
(current mode, handler not called), and so is a handler answer outside that
list.

## Known limits

- **No sandbox-proxy double iframe.** Sandbox-origin mode serves the view as a
  document on its own origin (the spec's "single sandboxed iframe, cross-origin
  endpoint" shape) rather than through a relay shim.
- **`_meta.ui.domain` is not honoured.** The sandbox origin is chosen by the
  daemon (one per view in `subdomain` mode), not by the view.
- **`*.sandbox.localhost` must resolve to loopback** (Chrome and Firefox do).
  Elsewhere, configure `daemon.mcpAppSandbox.mode = "port"`.
- **`port` and `publicOrigin` modes share one origin between views.** Views on
  the same origin can script each other, so `mountMcpApp` mounts only ONE view
  per shared origin at a time (the daemon flags it with `shared: true`); any
  other view runs in restricted mode until the first is disposed. The daemon
  also wipes that origin's storage (and, for `publicOrigin`, cookies) on every
  document load. Only the default `subdomain` mode gives every view its own
  origin.
- **Cookies are keyed by host, not port.** In `port` mode the view shares its
  cookie jar with other local web services on that hostname (the daemon uses
  none); in `subdomain` mode a view can set a cookie for `sandbox.localhost`
  that other views can read. Do not rely on cookies for isolation.
- **A same-origin page loaded into the iframe keeps its real origin.** If the
  host page is itself served by the daemon, a daemon page that sets no
  framing restriction would be same-origin with the host. Daemon routes that
  serve agent-authored HTML should carry a `sandbox` CSP.
- **Sources that could reach local services are dropped from a view's CSP**:
  loopback and private-network hosts (any spelling, any port), the host page's
  own hostname, `*`, bare `http:`/`ws:`, and `data:`/`about:`/`javascript:`.
