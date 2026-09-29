import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { runInNewContext } from "node:vm"

export type FakeHealthMode = "ok" | "idle" | "launching" | "crash-looping"

export interface FakeCamofoxOptions {
  /** When set, every route except `/health` needs `Authorization: Bearer <key>`. */
  apiKey?: string
  health?: FakeHealthMode
}

export interface FakeRequest {
  method: string
  path: string
  authorization: string | undefined
}

export interface FakeCamofoxServer {
  baseUrl: string
  port: number
  requests: FakeRequest[]
  tabs: Map<string, { url: string; open: boolean }>
  setHealth(mode: FakeHealthMode): void
  close(): Promise<void>
}

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
)

const FAKE_PAGE = {
  documentElement: { outerHTML: "<html><body><h1>fake camofox page</h1></body></html>" },
  querySelector: (): null => null,
}

function healthBody(mode: FakeHealthMode): { status: number; body: Record<string, unknown> } {
  const base = {
    engine: "camoufox",
    bootId: "boot-fake-1",
    startedAt: "2026-09-29T08:00:00.000Z",
    launchBudgetMs: 60_000,
  }
  switch (mode) {
    case "ok":
      return {
        status: 200,
        body: { ...base, ok: true, browserState: "running", launchedAt: "2026-09-29T08:00:05.000Z", lastLaunchMs: 5000 },
      }
    case "idle":
      return { status: 200, body: { ...base, ok: true, browserState: "idle", launchedAt: null, lastLaunchMs: null } }
    case "launching":
      return { status: 503, body: { ...base, ok: false, browserState: "launching", launchedAt: null } }
    case "crash-looping":
      return {
        status: 503,
        body: {
          ...base,
          ok: false,
          browserState: "crash-looping",
          consecutiveLaunchFailures: 4,
          lastRestartReason: "launch-timeout",
        },
      }
  }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString("utf8")
  if (!text) return {}
  const parsed: unknown = JSON.parse(text)
  return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

/** A camofox REST server on a random free loopback port. Never talks to the real :9377. */
export async function startFakeCamofoxServer(options: FakeCamofoxOptions = {}): Promise<FakeCamofoxServer> {
  let mode: FakeHealthMode = options.health ?? "ok"
  let nextTab = 1
  const requests: FakeRequest[] = []
  const tabs = new Map<string, { url: string; open: boolean }>()

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => send(res, 500, { error: String(err) }))
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake")
    const method = req.method ?? "GET"
    requests.push({ method, path: url.pathname, authorization: req.headers.authorization })

    if (url.pathname === "/health") {
      const h = healthBody(mode)
      return send(res, h.status, h.body)
    }
    if (options.apiKey && req.headers.authorization !== `Bearer ${options.apiKey}`) {
      return send(res, 401, { error: "unauthorized" })
    }

    if (method === "POST" && url.pathname === "/start") {
      mode = "ok"
      return send(res, 200, { ok: true })
    }
    if (method === "POST" && url.pathname === "/tabs") {
      if (mode === "crash-looping") return send(res, 503, { error: "browser_crash_looping" })
      await readBody(req)
      const tabId = `tab-${nextTab++}`
      tabs.set(tabId, { url: "about:blank", open: true })
      return send(res, 200, { tabId, url: "about:blank", keepAlive: false })
    }
    if (method === "GET" && url.pathname === "/tabs") {
      const list = [...tabs.entries()]
        .filter(([, t]) => t.open)
        .map(([tabId, t]) => ({ tabId, url: t.url, title: "fake" }))
      return send(res, 200, { tabs: list })
    }
    if (method === "GET" && url.pathname === "/sessions") return send(res, 200, { sessions: [] })

    const tabRoute = /^\/tabs\/([^/]+)(?:\/([a-z]+))?$/.exec(url.pathname)
    if (tabRoute) {
      const tabId = tabRoute[1] as string
      const action = tabRoute[2]
      const tab = tabs.get(tabId)
      if (!tab?.open) return send(res, 404, { error: "tab not found" })
      if (method === "DELETE" && !action) {
        tab.open = false
        return send(res, 200, { ok: true })
      }
      if (method === "GET" && action === "screenshot") {
        res.writeHead(200, { "content-type": "image/png" })
        return void res.end(PNG_1X1)
      }
      if (method === "POST") {
        const body = await readBody(req)
        if (action === "navigate") {
          tab.url = String(body["url"] ?? tab.url)
          return send(res, 200, { ok: true, url: tab.url })
        }
        if (action === "evaluate") {
          try {
            const result: unknown = runInNewContext(String(body["expression"]), { document: FAKE_PAGE, window: {} })
            return send(res, 200, { result })
          } catch (err) {
            return send(res, 200, { error: String(err) })
          }
        }
        if (action === "click" || action === "type") return send(res, 200, { ok: true })
      }
    }
    return send(res, 404, { error: `no route ${method} ${url.pathname}` })
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests,
    tabs,
    setHealth: (next) => {
      mode = next
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
