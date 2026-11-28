import {
  type BrowserPage,
  type BrowserTransport,
  type Clock,
  type Connector,
  type FetchedRaw,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
  type ParseResult,
  defineConnector,
} from "../index"

export const enc = (v: unknown): Uint8Array => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v))

export interface FakePost {
  id: string
  url: string
  text: string
  views?: number
}
export interface FakePage {
  posts: FakePost[]
  /** Task ids to queue after this page. */
  next?: string[]
}

/** In-memory "web": url to a page, a status, or a custom handler. */
export interface FakeHttp extends HttpTransport {
  calls: HttpRequest[]
  maxConcurrent: number
  respond: Map<string, (req: HttpRequest) => HttpResponse | Promise<HttpResponse>>
}

export function page(p: FakePage, status = 200, url?: string): (r: HttpRequest) => HttpResponse {
  return (r) => ({ status, headers: {}, body: status === 200 ? enc(p) : enc("denied"), url: url ?? r.url })
}

export function fakeHttp(delayMs = 0, onCall?: (n: number) => void): FakeHttp {
  let active = 0
  const t: FakeHttp = {
    calls: [],
    maxConcurrent: 0,
    respond: new Map(),
    async request(req) {
      t.calls.push(req)
      onCall?.(t.calls.length)
      active++
      t.maxConcurrent = Math.max(t.maxConcurrent, active)
      try {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
        const h = t.respond.get(req.url)
        if (!h) return { status: 404, headers: {}, body: enc("nope"), url: req.url }
        return await h(req)
      } finally {
        active--
      }
    },
  }
  return t
}

export interface FakeBrowser extends BrowserTransport {
  opened: string[]
  maxConcurrent: number
  respond: Map<string, FakePage>
}

export function fakeBrowser(delayMs = 0): FakeBrowser {
  let active = 0
  let n = 0
  const t: FakeBrowser = {
    opened: [],
    maxConcurrent: 0,
    respond: new Map(),
    async open(url) {
      t.opened.push(url)
      return { id: `p${n++}`, url }
    },
    async evaluate<T>(p: BrowserPage) {
      active++
      t.maxConcurrent = Math.max(t.maxConcurrent, active)
      try {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
        return (t.respond.get(p.url ?? "") ?? { posts: [] }) as T
      } finally {
        active--
      }
    },
    async fetchInPage() {
      throw new Error("not used")
    },
    async scroll() {},
    async waitFor() {},
    async close() {},
  }
  return t
}

export interface FakeClock extends Clock {
  t: number
  sleeps: number[]
}
export function fakeClock(start = Date.parse("2026-11-28T10:00:00Z")): FakeClock {
  const c: FakeClock = {
    t: start,
    sleeps: [],
    now: () => c.t,
    async sleep(ms) {
      c.sleeps.push(ms)
      c.t += ms
    },
  }
  return c
}

export interface FakeOptions {
  id?: string
  transports?: Array<"api" | "http" | "browser">
  /** Task ids planned for the recipe. */
  tasks?: string[]
  /** Host and path: task id `p1` fetches `https://<host>/<id>`. */
  host?: string
  paceMs?: number
  maxTasksPerRun?: number
  access?: { level: "none" } | { level: "key"; secret: string }
  counters?: boolean
  parse?: (raw: { bytes: Uint8Array }) => ParseResult
}

/** A connector whose pages are JSON `FakePage`s fetched by url. */
export function fakeConnector(o: FakeOptions = {}): Connector {
  const id = o.id ?? "fake"
  const host = o.host ?? `${id}.example.com`
  const tasks = o.tasks ?? ["a"]
  return defineConnector({
    id,
    version: "1",
    transports: o.transports ?? ["http"],
    access: o.access ?? { level: "none" },
    capabilities: ["list"],
    counters: o.counters === false ? [] : [{ name: "views", unit: "count", scope: "root", primary: true }],
    pace: { delayMs: o.paceMs ?? 0, maxTasksPerRun: o.maxTasksPerRun },
    plan: () => tasks.map((t) => ({ id: t, params: { url: `https://${host}/${t}` } })),
    async fetch(task, transport) {
      const url = String(task.params.url ?? `https://${host}/${task.id}`)
      if (transport.name === "browser") {
        const pg = await transport.browser.open(url)
        try {
          const data = await transport.browser.evaluate<FakePage>(pg, "document")
          return finish(url, data, 200)
        } finally {
          await transport.browser.close(pg)
        }
      }
      const res = await transport.http.request({ url })
      let body: FakePage | undefined
      try {
        body = res.status === 200 && res.body.length ? (JSON.parse(new TextDecoder().decode(res.body)) as FakePage) : undefined
      } catch {
        body = undefined
      }
      return finish(res.url, body, res.status, res.body)
    },
    parse: (input) =>
      o.parse
        ? o.parse(input.raw)
        : (() => {
            const data = JSON.parse(new TextDecoder().decode(input.raw.bytes)) as FakePage
            return {
              items: data.posts.map((p) => ({
                id: `${id}:${p.id}`,
                source: id,
                kind: "post" as const,
                url: p.url,
                text: p.text,
                postedAt: "2026-11-01",
                authorRef: `${id}:author`,
                subjects: [{ label: "topic", provenance: "query" as const }],
              })),
              observations: data.posts.map((p) => ({
                itemId: `${id}:${p.id}`,
                metrics: p.views === undefined ? {} : { views: p.views },
              })),
              actors: [{ ref: `${id}:author`, audience: [] }],
            }
          })(),
  })

  function finish(url: string, data: FakePage | undefined, status: number, body?: Uint8Array) {
    const raws: FetchedRaw[] = [{ url, ext: "json", bytes: body ?? enc(data ?? ""), httpStatus: status }]
    return { raws, tasks: data?.next?.map((n) => ({ id: n, params: { url: `https://${host}/${n}` } })) }
  }
}

export const recipeOf = (connectors: string[], workers = 8) => ({
  sources: connectors.map((c) => ({ connector: c, queries: [] })),
  workers,
})
