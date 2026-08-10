/**
 * Pure helpers for the app webview panel — no vscode import so they're
 * unit-testable under plain vitest.
 */

/**
 * Derive the MCP tool id for an installed app's UI panel — strips the
 * `@owner/` scope (if any) and maps every non `[a-z0-9]` character to `_`.
 * Replicates packages/runtime app-ui-apps.ts's `appUiToolId`, which isn't in
 * @agentproto/runtime's public export map — keep the two in lockstep.
 */
export function appUiToolId(appId: string): string {
  const slug = appId.replace(/^@[^/]+\//, "").replace(/[^a-z0-9]/g, "_")
  return `app_ui_${slug}`
}

/** The `resources/read` uri the daemon serves an installed app's UI panel
 *  html at (mcp-apps-adapter.ts: `ui://<id>/view`). */
export function appViewResourceUri(appId: string): string {
  return `ui://${appUiToolId(appId)}/view`
}
