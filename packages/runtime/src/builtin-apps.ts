/**
 * Boot-time mount for the five daemon-builtin MCP-Apps panels that live in
 * @agentproto/apps (sessions-panel, agents-overview, bureau-sessions,
 * session-story, live-session).
 *
 * These panels used to be plain files in this package; they moved to
 * @agentproto/apps as house-app-quality code (see that package's README).
 * Each panel ships in two forms there: a real `defineApp()` `AppHandle`
 * (`agents: []`, UI-only — the catalog/emit/`app_install` path) and a
 * separate `make<Name>App(ops)` factory producing the `AgnoMcpApp` shape
 * this file mounts directly. This module wraps each factory with runtime's
 * own SessionDescriptor-typed `listSessions` ops and feeds the result
 * straight into `registerMcpApps` (mcp-apps-adapter.ts) alongside
 * `installedAppUiApps`, exactly where `builtinPanelApps` used to be built
 * inline in index.ts — no `app_install`/`AppRegistry` step, because the
 * factory needs LIVE daemon closures (`listSessions`, `httpBaseUrl`) that
 * the static `AppHandle`'s emitted `ui.html` snapshot can't carry. Public
 * tool ids, input schemas, resourceUris (`ui://<id>/view`, derived by
 * mcp-apps-adapter.ts), and `execute()` behavior are byte-identical to
 * before the move — only where the code lives changed.
 *
 * Kept separate from index.ts's terminal-panel-app wiring (which stays
 * local to runtime — it needs the PTY WebSocket + `spawnOrAttach`, not a
 * portable, dependency-free `AgnoMcpApp` factory) so this file is a
 * focused list of "here are the @agentproto/apps panels we mount
 * unconditionally, no install step required".
 */

import {
  makeSessionsPanelApp,
  makeAgentsOverviewApp,
  makeBureauSessionsApp,
  makeSessionStoryPanelApp,
  makeLiveSessionApp,
  sessionsPanelApp,
  agentsOverviewApp,
  bureauSessionsApp,
  sessionStoryApp,
  liveSessionApp,
  type AgnoMcpApp,
} from "@agentproto/apps"
import type { AppHandle } from "@agentproto/app-kit"
import type { SessionDescriptor } from "./sessions.js"

export interface BuiltinPanelAppsOps {
  listSessions(filter?: "running" | "all"): SessionDescriptor[]
  /** The daemon's own HTTP origin, e.g. "http://127.0.0.1:18790" — the
   *  live-session widget's SSE stream + bridge fallback connect here. */
  httpBaseUrl: string
}

/**
 * Build the five builtin panel apps, ready to pass into `registerMcpApps`
 * alongside installed apps' UI panels.
 */
export function makeBuiltinPanelApps(
  ops: BuiltinPanelAppsOps,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): AgnoMcpApp<any, any>[] {
  return [
    makeSessionsPanelApp<SessionDescriptor>({ listSessions: ops.listSessions }),
    makeAgentsOverviewApp<SessionDescriptor>({ listSessions: ops.listSessions }),
    makeBureauSessionsApp<SessionDescriptor>({ listSessions: ops.listSessions }),
    makeSessionStoryPanelApp<SessionDescriptor>({ listSessions: ops.listSessions }),
    // Live-session widget — resource ui://live_session/view, also bound to
    // `agent_start` via _meta.ui.resourceUri (agent-tools.ts) so a launch
    // auto-renders it.
    makeLiveSessionApp({ httpBaseUrl: ops.httpBaseUrl }),
  ]
}

/** The five panels' `AppHandle`s (catalog identity: `id`/`name`/
 *  `description`), in the same order `makeBuiltinPanelApps` mounts their
 *  `AgnoMcpApp` counterparts — zipped together below to pair each handle
 *  with its actual mounted tool id / resource uri. */
const PANEL_APP_HANDLES: readonly AppHandle[] = [
  sessionsPanelApp,
  agentsOverviewApp,
  bureauSessionsApp,
  sessionStoryApp,
  liveSessionApp,
]

export interface BuiltinPanelCatalogEntry {
  readonly appId: string
  readonly name: string
  readonly description: string
  readonly dir: string
  readonly category: "builtin"
  readonly installed: true
  readonly hasUi: true
  readonly hasArtifact: false
  readonly hasSkill: false
  /** The panel's actual, stable MCP tool id (distinct from `appId` above). */
  readonly toolId: string
  readonly resourceUri: string
}

/**
 * Catalog metadata for the five builtin panels — for `app_catalog` / the
 * Apps tree, NOT for mounting them (see `makeBuiltinPanelApps` for that).
 * Always present, independent of `~/.agentproto/apps.json` or the catalog
 * file: these panels need no `app_install` step, so `app_catalog`'s caller
 * (app-tools.ts) merges this list in directly rather than reading it off
 * disk. `appId`/`name`/`description` come from each panel's real `AppHandle`
 * (`PANEL_APP_HANDLES`); `toolId`/`resourceUri` come from the actual mounted
 * `AgnoMcpApp` (`app.id`) since those are the real MCP-visible identifiers,
 * not the app-kit handle's. `listSessions`/`httpBaseUrl` below are never
 * invoked — only the static id metadata on each built `AgnoMcpApp` is read.
 */
export function builtinPanelCatalogEntries(): BuiltinPanelCatalogEntry[] {
  const apps = makeBuiltinPanelApps({
    listSessions: () => [],
    httpBaseUrl: "http://127.0.0.1:0",
  })
  return apps.map((app, i) => {
    const handle = PANEL_APP_HANDLES[i]!
    const slug = (handle.id ?? app.id).replace(/^@[^/]+\//, "")
    return {
      appId: handle.id ?? `@agentproto/${slug}`,
      name: handle.name ?? app.title,
      description: handle.description ?? app.description ?? app.title,
      dir: `packages/apps/src/${slug}`,
      category: "builtin",
      installed: true,
      hasUi: true,
      hasArtifact: false,
      hasSkill: false,
      toolId: app.id,
      resourceUri: `ui://${app.id}/view`,
    }
  })
}
