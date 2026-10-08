/**
 * Publish ONE agentproto app as a standalone MCP App server: the app's own
 * bundled tools (`.agentproto/tools/<id>/TOOL.md` run through its
 * `.agentproto/drivers/*\/DRIVER.md` via AIP-30 `runTool`) plus its UI as a
 * `ui://` resource. No daemon behind it and no other tool: unlike the daemon
 * gateway (local-trust by design), this is the surface that may face the
 * public internet, so it serves exactly the app's declared `ui.tools`, and
 * refuses any of them that is not one of the app's own bundled tools.
 *
 * Multi-tenant: `startAppMcpHttp({ tenants })` serves `/mcp/<tenant>`, each
 * tenant with its own resolved secrets (e.g. one shop's API key per tenant).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { loadAppBundledTools, loadAppHandle } from "@agentproto/app-kit"
import { registerUiResource, toMcpTool } from "@agentproto/mcp-server"
import { appUiToolId } from "./app-ui-apps.js"

export interface PublishedApp {
  readonly appId: string
  readonly version: string
  /** The `ui://…/view` uri the rendering tools point at. */
  readonly resourceUri: string
  /** The tool ids served (the app's `ui.tools`). */
  readonly toolIds: readonly string[]
  /** Secret names the app declares (`requirements.secrets`). */
  readonly secretNames: readonly string[]
  /** Build a fresh McpServer (the stateless HTTP transport is single-use,
   *  so every request gets its own server). */
  build(secrets?: Record<string, string>): McpServer
}

export async function loadPublishedApp(dir: string): Promise<PublishedApp> {
  const handle = await loadAppHandle(dir)
  if (!handle.id) throw new Error(`app at '${dir}' has no id`)
  const appId = handle.id
  const ui = handle.ui
  if (!ui) throw new Error(`app "${appId}" has no ui block: nothing to publish as an MCP App`)
  const toolIds = [...(ui.tools ?? [])]
  if (toolIds.length === 0) {
    throw new Error(`app "${appId}" declares no ui.tools: refusing to publish without an explicit tool allowlist`)
  }
  const { tools, drivers } = await loadAppBundledTools(dir)
  const byId = new Map(tools.map(t => [t.id, t]))
  const missing = toolIds.filter(id => !byId.has(id))
  if (missing.length > 0) {
    throw new Error(
      `app "${appId}": ui.tools ${missing.map(m => `'${m}'`).join(", ")} not bundled as .agentproto/tools/<id>/TOOL.md; ` +
        "standalone publishing serves only the app's own bundled tools (there is no daemon behind it)",
    )
  }
  // `ui.renders` (G3) narrows which tools open the UI; absent = all of them.
  const declaredRenders = (ui as { readonly renders?: readonly string[] }).renders
  const renders = new Set(declaredRenders ?? toolIds)
  const resourceUri = `ui://${appUiToolId(appId)}/view`
  const version = handle.version ?? "0.0.0"
  const csp = ui.csp
    ? {
        ...(ui.csp.connectDomains ? { connectDomains: [...ui.csp.connectDomains] } : {}),
        ...(ui.csp.resourceDomains ? { resourceDomains: [...ui.csp.resourceDomains] } : {}),
        ...(ui.csp.frameDomains ? { frameDomains: [...ui.csp.frameDomains] } : {}),
      }
    : undefined

  return {
    appId,
    version,
    resourceUri,
    toolIds,
    secretNames: [...handle.requirements.secrets],
    build(secrets) {
      const server = new McpServer({ name: appId, version })
      registerUiResource(server, {
        name: `${ui.title ?? handle.name ?? appId} UI`,
        uri: resourceUri,
        html: ui.html,
        ...(ui.description !== undefined ? { description: ui.description } : {}),
        ...(csp ? { csp } : {}),
      })
      for (const id of toolIds) {
        toMcpTool(server, {
          tool: byId.get(id)!,
          candidates: drivers,
          ...(secrets ? { secrets } : {}),
          ...(renders.has(id) ? { ui: { resourceUri } } : {}),
        })
      }
      return server
    },
  }
}

export interface StartAppMcpHttpOptions {
  app: PublishedApp
  /** 0 or omitted = auto-assign. */
  port?: number
  /** Default 127.0.0.1. Put a TLS reverse proxy in front for public use. */
  host?: string
  /** Single-tenant secrets, served at `/mcp`. Ignored when `tenants` is set. */
  secrets?: Record<string, string>
  /** Multi-tenant: tenant slug → its secrets, served at `/mcp/<tenant>`. */
  tenants?: Record<string, Record<string, string>>
}

export interface AppMcpHttpHandle {
  readonly url: string
  readonly server: Server
  close(): Promise<void>
}

const TENANT_PATH = /^\/mcp\/([a-z0-9][a-z0-9-]{0,62})$/

export async function startAppMcpHttp(opts: StartAppMcpHttpOptions): Promise<AppMcpHttpHandle> {
  const host = opts.host ?? "127.0.0.1"

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0] ?? "/"
    let secrets: Record<string, string> | undefined
    if (opts.tenants) {
      const m = TENANT_PATH.exec(path)
      const tenant = m?.[1]
      if (tenant === undefined || !Object.hasOwn(opts.tenants, tenant)) {
        res.writeHead(404, { "content-type": "text/plain" }).end("unknown tenant")
        return
      }
      secrets = opts.tenants[tenant]
    } else {
      if (path !== "/mcp") {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found")
        return
      }
      secrets = opts.secrets
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "allow": "POST", "content-type": "text/plain" }).end("method not allowed")
      return
    }
    const server = opts.app.build(secrets)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on("close", () => {
      void transport.close()
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res)
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" }).end(err instanceof Error ? err.message : String(err))
      }
    }
  }

  const http = createServer((req, res) => {
    void handle(req, res)
  })
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject)
    http.listen(opts.port ?? 0, host, () => resolve())
  })
  const { port } = http.address() as AddressInfo
  return {
    url: `http://${host}:${port}`,
    server: http,
    close: () => new Promise<void>(resolve => http.close(() => resolve())),
  }
}
