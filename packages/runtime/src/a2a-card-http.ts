/**
 * A2A Agent Card routes (PLAN §1.3):
 *
 *   GET /.well-known/agent-card.json                      daemon index card
 *   GET /a2a/apps/:appId/.well-known/agent-card.json      one card per installed app
 *
 * Skills come only from the manifest's `exposes`. Until `handle.exposes` is
 * on `AppHandle` (app-kit placement/exposes fields), it is read through a
 * narrow optional type, and an app without it exposes nothing.
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import { loadAppHandle } from "@agentproto/app-kit"
import {
  buildAppAgentCard,
  buildDaemonAgentCard,
  type AppCardInput,
  type SkillSource,
} from "@agentproto/a2a"
import type { AppRegistry, InstalledApp } from "./app-registry.js"

export type A2aCardRoute = { kind: "daemon" } | { kind: "app"; appId: string }

const DAEMON_CARD_PATH = "/.well-known/agent-card.json"
const APP_CARD_RE = /^\/a2a\/apps\/(.+)\/\.well-known\/agent-card\.json$/

/** The slice of `AppHandle` a card is built from; `exposes`/`accepts` are optional so an older handle still fits. */
export interface CardHandleView {
  readonly id?: string
  readonly name?: string
  readonly version?: string
  readonly description?: string
  readonly exposes?: { readonly agents?: readonly string[]; readonly workflows?: readonly string[] }
  readonly accepts?: { readonly tasks?: boolean }
  readonly agents: readonly { readonly agent: { readonly id: string; readonly description?: string } }[]
  readonly workflows: readonly { readonly id: string; readonly name?: string; readonly description?: string }[]
}

export type LoadCardHandle = (dir: string) => Promise<CardHandleView>

export interface A2aCardDeps {
  appRegistry: AppRegistry
  /** Daemon HTTP base as seen by this request. */
  baseUrl: string
  /** Test seam; defaults to app-kit's `loadAppHandle`. */
  loadHandle?: LoadCardHandle
}

export function matchA2aCardRoute(method: string | undefined, path: string): A2aCardRoute | null {
  if (method !== "GET") return null
  if (path === DAEMON_CARD_PATH) return { kind: "daemon" }
  const m = path.match(APP_CARD_RE)
  if (!m) return null
  try {
    return { kind: "app", appId: decodeURIComponent(m[1]!) }
  } catch {
    return null
  }
}

function skillSources(
  handle: CardHandleView,
): Pick<AppCardInput, "agents" | "workflows"> {
  const agents: SkillSource[] = handle.agents.map(({ agent }) => ({
    id: agent.id,
    ...(agent.description ? { description: agent.description } : {}),
  }))
  const workflows: SkillSource[] = handle.workflows.map(w => ({
    id: w.id,
    ...(w.name ? { name: w.name } : {}),
    ...(w.description ? { description: w.description } : {}),
  }))
  return { agents, workflows }
}

async function cardInputFor(
  app: InstalledApp,
  baseUrl: string,
  loadHandle: LoadCardHandle,
): Promise<AppCardInput> {
  const handle = await loadHandle(app.dir)
  const name = handle.name ?? app.name
  const description = handle.description ?? app.description
  const version = handle.version ?? app.version
  return {
    appId: app.appId,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(version ? { version } : {}),
    baseUrl,
    exposes: handle.exposes,
    accepts: handle.accepts,
    ...skillSources(handle),
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

export async function handleA2aCardRoute(
  _req: IncomingMessage,
  res: ServerResponse,
  route: A2aCardRoute,
  deps: A2aCardDeps,
): Promise<void> {
  const loadHandle: LoadCardHandle = deps.loadHandle ?? loadAppHandle

  if (route.kind === "app") {
    const app = deps.appRegistry.getApp(route.appId)
    if (!app) {
      sendJson(res, 404, { error: "app_not_found", message: `App "${route.appId}" is not installed.` })
      return
    }
    try {
      sendJson(res, 200, buildAppAgentCard(await cardInputFor(app, deps.baseUrl, loadHandle)))
    } catch (err) {
      sendJson(res, 500, {
        error: "app_load_failed",
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return
  }

  // An app whose bundle no longer loads is left out rather than failing the index.
  const settled = await Promise.allSettled(
    deps.appRegistry.listApps().map(app => cardInputFor(app, deps.baseUrl, loadHandle)),
  )
  const apps = settled.flatMap(r => (r.status === "fulfilled" ? [r.value] : []))
  sendJson(res, 200, buildDaemonAgentCard({ baseUrl: deps.baseUrl, apps }))
}
