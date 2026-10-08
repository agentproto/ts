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
 *
 * NO BUILT-IN AUTHENTICATION. Anyone who can reach the port can call the
 * served tools with the (tenant's) secrets. The tenant slug in the URL only
 * SELECTS which secrets apply; it is not a credential and must not be treated
 * as one. For anything beyond loopback, put a front proxy in front that
 * terminates TLS and authenticates the caller (and maps caller -> tenant slug).
 *
 * Built-in hardening: Host/Origin are checked against an allowlist when bound
 * to loopback (DNS-rebinding guard) or when `allowedHosts` is set, request
 * bodies are capped (`maxBodyBytes`), and only POST is served.
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
  /**
   * Hostnames (no port) accepted in the `Host` header and, when present, the
   * `Origin` header. Defaults to the loopback names when bound to a loopback
   * address; when bound elsewhere and unset, no Host/Origin check is applied
   * (the front proxy owns that). DNS-rebinding guard.
   */
  allowedHosts?: readonly string[]
  /** Max request body in bytes (default 1 MiB). Larger → 413. */
  maxBodyBytes?: number
}

export interface AppMcpHttpHandle {
  readonly url: string
  readonly server: Server
  close(): Promise<void>
}

const TENANT_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/
const TENANT_PATH = /^\/mcp\/([a-z0-9][a-z0-9-]{0,62})$/
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"]
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

export function isValidTenantSlug(slug: string): boolean {
  return TENANT_SLUG.test(slug)
}

function isLoopbackBind(host: string): boolean {
  return host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host)
}

function hostnameOfHostHeader(value: string): string | undefined {
  try {
    return new URL(`http://${value}`).hostname
  } catch {
    return undefined
  }
}

class BodyTooLargeError extends Error {}

async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const declared = Number(req.headers["content-length"])
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLargeError()
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > limit) throw new BodyTooLargeError()
    chunks.push(buf)
  }
  if (size === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

export async function startAppMcpHttp(opts: StartAppMcpHttpOptions): Promise<AppMcpHttpHandle> {
  const host = opts.host ?? "127.0.0.1"
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const allowed = new Set(
    (opts.allowedHosts ?? (isLoopbackBind(host) ? LOOPBACK_HOSTS : [])).map(h => h.toLowerCase()),
  )

  function hostAllowed(req: IncomingMessage): boolean {
    if (allowed.size === 0) return true
    const hostHeader = req.headers.host
    const hostname = hostHeader ? hostnameOfHostHeader(hostHeader) : undefined
    if (hostname === undefined || !(allowed.has(hostname) || allowed.has(`[${hostname}]`))) return false
    const origin = req.headers.origin
    if (origin !== undefined) {
      const originHost = hostnameOfHostHeader(origin.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""))
      if (originHost === undefined || !(allowed.has(originHost) || allowed.has(`[${originHost}]`))) return false
    }
    return true
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostAllowed(req)) {
      res.writeHead(403, { "content-type": "text/plain" }).end("forbidden host or origin")
      return
    }
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
    let body: unknown
    try {
      body = await readJsonBody(req, maxBody)
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        res.writeHead(413, { "content-type": "text/plain", connection: "close" }).end("request body too large")
      } else {
        res.writeHead(400, { "content-type": "text/plain" }).end("invalid JSON body")
      }
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
      await transport.handleRequest(req, res, body)
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
    close: () =>
      new Promise<void>(resolve => {
        http.close(() => resolve())
        http.closeAllConnections()
      }),
  }
}
