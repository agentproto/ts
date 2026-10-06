/**
 * McpApp definition for the agentproto App Store panel — the
 * browse/install surface over `app_catalog`, `app_list`, `app_updates`
 * (+ apply verbs `app_install`/`app_resync`/`app_uninstall`), mounted by
 * the daemon in builtin-apps.ts (`makeBuiltinPanelApps`) exactly like
 * work-board.
 *
 * Uses the AgnoMcpApp contract (a local McpApp-compatible shape that does
 * NOT depend on @agstudio/mcp-apps or Mastra). Host wiring: runtime's
 * builtin-apps.ts assembles the mounted list, with this factory closing
 * over the store's LIVE read paths (`listCatalog` is `dispatchTool
 * ("app_catalog")`-equivalent, `listInstalled` reads the live
 * AppRegistry) — so the store's execute() answer and what the same verbs
 * return can't drift.
 *
 * Install CONFIRMATION: the panel NEVER calls `app_install` silently.
 * Through the ui.tools bridge the FIRST call (no `confirm`) comes back a
 * preview (`{needsConfirmation: true, url, sha256|sha, runsBuildCommand}`);
 * the SECOND call repeats the same payload PLUS the returned `confirm`
 * token. Contained in the panel's dialog (ui/main.ts). Direct MCP/CLI
 * callers skip this entirely: the guard's preview costs them an extra
 * call only when they pass it, never a behavioural change (the guard
 * triggers on the panel's ui.tools tool-call path only — see
 * app-tools.ts's `appInstallConfirmation`).
 */

import { z } from "zod"
import { defineApp, type AppHandle } from "@agentproto/app-kit"
import {
  STORE_APP_ID,
  STORE_HTML,
  STORE_TOOL_ID,
  STORE_UI_TOOLS,
} from "./panel.js"
import type { AgnoMcpApp } from "../mcp-app-types.js"

export const storeInputSchema = z.object({
  catalogUrl: z
    .string()
    .optional()
    .describe(
      "Restrict the snapshot to ONE catalog source (`catalog.sources[i].url`). " +
        "Omit for the merged listing app_catalog itself answers.",
    ),
})

export type StoreInput = z.infer<typeof storeInputSchema>

/** The store's own read paths — mirrored off what the SAME MCP verbs
 *  (`app_catalog`, `app_list`, `app_updates`) answer, so the panel's
 *  snapshot can never disagree with the returned rows. Generic over the
 *  row shape (this package doesn't own those record types — they live in
 *  @agentproto/runtime's app-registry / app-catalog) so the host supplies
 *  the concrete type argument when wiring, mirroring
 *  `WorkBoardOps<TTask>`/`SessionsPanelOps<TSession>`. */
export interface StoreOps<TCatalogRow = unknown, TInstalledRow = unknown, TUpdateRow = unknown> {
  listCatalog(catalogUrl?: string): Promise<ReadonlyArray<TCatalogRow>>
  listInstalled(): ReadonlyArray<TInstalledRow>
  listUpdates(): ReadonlyArray<TUpdateRow>
}

export interface StoreOutput<TCatalogRow = unknown, TInstalledRow = unknown, TUpdateRow = unknown> {
  /** `app_catalog`'s entries — featured/uninstalled ones grouped into the
   *  Available shelf by `category`; `updateAvailable` rows read the
   *  Update-available badge. */
  catalog: ReadonlyArray<TCatalogRow>
  /** `app_list`'s installed records — the Installed shelf. */
  installed: ReadonlyArray<TInstalledRow>
  /** `app_updates`' update entries — empty when nothing tracked is stale. */
  updates: ReadonlyArray<TUpdateRow>
  /** Warnings from the catalog sources (a failing source becomes a
   *  warning, never an error — app-tools.ts's app_catalog contract). */
  warnings?: readonly string[]
}

export type { AgnoMcpApp }

export function makeStoreApp<
  TCatalogRow = unknown,
  TInstalledRow = unknown,
  TUpdateRow = unknown,
>(ops: StoreOps<TCatalogRow, TInstalledRow, TUpdateRow>): AgnoMcpApp<StoreInput, StoreOutput<TCatalogRow, TInstalledRow, TUpdateRow>> {
  return {
    id: STORE_TOOL_ID,
    title: "App Store",
    description:
      "Open the agentproto App Store — browse/install apps from the daemon's " +
      "app_catalog, resync and uninstall installed ones. Sections: Installed " +
      "(with an Update-available badge) / Featured+Available from the catalog / " +
      "Install-from-URL / Sources / Builtin panels (the `?install=<appId>` " +
      "deep link pre-opens an entry's install confirmation).",
    inputSchema: storeInputSchema,
    execute: async input => {
      const rows = await ops.listCatalog(input.catalogUrl)
      const warnings: string[] = []
      const catalog = rows.filter(row => {
        const w = (row as { warnings?: readonly string[] }).warnings
        if (w) warnings.push(...(w as readonly string[]))
        return true
      })
      return {
        catalog,
        installed: ops.listInstalled(),
        updates: ops.listUpdates(),
        ...(warnings.length > 0 ? { warnings } : {}),
      }
    },
    html: STORE_HTML,
  }
}

export const storeApp: AppHandle = defineApp({
  id: STORE_APP_ID,
  name: "App Store",
  description:
    "Open the agentproto App Store — installed apps, catalog shelves (featured/available), " +
    "install-from-URL with an explicit confirmation, sources and builtin panels.",
  agents: [],
  ui: {
    html: STORE_HTML,
    title: "App Store",
    tools: [...STORE_UI_TOOLS],
  },
})
