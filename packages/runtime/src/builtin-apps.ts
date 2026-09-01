/**
 * Boot-time mount for the five daemon-builtin MCP-Apps panels that live in
 * @agentproto/apps (sessions-panel, agents-overview, bureau-sessions,
 * session-story, live-session).
 *
 * These panels used to be plain files in this package; they moved to
 * @agentproto/apps as house-app-quality code (see that package's README).
 * They are NOT installed `AppHandle`s — `defineApp` requires a non-empty
 * `agents` array and these are pure read-only viewers with no agent of
 * their own — so instead of going through `app_install`/`AppRegistry`,
 * this module wraps each factory with runtime's own SessionDescriptor-typed
 * `listSessions` ops and feeds the result straight into `registerMcpApps`
 * (mcp-apps-adapter.ts) alongside `installedAppUiApps`, exactly where
 * `builtinPanelApps` used to be built inline in index.ts. Public tool ids,
 * input schemas, resourceUris (`ui://<id>/view`, derived by
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
  type AgnoMcpApp,
} from "@agentproto/apps"
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

/** Package-scoped catalog id + @agentproto/apps source slug for each
 *  builtin panel's MCP tool id — a SEPARATE namespace from the tool id
 *  itself (mirrors how an installed app has both an `appId` like
 *  `@agentproto/ops-panel` and a derived MCP tool id like
 *  `app_ui_ops_panel`). Used only for `app_catalog` / Apps-tree display. */
const BUILTIN_PANEL_SLUGS: Readonly<Record<string, string>> = {
  agentproto_sessions: "sessions-panel",
  agentproto_agents_overview: "agents-overview",
  agentproto_bureau_sessions: "bureau-sessions",
  agentproto_session_story: "session-story",
  live_session: "live-session",
}

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
 * disk. `listSessions`/`httpBaseUrl` below are never invoked — only the
 * static id/title/description metadata on each built `AgnoMcpApp` is read.
 */
export function builtinPanelCatalogEntries(): BuiltinPanelCatalogEntry[] {
  const apps = makeBuiltinPanelApps({
    listSessions: () => [],
    httpBaseUrl: "http://127.0.0.1:0",
  })
  return apps.map(app => {
    const slug = BUILTIN_PANEL_SLUGS[app.id] ?? app.id
    return {
      appId: `@agentproto/${slug}`,
      name: app.title,
      description: app.description ?? app.title,
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
