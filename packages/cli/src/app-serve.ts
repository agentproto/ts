/**
 * `agentproto app serve [appDir] [--port <n>] [--json]`
 *
 * Serve an agentproto app's `.agentproto/ui/` as a standalone webapp with a
 * working `window.McpApp` bridge, so the same UI that renders inside an
 * MCP-Apps panel runs in a plain browser tab with full MCP connectivity.
 *
 * Two moving parts:
 *
 *   1. A tiny static server (Node `http` + `fs`) that serves the app's
 *      `ui/` directory (index.html, CSS, JS, images) and injects the
 *      standalone bridge script into every `index.html` response.
 *
 *   2. The bridge. Unlike a host iframe (which talks JSON-RPC over
 *      `postMessage`) or the installed-app REST twin (which POSTs to the
 *      daemon's sibling `./tool-call` route), a raw app dir has no installed
 *      appId behind it — so the daemon's `/apps/:appId/tool-call` route can't
 *      target it. Instead `app serve` holds its OWN protocol client to the
 *      daemon's `/mcp` Streamable-HTTP endpoint (the same
 *      `Client` + `StreamableHTTPClientTransport` pair `mcp-bridge` uses) and
 *      exposes a same-origin JSON `POST /__agentproto/tool-call` route. The
 *      in-page bridge POSTs there; the route forwards the call through the
 *      client and returns the raw MCP `CallToolResult` envelope — the exact
 *      shape an MCP-Apps host's `tools/call` reply carries, so an app's own
 *      unwrapping code behaves identically in panel and standalone modes.
 *
 * Why not have the browser fetch the daemon's `/mcp` directly? That endpoint
 * is an MCP Streamable-HTTP transport (stateful/stateless, per-request
 * transport rebuild, SSE-streamed by default); a bare `tools/call` fetch from
 * the page misses the `Mcp-Protocol-Version` header negotiation and the SSE
 * response framing. Holding the client server-side sidesteps all of it and
 * keeps the injected bridge to a few lines of pure fetch.
 *
 * Port resolution (lowest wins):
 *   `--port <n>` > APP.md frontmatter `ui.port` > OS auto-assign (listen 0).
 * A declared `ui.port` that's already taken falls back to auto-assign rather
 * than failing; an explicit `--port` that's taken is a hard error.
 */

import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { extname, join, normalize, resolve, sep, dirname } from "node:path"
import { parseArgs } from "node:util"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import matter from "gray-matter"

import { loadConfig } from "@agentproto/runtime/config"
import { pathExists } from "./commands/skill-install/shared.js"
import { expandHome } from "./commands/skill-install/pack-resolve.js"

// ── installed-app registry (shared with daemon's ~/.agentproto/apps.json) ──

import { homedir } from "node:os"
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs"

const APPS_JSON_PATH = join(homedir(), ".agentproto", "apps.json")

interface AppsJsonFile {
  apps?: { appId: string; dir: string; dataDir?: string }[]
  runs?: unknown[]
  applied?: unknown[]
}

function loadAppsJson(): AppsJsonFile {
  if (!existsSync(APPS_JSON_PATH)) return {}
  try {
    return JSON.parse(readFileSync(APPS_JSON_PATH, "utf8")) as AppsJsonFile
  } catch {
    return {}
  }
}

function saveAppsJson(data: AppsJsonFile): void {
  mkdirSync(dirname(APPS_JSON_PATH), { recursive: true })
  const tmp = `${APPS_JSON_PATH}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8")
  renameSync(tmp, APPS_JSON_PATH)
}

/** Resolve an installed app's directory by its `appId`. Returns `undefined`
 *  when no app with that id is registered. */
export function findInstalledAppDir(appId: string): string | undefined {
  const data = loadAppsJson()
  const app = data.apps?.find((a) => a.appId === appId)
  return app?.dir
}

/** Register (or update) an app id → directory mapping in `~/.agentproto/apps.json`.
 *  Preserves unrelated keys (`runs`, `applied`) the daemon manages.
 *
 *  `dataDir` is the absolute root of the app's durable data (`app_data_*`).
 *  Precedence mirrors the daemon's `performInstall`: an explicit `dataDir`
 *  > the entry's previously registered `dataDir` (a bare re-install never
 *  moves data) > `hintDir` (APP.md `data.dir`, relative to `dir`) >
 *  `<dir>/data`. Returns the entry as written. */
export function installAppDir(
  appId: string,
  dir: string,
  opts?: { dataDir?: string; hintDir?: string },
): { appId: string; dir: string; dataDir: string } {
  const data = loadAppsJson()
  const apps = data.apps ?? []
  const idx = apps.findIndex((a) => a.appId === appId)
  const previous = idx === -1 ? undefined : apps[idx]?.dataDir
  const raw = opts?.dataDir ?? previous ?? opts?.hintDir
  const dataDir = raw === undefined ? resolve(dir, "data") : resolve(dir, expandHome(raw))
  const entry = idx === -1 ? { appId, dir, dataDir } : { ...apps[idx], appId, dir, dataDir }
  if (idx === -1) {
    apps.push(entry)
  } else {
    apps[idx] = entry
  }
  data.apps = apps
  saveAppsJson(data)
  return entry
}

/** Every registered app (`appId` → `dir`, plus its `dataDir` — defaulting to
 *  `<dir>/data` for entries written before the field existed). */
export function listInstalledApps(): { appId: string; dir: string; dataDir: string }[] {
  const data = loadAppsJson()
  return (Array.isArray(data.apps) ? data.apps : []).map((a) => ({
    appId: a.appId,
    dir: a.dir,
    dataDir: a.dataDir ?? resolve(a.dir, "data"),
  }))
}

const USAGE = `agentproto app serve — serve an app's UI as a standalone webapp

Usage:
  agentproto app serve [appDir] [--port <n>] [--host <addr>] [--app <appId>] [--json]

appDir:
  Directory holding a valid .agentproto/APP.md + .agentproto/ui/. Defaults to
  the current directory. Ignored when --app is given.

--app <appId>:
  Serve an INSTALLED app by its id (resolved from ~/.agentproto/apps.json).
  When given, appDir is ignored — the registered directory is used instead.
  Install an app first: agentproto app install <dir>

--port <n>:
  Port to bind. Defaults to the app's declared "ui.port" (APP.md frontmatter),
  else an OS-assigned free port. A taken declared port falls back to
  auto-assign; a taken explicit --port is an error.

--host <addr>:
  Address to bind (default: 127.0.0.1 — loopback only). Pass 0.0.0.0 to
  expose on all interfaces. This is an explicit opt-in: a warning is printed
  to stderr when a non-default address is used.

The served UI gets a window.McpApp bridge whose callTool forwards to the
daemon's /mcp endpoint (http://127.0.0.1:<daemon.port>/mcp). Start the daemon
first: agentproto serve`

// reserved route the in-page bridge POSTs tool calls to — a double-underscore
// prefix no app's ui/ static files should collide with. Exported so `app dev`
// (a separate bridge-only server, see app-dev.ts) POSTs to the same path.
export const TOOL_CALL_PATH = "/__agentproto/tool-call"

// sibling reserved route a browser UI POSTs raw file bytes to, landing in
// `<appDir>/inbox/`.
const UPLOAD_PATH = "/__agentproto/upload"

/** Hard cap on an upload's body size — 200 MB. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024

/**
 * Resolve the hostname/IP to bind the static server to.
 * Defaults to `127.0.0.1` (loopback only). Pass `--host <addr>` to opt in to
 * a broader bind; the caller is responsible for printing the warning.
 */
export function resolveListenHost(hostOpt?: string): string {
  return hostOpt ?? "127.0.0.1"
}

/** Content types for the static surface (extensions ui/ apps actually ship). */
const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
}

/**
 * Resolve the daemon's /mcp URL from config — mirrors mcp-bridge. Exported
 * for `app dev`, which holds its own daemon MCP client the same way `app
 * serve` does.
 */
export async function resolveDaemonMcpUrl(): Promise<string> {
  const cfg = await loadConfig()
  const port = cfg.daemon?.port ?? 18790
  return `http://127.0.0.1:${port}/mcp`
}

/**
 * Build a lazy, cached getter for a Streamable-HTTP MCP client to the
 * daemon's /mcp endpoint. The client connects on first use and is reused
 * across calls; a failed connect attempt drops the cached promise so the
 * next call retries rather than permanently surfacing the first failure.
 * Shared by `app serve` and `app dev` — both hold their own protocol client
 * to the daemon rather than proxying through an installed appId.
 */
export function createDaemonMcpClientGetter(
  daemonMcpUrl: string,
  clientName: string,
): () => Promise<Client> {
  let clientPromise: Promise<Client> | null = null
  return (): Promise<Client> => {
    if (!clientPromise) {
      clientPromise = (async () => {
        const client = new Client(
          { name: clientName, version: "0.1.0" },
          { capabilities: {} },
        )
        const transport = new StreamableHTTPClientTransport(new URL(daemonMcpUrl))
        await client.connect(transport)
        return client
      })().catch((err) => {
        clientPromise = null
        throw err
      })
    }
    return clientPromise
  }
}

/**
 * Handle a `POST /__agentproto/tool-call` request end-to-end: read the JSON
 * body (capped at 1MB), forward it through `callDaemonTool`, and write the
 * response. Shared by `app serve` (same-origin static server) and `app dev`
 * (bridge-only CORS server) so the wire contract is identical between them.
 *
 * `allowedTools` is the app's `ui.tools` allowlist from APP.md. When defined,
 * only the listed tools are forwarded; when `undefined` (field absent from
 * APP.md), all tools are allowed. Pass `[]` to block everything.
 */
export function handleToolCallRequest(
  req: IncomingMessage,
  res: ServerResponse,
  getClient: () => Promise<Client>,
  allowedTools?: readonly string[],
): void {
  let raw = ""
  req.setEncoding("utf8")
  req.on("data", (chunk: string) => {
    raw += chunk
    if (raw.length > 1_000_000) {
      req.destroy()
    }
  })
  req.on("end", () => {
    void (async () => {
      let body: unknown
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "bad_request", message: "body is not valid JSON." }))
        return
      }
      const [status, result] = await callDaemonTool(getClient, body, allowedTools)
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(result))
    })()
  })
}

/**
 * `POST /__agentproto/tool-call` body `{ name, args? }`, returning the raw MCP
 * `CallToolResult` envelope. Returns a 2-tuple `[status, body]` so the caller
 * chooses the error framing; carries `isError` results as 200 (the same way a
 * postMessage host's `tools/call` reply RESOLVES with them).
 *
 * `allowedTools`: when defined, only listed tool names are forwarded (403
 * otherwise). When `undefined` (APP.md omits `ui.tools`), all tools pass.
 * Mirrors the `ui.tools` allowlist that `/apps/:appId/tool-call` enforces
 * via `performAppToolCall` in the daemon.
 */
export async function callDaemonTool(
  getClient: () => Promise<Client>,
  body: unknown,
  allowedTools?: readonly string[],
): Promise<[number, unknown]> {
  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as { name?: unknown }).name !== "string" ||
    (body as { name: string }).name.length === 0
  ) {
    return [400, { error: "bad_request", message: 'body must be `{ "name": string, args?: object }`.' }]
  }
  const { name, args } = body as { name: string; args?: unknown }
  if (allowedTools !== undefined && !allowedTools.includes(name)) {
    return [
      403,
      {
        error: "forbidden",
        message: `tool "${name}" is not in this app's ui.tools allowlist: ${allowedTools.length > 0 ? allowedTools.join(", ") : "(empty)"}`,
      },
    ]
  }
  let client: Client
  try {
    client = await getClient()
  } catch (err) {
    return [
      502,
      {
        error: "daemon_unreachable",
        message:
          `could not reach the daemon's /mcp endpoint: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `Start the daemon first: agentproto serve`,
      },
    ]
  }
  try {
    const callArgs: Record<string, unknown> =
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {}
    const result = await client.callTool({
      name,
      arguments: callArgs,
    })
    return [200, result]
  } catch (err) {
    return [502, { error: "tool_call_failed", message: err instanceof Error ? err.message : String(err) }]
  }
}

/**
 * Extract the app's declared `ui.port` from `<dir>/.agentproto/APP.md`
 * frontmatter, if any. Returns undefined when absent/unparseable — never
 * throws on a bad value, so a hand-edited APP.md doesn't brick `serve`.
 */
export async function readDeclaredUIPort(appDir: string): Promise<number | undefined> {
  const appMdPath = join(appDir, ".agentproto", "APP.md")
  if (!(await pathExists(appMdPath))) return undefined
  try {
    const raw = await readFile(appMdPath, "utf8")
    const data = matter(raw).data as Record<string, unknown>
    const ui = data.ui
    if (!ui || typeof ui !== "object") return undefined
    const port = (ui as Record<string, unknown>).port
    return typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536
      ? port
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Extract the app's declared `ui.tools` string list from
 * `<dir>/.agentproto/APP.md` frontmatter, if any.
 *
 * Returns `string[]` when the field is present (possibly empty), or
 * `undefined` when it is absent — the distinction matters for allowlist
 * enforcement: an explicitly-empty list blocks everything, while an absent
 * list means the app predates the field and we allow all tools (the loopback
 * bind already limits network exposure).
 */
export async function readDeclaredUITools(appDir: string): Promise<string[] | undefined> {
  const appMdPath = join(appDir, ".agentproto", "APP.md")
  if (!(await pathExists(appMdPath))) return undefined
  try {
    const raw = await readFile(appMdPath, "utf8")
    const data = matter(raw).data as Record<string, unknown>
    const ui = data.ui
    if (!ui || typeof ui !== "object") return undefined
    const tools = (ui as Record<string, unknown>).tools
    if (!Array.isArray(tools)) return undefined
    return tools.filter((t): t is string => typeof t === "string")
  } catch {
    return undefined
  }
}

/**
 * Sanitize a client-supplied upload filename down to a safe basename, or
 * `null` if it can't be made safe. Strips any directory components (either
 * separator, regardless of host OS) and rejects the result if it's empty, a
 * dotfile, or still contains `..`.
 */
export function sanitizeUploadName(raw: string | null | undefined): string | null {
  if (!raw) return null
  const base = raw.split(/[\\/]/).pop() ?? ""
  if (base.length === 0) return null
  if (base.startsWith(".")) return null
  if (base.includes("..")) return null
  return base
}

/**
 * Pick the on-disk name for an upload inside `inboxDir`: `filename` if free,
 * else `<stem>-2<ext>`, `<stem>-3<ext>`, … before the extension so the
 * original never gets overwritten.
 */
export async function resolveInboxTarget(
  inboxDir: string,
  filename: string,
): Promise<{ path: string; finalName: string }> {
  const ext = extname(filename)
  const stem = filename.slice(0, filename.length - ext.length)
  let candidate = filename
  for (let n = 2; await pathExists(join(inboxDir, candidate)); n++) {
    candidate = `${stem}-${n}${ext}`
  }
  return { path: join(inboxDir, candidate), finalName: candidate }
}

/** Pure accumulator enforcing the upload size cap while streaming chunks in. */
export class UploadSizeTracker {
  private total = 0

  constructor(private readonly limit: number = MAX_UPLOAD_BYTES) {}

  get bytes(): number {
    return this.total
  }

  /** Record a chunk's length; returns true once the running total exceeds the limit. */
  add(length: number): boolean {
    this.total += length
    return this.total > this.limit
  }
}

/**
 * `POST /__agentproto/upload?filename=<name>` — raw body = file bytes.
 * Streams into memory (capped at `MAX_UPLOAD_BYTES`) and writes to
 * `<appDir>/inbox/<finalName>`.
 */
async function handleUpload(
  req: IncomingMessage,
  res: ServerResponse,
  appDir: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1")
  const filename = sanitizeUploadName(url.searchParams.get("filename"))
  if (!filename) {
    res.writeHead(400, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "bad_filename" }))
    return
  }

  const chunks: Buffer[] = []
  const tracker = new UploadSizeTracker()
  let responded = false

  req.on("data", (chunk: Buffer) => {
    if (responded) return
    if (tracker.add(chunk.length)) {
      responded = true
      res.writeHead(413, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "payload_too_large" }))
      req.destroy()
      return
    }
    chunks.push(chunk)
  })

  req.on("end", () => {
    if (responded) return
    void (async () => {
      const inboxDir = join(appDir, "inbox")
      await mkdir(inboxDir, { recursive: true })
      const { path: targetPath, finalName } = await resolveInboxTarget(inboxDir, filename)
      const data = Buffer.concat(chunks)
      await writeFile(targetPath, data)
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ path: `inbox/${finalName}`, bytes: data.length }))
    })()
  })

  // Swallow the error a destroyed (over-cap) request emits — already responded.
  req.on("error", () => {
    responded = true
  })
}

/** Serve one static file from the ui/ root, injecting the bridge on index.html. */
async function serveStatic(
  uiRoot: string,
  urlPath: string,
  bridgeScript: string,
  res: ServerResponse,
): Promise<void> {
  // Resolve against the ui/ root and verify the result stays inside it
  // (defense-in-depth against `..` traversal).
  const safeName = urlPath.split("?")[0] ?? "/"
  const index = safeName === "/" || safeName === "" ? "index.html" : safeName
  const target = resolve(uiRoot, "." + normalize("/" + index).replace(/^\/+/, "/"))
  if (target !== uiRoot && !target.startsWith(uiRoot + sep)) {
    res.writeHead(403, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "forbidden", path: safeName }))
    return
  }

  let st
  try {
    st = await stat(target)
  } catch {
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "not_found", path: safeName }))
    return
  }
  if (st.isDirectory()) {
    // Directory listing → the ui/ conventional entry point.
    if (urlPath.endsWith("/") || urlPath === "") {
      return serveStatic(uiRoot, (safeName.replace(/\/+$/, "") || "") + "/index.html", bridgeScript, res)
    }
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "not_found", path: safeName }))
    return
  }

  const mime =
    MIME_BY_EXT[extname(target).toLowerCase()] ?? "application/octet-stream"
  const isHtml = (index as string).endsWith(".html") || (index as string).endsWith(".htm")
  if (isHtml) {
    const html = await readFile(target, "utf8")
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    })
    res.end(injectBridge(html, bridgeScript))
    return
  }
  res.writeHead(200, { "content-type": mime, "cache-control": "no-store" })
  res.end(await readFile(target))
}

/**
 * Inject the standalone bridge `<script>` immediately before `</head>` (the
 * placement the task spec calls for), falling back to the earliest structural
 * tag (`<head>`/`<body>`/`<html>`) and finally to prepending, so the bridge is
 * defined before any app script runs even in a fragment without a head.
 */
export function injectBridge(html: string, bridgeScript: string): string {
  const headClose = html.match(/<\/head>/i)
  if (headClose?.index !== undefined) {
    return (
      html.slice(0, headClose.index) + bridgeScript + html.slice(headClose.index)
    )
  }
  for (const tag of ["head", "body", "html"]) {
    const match = html.match(new RegExp(`<${tag}[^>]*>`, "i"))
    if (match?.index !== undefined) {
      const insertAt = match.index + match[0].length
      return html.slice(0, insertAt) + bridgeScript + html.slice(insertAt)
    }
  }
  return bridgeScript + html
}

/** The standalone bridge injected into served index.html. */
export function buildBridgeScript(route: string): string {
  // eslint-disable-next-line quotes
  return `<script>
(function () {
  if (window.McpApp) return;
  var ROUTE = ${JSON.stringify(route)};
  window.McpApp = {
    connect: function () {
      return Promise.resolve({
        callTool: function (name, args) {
          return fetch(ROUTE, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: name, args: args || {} })
          }).then(function (res) {
            return res.json().catch(function () {
              throw new Error("tool-call failed: HTTP " + res.status);
            }).then(function (body) {
              if (!res.ok) throw new Error((body && body.error) || ("tool-call failed: HTTP " + res.status));
              return body;
            });
          });
        },
        updateModelContext: function () {
          return Promise.resolve({});
        },
        openLink: function (url) {
          window.open(url, "_blank");
          return Promise.resolve({});
        },
        onTeardown: function (cb) {
          window.addEventListener("beforeunload", cb);
        }
      });
    }
  };
})();
</script>
`
}

/**
 * Permissive CORS for this local serve host — mirrors the shape of the
 * daemon's own `applyCors` (`packages/runtime/src/http-server.ts`) minus its
 * origin allowlist/credentials branch, which exists there to protect
 * session state this host doesn't carry.
 */
export function applyCors(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader(
    "Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] ?? "content-type",
  )
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
}

/** `agentproto app serve <appDir> [--port <n>] [--host <addr>] [--json]`. */
export async function runAppServe(args: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: false,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      app: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  })

  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  const appDirArg = positionals[0] ?? "."
  let appDir = resolve(process.cwd(), expandHome(appDirArg))

  // --app <appId> overrides the positional dir — resolve from the installed-app
  // registry instead. This lets users `app install` once then `app serve --app`.
  const appId = values.app as string | undefined
  if (appId !== undefined && appId.length > 0) {
    const resolved = findInstalledAppDir(appId)
    if (!resolved) {
      process.stderr.write(
        `agentproto app serve: no installed app with id '${appId}'.\n` +
          `  Install it first: agentproto app install <dir>\n` +
          `  Or list installed apps: agentproto app list\n`,
      )
      return 2
    }
    appDir = resolved
  }

  const listenHost = resolveListenHost(values.host as string | undefined)
  if (values.host !== undefined) {
    process.stderr.write(
      `agentproto app serve: warning: --host ${listenHost} exposes the ` +
        `tool-call bridge beyond loopback. Make sure this is intentional.\n`,
    )
  }

  // 1. Require a valid .agentproto/APP.md + .agentproto/ui/
  const appMdPath = join(appDir, ".agentproto", "APP.md")
  const uiRoot = join(appDir, ".agentproto", "ui")
  if (!(await pathExists(appMdPath))) {
    process.stderr.write(
      `agentproto app serve: ${appDir} is not an agentproto app ` +
        `(missing ${appMdPath}).\n${USAGE}\n`,
    )
    return 2
  }
  if (!(await pathExists(uiRoot))) {
    process.stderr.write(
      `agentproto app serve: ${appDir} has no UI to serve ` +
        `(missing ${uiRoot}).\n${USAGE}\n`,
    )
    return 2
  }

  // 2. Port resolution: explicit --port > declared ui.port > auto-assign.
  let explicitPort: number | undefined
  let declaredPort: number | undefined
  if (typeof values.port === "string" && values.port.length > 0) {
    const p = Number(values.port)
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      process.stderr.write(
        `agentproto app serve: invalid --port '${values.port}' (must be 1–65535).\n`,
      )
      return 2
    }
    explicitPort = p
  } else {
    declaredPort = await readDeclaredUIPort(appDir)
  }

  // 3. The daemon MCP client — connected once, reused across calls.
  const daemonMcpUrl = await resolveDaemonMcpUrl()
  const getClient = createDaemonMcpClientGetter(daemonMcpUrl, "agentproto-app-serve")

  // Read the app's ui.tools allowlist. When declared (even empty), only those
  // tools are forwarded; when absent, all tools are permitted (the loopback
  // bind already limits exposure to the local machine).
  const allowedTools = await readDeclaredUITools(appDir)

  const bridgeScript = buildBridgeScript(TOOL_CALL_PATH)
  const runJson = values.json === true

  // 4. Build the HTTP server.
  const server = createServer((req, res) => {
    // CORS `*` lets a page from a different origin (e.g. file:// or a Vite
    // dev port) reach the tool-call bridge — without it the browser blocks
    // the cross-origin fetch. The safety gate is NOT "no session credentials":
    // tools like command_execute need no cookie to be dangerous. Safety here
    // comes from the loopback-only default bind and the ui.tools allowlist.
    applyCors(req, res)
    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }

    const urlPath = (req.url ?? "/").split("?")[0] ?? "/"
    if (req.method === "POST" && urlPath === TOOL_CALL_PATH) {
      handleToolCallRequest(req, res, getClient, allowedTools)
      return
    }
    if (urlPath === UPLOAD_PATH) {
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "method_not_allowed" }))
        return
      }
      void handleUpload(req, res, appDir)
      return
    }
    void serveStatic(uiRoot, req.url ?? "/", bridgeScript, res)
  })

  // 5. Bind. Resolves once listening; rejects on a non-EADDRINUSE error.
  const bind = (port: number): Promise<{ port: number } | { inUse: boolean }> =>
    new Promise((resPromise, rejPromise) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") resPromise({ inUse: true })
        else rejPromise(err)
      }
      server.once("error", onError)
      server.listen(port, listenHost, () => {
        server.off("error", onError)
        const addr = server.address()
        resPromise({ port: addr && typeof addr === "object" ? addr.port : port })
      })
    })

  // Port resolution order: explicit --port > declared ui.port > auto (0).
  if (explicitPort !== undefined) {
    const got = await bind(explicitPort)
    if ("inUse" in got) {
      process.stderr.write(
        `agentproto app serve: port ${explicitPort} is already in use.\n`,
      )
      return 1
    }
    return reportListening(got.port, runJson, appDir, daemonMcpUrl)
  }
  if (declaredPort !== undefined) {
    const got = await bind(declaredPort)
    if ("inUse" in got) {
      // A declared ui.port is a hint — fall back to auto-assign rather than
      // failing the whole serve.
      process.stderr.write(
        `agentproto app serve: port ${declaredPort} is in use, ` +
          `falling back to a free port.\n`,
      )
      const auto = await bind(0)
      return "inUse" in auto
        ? 1
        : reportListening(auto.port, runJson, appDir, daemonMcpUrl)
    }
    return reportListening(got.port, runJson, appDir, daemonMcpUrl)
  }
  const auto = await bind(0)
  return "inUse" in auto
    ? 1
    : reportListening(auto.port, runJson, appDir, daemonMcpUrl)
}

function reportListening(
  port: number,
  runJson: boolean,
  appDir: string,
  daemonMcpUrl: string,
): number {
  const url = `http://127.0.0.1:${port}/`
  if (runJson) {
    process.stdout.write(JSON.stringify({ url, appDir, daemonMcpUrl }) + "\n")
  } else {
    process.stdout.write(
      `agentproto app: serving ${appDir} at ${url}\n` +
        `  MCP bridge -> ${daemonMcpUrl}\n` +
        `  (Ctrl-C to stop)\n`,
    )
  }
  return 0
}