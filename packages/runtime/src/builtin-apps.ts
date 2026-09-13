/**
 * Boot-time mount for the daemon-builtin MCP-Apps panels that live in
 * @agentproto/apps (sessions-panel, agents-overview, bureau-sessions,
 * session-story, live-session, session-chat, work-board).
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
 *
 * Also home to `resolveBuiltinPanelUi` — the fallback `GET /apps/:appId/ui`
 * / `POST /apps/:appId/tool-call` (http-server.ts) take when `AppRegistry
 * .getApp` misses. A builtin panel is never persisted to `AppRegistry`
 * (there's no install step, per the doc above), so the standalone REST
 * bridge those routes serve to installed apps 404s for every builtin
 * unless something else resolves its html + `ui.tools` allowlist — this is
 * that something else.
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
  sessionChatApp,
  makeSessionChatApp,
  SESSION_CHAT_APP_ID,
  workBoardApp,
  makeWorkBoardApp,
  type AgnoMcpApp,
  type WorkBoardOutput,
} from "@agentproto/apps"
import type { AppHandle } from "@agentproto/app-kit"
import type { SessionDescriptor } from "./sessions.js"
import type { TaskRecord } from "./task-ledger.js"

export interface BuiltinPanelAppsOps {
  listSessions(filter?: "running" | "all"): SessionDescriptor[]
  /** The daemon's own HTTP origin, e.g. "http://127.0.0.1:18790" — the
   *  live-session widget's SSE stream + bridge fallback connect here. */
  httpBaseUrl: string
  /** Whether the `@agentik/session-chat` studio app is installed with a
   *  `ui` block — the session-chat widget is a thin launcher for it and
   *  degrades to an install notice when this is false. */
  isSessionChatInstalled: () => boolean
  /** Full (unprojected) Task ledger records for a board — the work-board
   *  widget's read path. Omit `boardId` to resolve the operator's default
   *  board (`ws:<slug>`). */
  listTasks(boardId?: string): WorkBoardOutput<TaskRecord>
}

/**
 * Build the builtin panel apps, ready to pass into `registerMcpApps`
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
    // Session-chat widget — thin launcher for the installed
    // `@agentik/session-chat` app's standalone UI (deep-linked iframe when
    // installed, install notice otherwise; see apps/src/session-chat).
    makeSessionChatApp({
      httpBaseUrl: ops.httpBaseUrl,
      isSessionChatInstalled: ops.isSessionChatInstalled,
    }),
    // Work-board widget — kanban over the Task ledger (see apps/src/
    // work-board). Read path only; writes go through task_claim/
    // task_update/task_create over the bridge, same as every other caller.
    makeWorkBoardApp<TaskRecord>({ listTasks: ops.listTasks }),
  ]
}

/** The panels' `AppHandle`s (catalog identity: `id`/`name`/
 *  `description`), in the same order `makeBuiltinPanelApps` mounts their
 *  `AgnoMcpApp` counterparts — zipped together below to pair each handle
 *  with its actual mounted tool id / resource uri. */
const PANEL_APP_HANDLES: readonly AppHandle[] = [
  sessionsPanelApp,
  agentsOverviewApp,
  bureauSessionsApp,
  sessionStoryApp,
  liveSessionApp,
  sessionChatApp,
  workBoardApp,
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
 * Catalog metadata for the builtin panels — for `app_catalog` / the
 * Apps tree, NOT for mounting them (see `makeBuiltinPanelApps` for that).
 * Always present, independent of `~/.agentproto/apps.json` or the catalog
 * file: these panels need no `app_install` step, so `app_catalog`'s caller
 * (app-tools.ts) merges this list in directly rather than reading it off
 * disk. `appId`/`name`/`description` come from each panel's real `AppHandle`
 * (`PANEL_APP_HANDLES`); `toolId`/`resourceUri` come from the actual mounted
 * `AgnoMcpApp` (`app.id`) since those are the real MCP-visible identifiers,
 * not the app-kit handle's. `listSessions`/`httpBaseUrl`/`listTasks` below
 * are never invoked — only the static id metadata on each built `AgnoMcpApp`
 * is read.
 */
/** One builtin panel's standalone-serving material — the fallback
 *  `GET /apps/:appId/ui` / `POST /apps/:appId/tool-call` (http-server.ts)
 *  take when `AppRegistry.getApp` misses, since a builtin is never
 *  persisted there (see this file's header doc). `tools` is the panel's
 *  OWN declared allowlist — the same list `performBuiltinPanelToolCall`
 *  (app-tools.ts) gates dispatch against, so a builtin's tool-call route is
 *  exactly as locked down as an installed app's `ui.tools`. */
export interface BuiltinPanelUi {
  readonly html: string
  readonly tools: readonly string[]
}

/**
 * Resolve a builtin panel's standalone html + tool allowlist by its catalog
 * `appId` (e.g. `@agentproto/work-board`) — `undefined` for anything that
 * isn't one of the panels this WP covers, which the caller must then 404
 * rather than fall through to an installed-app lookup.
 *
 * `@agentproto/session-chat-widget` (`sessionChatApp`) is deliberately NOT
 * resolvable here even though it's in `PANEL_APP_HANDLES`: its html is only
 * ever a deep-link iframe (or install notice) pointed at the INSTALLED
 * `@agentik/session-chat` app's own `/apps/:appId/ui` (see
 * session-chat/index.ts's `sessionChatAppUrl`) — that route already serves
 * it, so there is no separate standalone content to serve under the
 * widget's own id.
 *
 * `live-session` is the one panel whose html is origin-dependent
 * (`window.__APP_INIT__.httpBaseUrl`, read by its SSE `EventSource`) — its
 * static `AppHandle.ui.html` (the catalog/emit/`app_install` snapshot) bakes
 * the daemon's documented DEFAULT port, which is only correct when the
 * daemon happens to be running there. Re-rendered here with the CALLER's
 * own `httpBaseUrl` (the requesting daemon's real origin, derived by
 * http-server.ts from the request itself) instead, so the served widget's
 * stream always points at the daemon that's actually serving it. Every
 * other panel's html only ever talks to its host via the relative
 * `./tool-call` bridge fetch, so it's served unmodified.
 */
export function resolveBuiltinPanelUi(appId: string, httpBaseUrl: string): BuiltinPanelUi | undefined {
  if (appId === liveSessionApp.id) {
    const app = makeLiveSessionApp({ httpBaseUrl })
    const html = typeof app.html === "function" ? app.html({ httpBaseUrl }) : app.html
    return { html, tools: liveSessionApp.ui?.tools ?? [] }
  }
  const handle = [sessionsPanelApp, agentsOverviewApp, bureauSessionsApp, sessionStoryApp, workBoardApp].find(
    h => h.id === appId,
  )
  if (!handle?.ui) return undefined
  return { html: handle.ui.html, tools: handle.ui.tools ?? [] }
}

export function builtinPanelCatalogEntries(): BuiltinPanelCatalogEntry[] {
  const apps = makeBuiltinPanelApps({
    listSessions: () => [],
    httpBaseUrl: "http://127.0.0.1:0",
    isSessionChatInstalled: () => false,
    listTasks: (boardId) => ({ boardId: boardId ?? "ws:default", tasks: [] }),
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
