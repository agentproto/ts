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
 *   import { makeSessionsPanelApp } from "@agentproto/apps"
 *
 *   registerMcpApps(server, [
 *     makeSessionsPanelApp({ listSessions: () => sessions.list() }),
 *   ])
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { AgnoMcpApp } from "@agentproto/apps"
import { registerUiResource } from "@agentproto/mcp-server"
import { mintAppEmbedToken } from "./embed-tokens.js"

/**
 * Placeholder the panel HTML carries inside its bridge script
 * (panel-bridge.ts); registerMcpApps replaces it — ALL occurrences, only the
 * assignment uses the double-quoted spelling — with a real per-boot token
 * (embed-tokens.ts) when the panel is served as an MCP-Apps resource.
 * Panels rendered outside that path (tests, docs) keep the literal, and the
 * bridge's `withEmbedToken()` then degrades to an identity function.
 */
export const EMBED_TOKEN_PLACEHOLDER = '"__AGENPROTO_EMBED_TOKEN__"'

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
    let html = typeof app.html === "string" ? app.html : app.html({} as never)
    // Bake the per-boot embed token (see embed-tokens.ts) into panels that
    // iframe the standalone app host. Panels without the placeholder render
    // byte-identical to before.
    if (html.includes(EMBED_TOKEN_PLACEHOLDER)) {
      html = html
        .split(EMBED_TOKEN_PLACEHOLDER)
        .join(JSON.stringify(mintAppEmbedToken(app.id)))
    }

    // 1. Resource: HTML panel served at ui://<id>/view. registerUiResource
    //    duplicates _meta.ui onto both resources/list and resources/read
    //    (hosts read csp from the read result first; see its header).
    //    openai.resource (when the app declares one) rides alongside as
    //    `_meta["openai/ui"]` display hints — namespaced sibling metadata,
    //    never overwriting the canonical `ui` block (plan I5 / §3.2).
    registerUiResource(server, {
      name: app.id,
      uri: resourceUri,
      html,
      description: app.description,
      csp: app.csp,
      ...(app.openai?.resource !== undefined
        ? {
            // Namespaced under `openai/ui` per §3.2 — a sibling of the
            // canonical `_meta.ui`, never an overwrite of it.
            meta: { "openai/ui": JSON.parse(JSON.stringify(app.openai.resource)) },
          }
        : {}),
    })

    // 2. Tool — _meta.ui.resourceUri at definition level so the host
    //    can pre-associate the panel before the handler even runs.
    //    `_meta["openai/ui"]` carries the declared entrypoints AND the
    //    declared icons (projected tool `icons` — this SDK's
    //    registerTool drops the standard top-level icons field from the
    //    tools/list payload, so the namespaced record is the vehicle that
    //    survives to OpenAI-class hosts). All on the SAME single tool —
    //    entrypoint count never changes the tool/resource count (I2),
    //    and an app without any openai block serializes byte-identical
    //    to before (I1/I5).
    server.registerTool(
      app.id,
      {
        description: app.description ?? app.title,
        ...(app.openai !== undefined ? { title: app.title } : {}),
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
          ...(app.openai?.tool?.entrypoints !== undefined || app.openai?.icons !== undefined
            ? {
                "openai/ui": {
                  ...(app.openai.tool?.entrypoints !== undefined
                    ? { entrypoints: JSON.parse(JSON.stringify(app.openai.tool.entrypoints)) }
                    : {}),
                  ...(app.openai.icons !== undefined ? { icons: JSON.parse(JSON.stringify(app.openai.icons)) } : {}),
                },
              }
            : {}),
        },
      },
      async (args: Record<string, unknown>) => {
        const initData = app.execute ? await app.execute(args) : {}
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(initData),
            },
          ],
        }
      },
    )
  }
}
