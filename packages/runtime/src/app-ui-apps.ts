/**
 * Dynamic MCP-app panels for installed `@agentproto/app-kit` apps that ship
 * a `ui` block (`defineApp({ ui: { html, title?, tools?, csp? } })`,
 * `app-tools.ts`'s `performInstall`). Bridges `AppRegistry` → `AgnoMcpApp[]`
 * so `registerMcpApps` (mcp-apps-adapter.ts) can mount them next to the
 * built-in panels (agentproto_sessions, agents_overview, ...).
 *
 * `mcpServerFactory` (index.ts) rebuilds a fresh McpServer per `/mcp`
 * request, so this module never throws — a bad app record must not take
 * down every other request. Failures (a collided tool id, an unreadable
 * `ui.path`) are skipped with a `console.warn`, not surfaced to the caller.
 */

import { readFile } from "node:fs/promises"
import { z } from "zod"
import type { AppRegistry } from "./app-registry.js"
import type { AgnoMcpApp } from "./sessions-panel-app.js"

/** Derive the MCP tool id for an installed app's UI panel — strips the
 *  `@owner/` scope (if any) and maps every non `[a-z0-9]` character to `_`. */
export function appUiToolId(appId: string): string {
  const slug = appId.replace(/^@[^/]+\//, "").replace(/[^a-z0-9]/g, "_")
  return `app_ui_${slug}`
}

interface UiHtmlCache {
  get(path: string, version: string): Promise<string>
}

/** Per-path HTML cache keyed by `(path, version)` — a request rebuilds the
 *  McpServer every time, but re-reading an installed app's `ui.path` off
 *  disk on every `/mcp` call would be wasteful when nothing changed. The
 *  cache lives at gateway scope (created once in index.ts, outside
 *  `mcpServerFactory`) so it actually persists across requests; `version`
 *  (the app's `updatedAt`) invalidates a stale entry after a re-install. */
export function createUiHtmlCache(): UiHtmlCache {
  const cache = new Map<string, { version: string; html: string }>()
  return {
    async get(path, version) {
      const cached = cache.get(path)
      if (cached && cached.version === version) return cached.html
      const html = await readFile(path, "utf8")
      cache.set(path, { version, html })
      return html
    },
  }
}

/**
 * Build one `AgnoMcpApp` per installed app that has a `ui` block, skipping
 * (with a `console.warn`) any whose derived tool id collides with
 * `existingToolNames` (built-in panels) or an earlier installed app in this
 * same pass, and any whose `ui.path` can't be read.
 */
export async function makeInstalledAppUiApps(
  appRegistry: AppRegistry,
  cache: UiHtmlCache,
  existingToolNames: Set<string>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<AgnoMcpApp<any, any>[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apps: AgnoMcpApp<any, any>[] = []
  const seen = new Set<string>(existingToolNames)

  for (const app of appRegistry.listApps()) {
    const ui = app.ui
    if (!ui) continue

    const toolId = appUiToolId(app.appId)
    if (seen.has(toolId)) {
      console.warn(
        `[app-ui-apps] skipping UI panel for app "${app.appId}": tool id "${toolId}" ` +
          "collides with an existing tool or another installed app's panel.",
      )
      continue
    }

    let html: string
    try {
      html = await cache.get(ui.path, app.updatedAt)
    } catch (err) {
      console.warn(
        `[app-ui-apps] skipping UI panel for app "${app.appId}": could not read "${ui.path}": ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
      continue
    }

    seen.add(toolId)
    apps.push({
      id: toolId,
      title: ui.title ?? app.name ?? app.appId,
      ...(ui.description ? { description: ui.description } : {}),
      inputSchema: z.object({}),
      execute: async () => ({ appId: app.appId, tools: ui.tools ?? [] }),
      html,
      ...(ui.csp
        ? {
            csp: {
              ...(ui.csp.connectDomains ? { connectDomains: [...ui.csp.connectDomains] } : {}),
              ...(ui.csp.resourceDomains ? { resourceDomains: [...ui.csp.resourceDomains] } : {}),
            },
          }
        : {}),
    })
  }

  return apps
}
