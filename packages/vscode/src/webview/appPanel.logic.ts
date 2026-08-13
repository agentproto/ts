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

/** The standalone HTTP url (`GET /apps/<appId>/ui` — http-server.ts's
 *  standalone app host) that renders the SAME app UI in a plain browser tab,
 *  with a REST `window.McpApp` bridge injected instead of the postMessage one.
 *  Unlike the webview panel this is fully interactive: clicks and native
 *  keyboard shortcuts work because `callTool` is a relative `fetch("./tool-call")`
 *  (`POST /apps/<appId>/tool-call`) rather than `postMessage` to a host.
 *
 *  `appId` (`@scope/name`) carries a literal slash, and the daemon route is
 *  `^/apps/(.+)/(ui|tool-call)$`, so we URL-encode the id (`%40agentproto%2Fmail-triage`)
 *  — the route matches both the literal-slash and the %2F-encoded spelling
 *  (http-server.ts comment). `daemonUrl` is resolved from the extension config
 *  (getConfig().daemonUrl) by the caller. */
export function appStandaloneUrl(daemonUrl: string, appId: string): string {
  const base = daemonUrl.replace(/\/+$/, "")
  return `${base}/apps/${encodeURIComponent(appId)}/ui`
}
