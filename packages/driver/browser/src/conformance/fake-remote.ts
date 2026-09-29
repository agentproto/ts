import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { defineBrowser } from "../define-browser.js"
import type { BrowserDriver, NetworkRequestSummary } from "../driver.js"
import type { BrowserInstance, BrowserProvider } from "../provider.js"

interface RemoteSession {
  id: string
  label: string
  open: boolean
  url: string
  requests: NetworkRequestSummary[]
}

export interface FakeRemoteBrowserServer {
  /** e.g. `http://127.0.0.1:41233` (random port). */
  baseUrl: string
  sessions: ReadonlyMap<string, RemoteSession>
  close(): Promise<void>
}

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString("utf8")
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

/** A local http server that behaves like a third-party browser service. Listens on a random loopback port. */
export async function startFakeRemoteBrowserServer(): Promise<FakeRemoteBrowserServer> {
  const sessions = new Map<string, RemoteSession>()
  const bootId = `boot-${Math.random().toString(36).slice(2, 10)}`
  let seq = 0

  const server: Server = createServer((req, res) => {
    void (async () => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" })
        res.end(JSON.stringify(body))
      }
      try {
        const url = new URL(req.url ?? "/", "http://fake")
        const parts = url.pathname.split("/").filter(Boolean)
        if (req.method === "GET" && url.pathname === "/health") {
          return send(200, { ok: true, bootId, browserState: "running" })
        }
        if (req.method === "POST" && url.pathname === "/sessions") {
          const body = await readJson(req)
          const label = typeof body.label === "string" ? body.label : "default"
          for (const s of sessions.values()) {
            if (s.label === label && s.open) return send(200, { id: s.id, existing: true })
          }
          seq += 1
          const session: RemoteSession = { id: `rs-${seq}`, label, open: true, url: "about:blank", requests: [] }
          sessions.set(session.id, session)
          return send(200, { id: session.id, existing: false })
        }
        const session = parts[0] === "sessions" ? sessions.get(parts[1] ?? "") : undefined
        if (!session) return send(404, { error: "no such session" })
        const action = parts[2]
        if (req.method === "DELETE" && !action) {
          session.open = false
          return send(200, { ok: true })
        }
        if (req.method === "GET" && !action) return send(200, { open: session.open })
        if (!session.open) return send(410, { error: "session closed" })
        if (action === "navigate") {
          const body = await readJson(req)
          session.url = String(body.url)
          session.requests.push({
            requestId: `q${session.requests.length + 1}`,
            url: session.url,
            method: "GET",
            status: 200,
            startedAt: session.requests.length + 1,
            hasResponseBody: false,
          })
          return send(200, { ok: true })
        }
        if (action === "evaluate") return send(200, { value: 2 })
        if (action === "dom") return send(200, { html: "<html><body>remote</body></html>" })
        if (action === "screenshot") return send(200, { base64: ONE_PIXEL_PNG })
        if (action === "requests") return send(200, { requests: session.requests })
        if (action === "cdp") return send(200, { result: { product: "FakeRemote/1.0" } })
        if (action === "click" || action === "fill") return send(200, { ok: true })
        return send(404, { error: "unknown route" })
      } catch (err) {
        send(500, { error: err instanceof Error ? err.message : String(err) })
      }
    })()
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    sessions,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

async function call<T>(baseUrl: string, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: init?.method ?? (init?.body === undefined ? "GET" : "POST"),
    ...(init?.body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }),
  })
  if (!res.ok) throw new Error(`remote ${path} answered ${res.status}`)
  return (await res.json()) as T
}

function remoteDriver(baseUrl: string, sessionId: string): BrowserDriver {
  const base = `/sessions/${sessionId}`
  let closed = false
  const driver: BrowserDriver = {
    kind: "fake-remote",
    capabilities: {
      canCaptureResponseBodies: false,
      canDispatchTrustedInput: false,
      canMultiTarget: false,
      canThrottleNetwork: false,
      isUserVisible: false,
      canScreencast: false,
      canRecordVideo: false,
      canStealth: false,
      canFullPageScreenshot: false,
      canAiActions: false,
    },
    target: { id: sessionId, url: "about:blank" },
    async navigate(options) {
      await call(baseUrl, `${base}/navigate`, { body: { url: options.url } })
      driver.target.url = options.url
    },
    async evaluate<T>(options: { expression: string }) {
      const r = await call<{ value: T }>(baseUrl, `${base}/evaluate`, { body: { expression: options.expression } })
      return { value: r.value, truncated: false }
    },
    async click(options) {
      await call(baseUrl, `${base}/click`, { body: { selector: options.selector } })
    },
    async fill(options) {
      await call(baseUrl, `${base}/fill`, { body: { selector: options.selector, value: options.value } })
    },
    async screenshot() {
      const r = await call<{ base64: string }>(baseUrl, `${base}/screenshot`, { body: {} })
      return { base64: r.base64, format: "png", width: 1, height: 1 }
    },
    async getDom() {
      return (await call<{ html: string }>(baseUrl, `${base}/dom`)).html
    },
    async listRequests() {
      return (await call<{ requests: NetworkRequestSummary[] }>(baseUrl, `${base}/requests`)).requests
    },
    async getRequestBody() {
      return { body: "", base64Encoded: false }
    },
    async send<TResult>(command: { method: string }) {
      const r = await call<{ result: TResult }>(baseUrl, `${base}/cdp`, { body: { method: command.method } })
      return r.result
    },
    onEvent() {
      return () => {}
    },
    async close() {
      closed = true
    },
    get closed() {
      return closed
    },
  }
  return driver
}

/**
 * A `location: "remote"` provider that talks to {@link startFakeRemoteBrowserServer}
 * over http. `launch` needs `baseUrl`; instances never report a local pid.
 */
export function createFakeRemoteBrowserProvider(id = "fake-remote"): BrowserProvider {
  return defineBrowser({
    id,
    name: "Fake remote browser",
    description: "Talks to a local fake http service to exercise remote-provider conformance.",
    version: "1.0.0",
    transport: "http",
    location: "remote",
    capabilities: { cdp: true, downloads: true, headless: true },
    async launch(opts) {
      const baseUrl = opts.baseUrl
      if (!baseUrl) throw new Error("fake-remote: launch needs baseUrl")
      const created = await call<{ id: string; existing: boolean }>(baseUrl, "/sessions", {
        body: { label: opts.label ?? "default" },
      })
      let stopped = false
      const instance: BrowserInstance = {
        id: `${id}:${created.id}`,
        endpoints: { rest: baseUrl },
        wasAlreadyRunning: created.existing,
        async health() {
          if (stopped) return { ok: false, reason: "stopped" }
          try {
            const [service, session] = await Promise.all([
              call<{ bootId: string; browserState: "running" }>(baseUrl, "/health"),
              call<{ open: boolean }>(baseUrl, `/sessions/${created.id}`),
            ])
            if (!session.open) return { ok: false, reason: "session closed" }
            return { ok: true, lifecycle: { bootId: service.bootId, browserState: service.browserState } }
          } catch (err) {
            return { ok: false, reason: err instanceof Error ? err.message : String(err) }
          }
        },
        async attach() {
          if (stopped) throw new Error("instance is stopped")
          return remoteDriver(baseUrl, created.id)
        },
        async stop() {
          if (stopped) return
          stopped = true
          await call(baseUrl, `/sessions/${created.id}`, { method: "DELETE" }).catch(() => {})
        },
      }
      return instance
    },
  })
}
