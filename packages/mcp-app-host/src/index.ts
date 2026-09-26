/**
 * `@agentproto/mcp-app-host` — framework-free MCP Apps host (spec
 * `2026-01-26`) over the official `AppBridge` from
 * `@modelcontextprotocol/ext-apps/app-bridge`.
 *
 * `.`      → {@link createMcpAppHost}: transport-agnostic core.
 * `./dom`  → `mountMcpApp`: sandboxed srcdoc iframe + PostMessageTransport.
 */

export {
  buildHostCapabilities,
  createMcpAppHost,
  type CallToolResult,
  type LoggingMessageNotification,
  type McpAppHost,
  type McpAppHostHandlers,
  type McpAppHostOptions,
  type McpUiDisplayMode,
  type McpUiHostCapabilities,
  type McpUiHostContext,
  type McpUiMessageRequest,
  type McpUiUpdateModelContextRequest,
  type Transport,
} from "./host.js"
export type { McpAppUi, McpAppUiCsp } from "./types.js"
