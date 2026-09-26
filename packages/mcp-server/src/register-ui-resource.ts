/**
 * registerUiResource: serve an MCP Apps (ext-apps) HTML panel as a `ui://`
 * resource on a `McpServer`. Pair it with a tool whose definition carries
 * `_meta.ui.resourceUri` pointing at the same uri (see `toMcpTool`'s `ui`
 * option) so the host can pre-associate the panel with the tool.
 *
 * `_meta.ui` is duplicated onto both the registration options (so it lands in
 * the resources/list entry) AND the read handler's content item (so it lands
 * in the resources/read result), because the ext-apps spec has hosts read csp
 * from resources/read FIRST, falling back to resources/list only if that's
 * absent. The SDK's registerResource() only auto-projects the options-level
 * _meta into resources/list, not into the handler's own return value.
 */

import type {
  McpServer,
  RegisteredResource,
} from "@modelcontextprotocol/sdk/server/mcp.js"

/** The MIME type an MCP Apps host expects on a `ui://` HTML resource. */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app"

/** Content-Security-Policy hints for the sandboxed host iframe (resource-only:
 *  the tool's `_meta.ui` never carries them). */
export interface UiResourceCsp {
  connectDomains?: string[]
  resourceDomains?: string[]
  /** Origins the panel may iframe (`frame-src`). */
  frameDomains?: string[]
}

export interface RegisterUiResourceOptions {
  /** Resource name advertised in resources/list. */
  name: string
  /** The `ui://...` uri the tool's `_meta.ui.resourceUri` points at. */
  uri: string
  /** The panel HTML, or a producer run on every resources/read. */
  html: string | (() => string | Promise<string>)
  description?: string
  csp?: UiResourceCsp
  /** Ask the host to draw a border around the panel. Default `true`. */
  prefersBorder?: boolean
}

export function registerUiResource(
  server: McpServer,
  opts: RegisterUiResourceOptions,
): RegisteredResource {
  const { uri, html } = opts
  const resourceMeta = {
    ui: {
      prefersBorder: opts.prefersBorder ?? true,
      ...(opts.csp ? { csp: opts.csp } : {}),
    },
  }
  return server.registerResource(
    opts.name,
    uri,
    {
      mimeType: MCP_APP_MIME_TYPE,
      ...(opts.description !== undefined
        ? { description: opts.description }
        : {}),
      _meta: resourceMeta,
    },
    async () => ({
      contents: [
        {
          uri,
          mimeType: MCP_APP_MIME_TYPE,
          text: typeof html === "string" ? html : await html(),
          _meta: resourceMeta,
        },
      ],
    }),
  )
}
