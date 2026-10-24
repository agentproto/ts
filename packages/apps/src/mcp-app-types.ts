/**
 * Local McpApp-compatible shape used by agentproto's built-in daemon panels
 * (sessions-panel, agents-overview, bureau-sessions, session-story,
 * live-session). Mirrors @agstudio/mcp-apps McpApp<TIn,TOut> without
 * importing it — agentproto is a separate pnpm workspace with no
 * @agstudio/* dependency (same isolation invariant as the runtime's
 * mcp-apps-adapter.ts, which registers instances of this shape on an
 * McpServer and is the canonical consumer of this type).
 */

import type {
  OpenAIAppUiExtension,
  OpenAIEntrypoint,
  OpenAIIcon,
} from "@agentproto/app-kit"
import type { z } from "zod"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type {
  OpenAIAppUiExtension,
  OpenAIEntrypoint,
  OpenAIIcon,
}

export type OpenAIDisplayMode = "inline" | "fullscreen"

/** §3.2 — serialized onto the generated app UI tool's
 *  `_meta["openai/ui"]`. Entrypoints are metadata only, never separate
 *  panels; the wire shape is what the OpenAI MCP Extensions spec prescribes
 *  for tool-level extension metadata. */
export interface OpenAIUiToolMetadata {
  readonly entrypoints?: readonly OpenAIEntrypoint[]
}

/** §3.2 — serialized onto the `ui://` resource's `_meta["openai/ui"]` as a
 *  PRE-INITIALIZE hint for OpenAI-class hosts: how they may size the panel
 *  before the standard display-mode capability exchange runs. Standard
 *  MCP Apps hosts ignore this key and keep the portable behavior. */
export interface OpenAIUiResourceMetadata {
  readonly availableDisplayModes?: readonly OpenAIDisplayMode[]
  readonly preferredDisplayMode?: OpenAIDisplayMode
}

/** The whole namespaced OpenAI projection of one normalized
 *  `InstalledApp.ui.extensions.openai` block — the shape both the tool
 *  serializer and the resource serializer read. Omitted entirely for apps
 *  without extensions (I5). */
export interface OpenAIAppDescriptor {
  readonly tool?: OpenAIUiToolMetadata
  readonly resource?: OpenAIUiResourceMetadata
  readonly icons?: readonly OpenAIIcon[]
}

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
  csp?: {
    connectDomains?: string[]
    resourceDomains?: string[]
    /** Origins the panel may iframe (`frame-src` under the ext-apps CSP
     *  grammar) — e.g. the session-chat widget frames the installed
     *  `@agentik/session-chat` app's standalone url on the daemon origin. */
    frameDomains?: string[]
  }
  /** Namespaced OpenAI MCP-extensions projection (§3.2). Present only when
   *  the app declares `ui.extensions.openai`; absent ⇒ identical tool,
   *  resource, and wire snapshot as before (I1/I5). Sources from the app's
   *  normalized `AppUiDefinition.extensions.openai` (W-A's app-kit
   *  contract, carried through install as `InstalledApp.ui.extensions`). */
  openai?: OpenAIAppDescriptor
}
