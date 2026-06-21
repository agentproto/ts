/**
 * Adapter: registers AgnoMcpApp[] on a @modelcontextprotocol/sdk McpServer.
 *
 * Mirrors the @agstudio/mcp-apps platform pattern but without the Mastra
 * dependency (agentproto is a standalone pnpm workspace that cannot import
 * @agstudio/* packages). Both sides follow the same invariant:
 *
 *   _meta.ui.resourceUri lives at the TOOL DEFINITION level (registerTool
 *   config), NOT in the handler return value. This is because the SDK
 *   serialises the handler result as MCP content, and any _meta returned
 *   there would be buried inside the text payload and invisible to the host.
 *
 * Usage:
 *   import { registerMcpApps } from "./mcp-apps-adapter.js"
 *   import { makeSessionsPanelApp } from "./sessions-panel-app.js"
 *
 *   registerMcpApps(server, [
 *     makeSessionsPanelApp({ listSessions: () => sessions.list() }),
 *   ])
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { AgnoMcpApp } from "./sessions-panel-app.js"

const MIME_TYPE = "text/html;profile=mcp-app"

/**
 * Register every AgnoMcpApp on the MCP server:
 *   • A resource at ui://<id>/view serving the HTML panel.
 *   • A tool named <id> that links to the resource via _meta.ui.resourceUri
 *     and optionally returns a JSON snapshot from execute().
 */
export function registerMcpApps(
  server: McpServer,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apps: AgnoMcpApp<any, any>[],
): void {
  for (const app of apps) {
    const resourceUri = `ui://${app.id}/view`
    const html =
      typeof app.html === "string" ? app.html : app.html({} as never)

    // 1. Resource — HTML panel served at ui://<id>/view
    server.registerResource(
      app.id,
      resourceUri,
      {
        mimeType: MIME_TYPE,
        description: app.description,
        _meta: { ui: { prefersBorder: true } },
      },
      async () => ({
        contents: [
          {
            uri: resourceUri,
            mimeType: MIME_TYPE,
            text: html,
          },
        ],
      }),
    )

    // 2. Tool — _meta.ui.resourceUri at definition level so the host
    //    can pre-associate the panel before the handler even runs.
    server.registerTool(
      app.id,
      {
        description: app.description ?? app.title,
        inputSchema: app.inputSchema.shape,
        annotations: {
          readOnlyHint: true,
          openWorldHint: false,
        },
        _meta: {
          ui: {
            resourceUri,
            visibility: ["model", "app"],
          },
        },
      },
      async (args) => {
        const initData = app.execute ? await app.execute(args) : {}
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(initData, null, 2),
            },
          ],
        }
      },
    )
  }
}
