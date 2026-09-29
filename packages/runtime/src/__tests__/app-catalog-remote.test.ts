import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createRemoteCatalogClient,
  loadAppCatalogFile,
  resolveCatalogSources,
} from "../app-catalog.js"

const gitEntry = (appId: string, name?: string) => ({
  appId,
  ...(name ? { name } : {}),
  source: { kind: "git", url: `https://example.com/${appId}.git`, sha: "deadbeef" },
})

describe("remote app catalog client", () => {
  let srv: Server
  let base: string
  let routes: Record<string, { status?: number; body?: string; delayMs?: number; hits: number }>
  beforeEach(async () => {
    routes = {}
    srv = createServer((req, res) => {
      const route = routes[req.url ?? ""]
      if (!route) {
        res.statusCode = 404
        res.end()
        return
      }
      route.hits++
      expect(req.headers.accept).toBe("application/json")
      setTimeout(() => {
        res.statusCode = route.status ?? 200
        res.setHeader("content-type", "application/json")
        res.end(route.body ?? "{}")
      }, route.delayMs ?? 0)
    })
    await new Promise<void>(r => srv.listen(0, "127.0.0.1", r))
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    srv.closeAllConnections()
    await new Promise(r => srv.close(r))
  })

  const route = (path: string, entries: unknown[]) => {
    routes[path] = { body: JSON.stringify({ entries }), hits: 0 }
  }

  it("merges sources in order and reports invalid entries as warnings", async () => {
    route("/a", [gitEntry("a1"), { appId: "bad" }])
    route("/b", [gitEntry("b1", "B one")])
    const client = createRemoteCatalogClient()
    const res = await client.fetchSources([{ url: `${base}/a` }, { url: `${base}/b` }])
    expect(res.entries.map(e => e.appId)).toEqual(["a1", "b1"])
    expect(res.entries[1]!.name).toBe("B one")
    expect(res.warnings).toHaveLength(1)
    expect(res.warnings[0]).toContain("entries[1] invalid")
  })

  it("caches within the TTL, refetches after it, and refresh bypasses", async () => {
    route("/a", [gitEntry("a1")])
    let t = 1_000
    const client = createRemoteCatalogClient({ ttlMs: 5 * 60_000, now: () => t })
    const src = [{ url: `${base}/a` }]
    await client.fetchSources(src)
    t += 60_000
    await client.fetchSources(src)
    expect(routes["/a"]!.hits).toBe(1)
    await client.fetchSources(src, { refresh: true })
    expect(routes["/a"]!.hits).toBe(2)
    t += 5 * 60_000 + 1
    await client.fetchSources(src)
    expect(routes["/a"]!.hits).toBe(3)
  })

  it("turns bad JSON, wrong shape, HTTP errors and unreachable hosts into warnings", async () => {
    routes["/badjson"] = { body: "{nope", hits: 0 }
    routes["/shape"] = { body: JSON.stringify({ apps: [] }), hits: 0 }
    routes["/500"] = { status: 500, hits: 0 }
    route("/ok", [gitEntry("ok")])
    const client = createRemoteCatalogClient()
    const res = await client.fetchSources(
      ["/badjson", "/shape", "/500", "/ok"].map(p => ({ url: `${base}${p}` })).concat([{ url: "http://127.0.0.1:1/x" }]),
    )
    expect(res.entries.map(e => e.appId)).toEqual(["ok"])
    expect(res.warnings).toHaveLength(4)
    expect(res.warnings.join("\n")).toContain("HTTP 500")
    expect(res.warnings.join("\n")).toContain("expected { entries")
  })

  it("times out a slow source with a warning and does not cache failures", async () => {
    routes["/slow"] = { body: JSON.stringify({ entries: [gitEntry("s")] }), delayMs: 400, hits: 0 }
    const client = createRemoteCatalogClient({ timeoutMs: 50 })
    const res = await client.fetchSources([{ url: `${base}/slow` }])
    expect(res.entries).toEqual([])
    expect(res.warnings[0]).toContain("timed out after 50ms")
    routes["/slow"]!.delayMs = 0
    const again = await client.fetchSources([{ url: `${base}/slow` }])
    expect(again.entries.map(e => e.appId)).toEqual(["s"])
  })
})

describe("catalog file sources + precedence", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "app-catalog-sources-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("reads valid sources and drops malformed ones", async () => {
    const p = join(dir, "c.json")
    await writeFile(p, JSON.stringify({ sources: [{ url: "https://a" }, { url: 3 }, "x"] }))
    const cat = await loadAppCatalogFile(p)
    expect(cat.apps).toEqual([])
    expect(cat.sources).toEqual([{ url: "https://a" }])
  })

  it("config sources win over file sources when set", () => {
    const file = [{ url: "https://file" }]
    expect(resolveCatalogSources(file, [{ url: "https://cfg" }])).toEqual([{ url: "https://cfg" }])
    expect(resolveCatalogSources(file, undefined)).toEqual(file)
    expect(resolveCatalogSources(undefined, undefined)).toEqual([])
  })
})
