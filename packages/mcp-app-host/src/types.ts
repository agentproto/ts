/**
 * The resolved UI resource of an MCP App tool — the daemon's
 * `mcp_app_ui_read` output (CONTRACT §1). Declared here so every host
 * (session-chat, VS Code) and `mountMcpApp` share one shape.
 */
export interface McpAppUi {
  resourceUri: string
  /** resources/read contents[0].text (or decoded blob). */
  html: string
  /** Expect "text/html;profile=mcp-app". */
  mimeType: string
  /** contents[0]._meta.ui.csp, passed through verbatim. */
  csp?: McpAppUiCsp
  /** McpUiResourcePermissions, passed through verbatim. */
  permissions?: Record<string, unknown>
  prefersBorder?: boolean
  domain?: string
}

export interface McpAppUiCsp {
  connectDomains?: string[]
  resourceDomains?: string[]
  /** Omitted ⇒ frame-src 'none' (spec). */
  frameDomains?: string[]
  baseUriDomains?: string[]
}
