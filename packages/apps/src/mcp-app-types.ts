/**
 * Local McpApp-compatible shape used by agentproto's built-in daemon panels
 * (sessions-panel, agents-overview, bureau-sessions, session-story,
 * live-session). Mirrors @agstudio/mcp-apps McpApp<TIn,TOut> without
 * importing it — agentproto is a separate pnpm workspace with no
 * @agstudio/* dependency (same isolation invariant as the runtime's
 * mcp-apps-adapter.ts, which registers instances of this shape on an
 * McpServer and is the canonical consumer of this type).
 */

import type { z } from "zod"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface AgnoMcpApp<TInput = unknown, TOutput = unknown> {
  id: string
  title: string
  description?: string
  /** Must be a z.object({...}) so registerMcpApps can extract .shape. */
  inputSchema: z.ZodObject<z.ZodRawShape>
  execute?: (input: TInput) => Promise<TOutput>
  html: string | ((initData: TOutput) => string)
  /** Content-Security-Policy hints for the sandboxed host iframe, threaded
   *  by `registerMcpApps` into the ui:// RESOURCE's `_meta.ui.csp` (spec
   *  2026-01-26 — CSP is resource-only, the tool's `_meta.ui` never carries
   *  it). Omit for apps that need no outbound connections beyond the host
   *  bridge (e.g. sessions-panel/agents-overview/bureau-sessions, which
   *  only ever talk to the host via postMessage). Apps that open their own
   *  WebSocket/fetch from inside the iframe (e.g. live-session's SSE, or
   *  runtime's terminal-panel-app.ts) must declare the exact origin(s) they
   *  connect to here. */
  csp?: { connectDomains?: string[]; resourceDomains?: string[] }
}
