import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  AppCatalogEntrySchema,
  DEFAULT_CATALOG_SOURCE_URL,
  catalogCachePath,
  compareCatalogVersions,
  createRemoteCatalogClient,
  isCatalogUpdate,
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

  it("writes a disk cache on success and serves it, marked stale, when the source later fails", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "catalog-cache-"))
    try {
      route("/c", [gitEntry("c1")])
      const first = await createRemoteCatalogClient({ cacheDir }).fetchSources([{ url: `${base}/c` }])
      expect(first.bySource[0]).toMatchObject({ url: `${base}/c`, ok: true, stale: false })
      expect(existsSync(catalogCachePath(cacheDir, `${base}/c`))).toBe(true)

      routes["/c"] = { status: 500, hits: 0 }
      const second = await createRemoteCatalogClient({ cacheDir }).fetchSources([{ url: `${base}/c` }])
      expect(second.entries.map(e => e.appId)).toEqual(["c1"])
      expect(second.bySource[0]).toMatchObject({ ok: true, stale: true })
      expect(second.warnings[0]).toContain("using the copy cached at")

      const never = await createRemoteCatalogClient({ cacheDir }).fetchSources([{ url: `${base}/never` }])
      expect(never.bySource[0]).toMatchObject({ ok: false, stale: false })
      expect(never.entries).toEqual([])
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  it("keeps app-catalog/v1 fields and warns (but still reads) an unknown schema", async () => {
    const v1Entry = {
      appId: "@agentik/demo",
      name: "Demo",
      version: "0.2.0",
      tier: "bundle",
      icon: "https://example.com/demo.svg",
      publisher: "agentik",
      license: { kind: "free" },
      minAgentprotoVersion: "0.40.0",
      requires: { browser: false, fs: false, secrets: [] },
      featured: true,
      source: { kind: "agentapp", url: "https://example.com/demo-0.2.0.agentapp", sha256: "a".repeat(64), version: "0.2.0", size: 1800000 },
    }
    routes["/v1"] = {
      body: JSON.stringify({ schema: "app-catalog/v1", generatedAt: "2026-10-02T00:00:00Z", entries: [v1Entry] }),
      hits: 0,
    }
    routes["/v9"] = { body: JSON.stringify({ schema: "app-catalog/v9", entries: [gitEntry("x")] }), hits: 0 }
    const client = createRemoteCatalogClient()
    const v1 = await client.fetchSources([{ url: `${base}/v1` }])
    expect(v1.warnings).toEqual([])
    expect(v1.entries[0]).toEqual(v1Entry)
    const v9 = await client.fetchSources([{ url: `${base}/v9` }])
    expect(v9.entries.map(e => e.appId)).toEqual(["x"])
    expect(v9.warnings[0]).toContain('unknown schema "app-catalog/v9"')
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

  it("default source first; config sources add to it and win over file sources", () => {
    const file = [{ url: "https://file" }]
    expect(resolveCatalogSources(file, { sources: [{ url: "https://cfg" }] })).toEqual([
      { url: DEFAULT_CATALOG_SOURCE_URL, origin: "default" },
      { url: "https://cfg", origin: "config" },
    ])
    expect(resolveCatalogSources(file, undefined)).toEqual([
      { url: DEFAULT_CATALOG_SOURCE_URL, origin: "default" },
      { url: "https://file", origin: "file" },
    ])
    expect(resolveCatalogSources(file, { defaultSource: false })).toEqual([{ url: "https://file", origin: "file" }])
    expect(resolveCatalogSources(undefined, { defaultSource: false })).toEqual([])
    expect(
      resolveCatalogSources(undefined, { defaultSource: "https://mine", sources: [{ url: "https://mine" }] }),
    ).toEqual([{ url: "https://mine", origin: "default" }])
  })

  it("the catalog example in docs/cli/guides/distribute-an-app.md §5 validates", async () => {
    const doc = await readFile(
      fileURLToPath(new URL("../../../../docs/cli/guides/distribute-an-app.md", import.meta.url)),
      "utf8",
    )
    const section = doc.slice(doc.indexOf("## 5."))
    const block = /```json\n([\s\S]*?)\n```/.exec(section)
    expect(block).not.toBeNull()
    const parsed = JSON.parse(block![1]!) as { schema?: string; entries: unknown[] }
    expect(parsed.schema).toBe("app-catalog/v1")
    expect(parsed.entries.length).toBeGreaterThan(0)
    for (const e of parsed.entries) expect(AppCatalogEntrySchema.safeParse(e).success).toBe(true)
  })
})

describe("catalog updates", () => {
  const bundle = (version: string, sha256: string) => ({
    appId: "@a/x",
    source: { kind: "agentapp" as const, url: `https://e/x-${version}.agentapp`, sha256, version },
  })
  it("compareCatalogVersions orders numerically and ranks pre-releases lower", () => {
    expect(compareCatalogVersions("1.2.10", "1.2.9")).toBe(1)
    expect(compareCatalogVersions("0.2.0", "0.3.0")).toBe(-1)
    expect(compareCatalogVersions("1.0.0-beta", "1.0.0")).toBe(-1)
    expect(compareCatalogVersions("1.0.0", "1.0.0")).toBe(0)
    expect(compareCatalogVersions("latest", "1.0.0")).toBeUndefined()
  })
  it("isCatalogUpdate: different digest + not-lower version, same source kind only", () => {
    const installed = { source: { kind: "agentapp" as const, url: "u", sha256: "aa", version: "0.2.0" } }
    expect(isCatalogUpdate(installed, bundle("0.3.0", "bb"))).toBe(true)
    expect(isCatalogUpdate(installed, bundle("0.2.0", "bb"))).toBe(true)
    expect(isCatalogUpdate(installed, bundle("0.2.0", "AA"))).toBe(false)
    expect(isCatalogUpdate(installed, bundle("0.1.0", "cc"))).toBe(false)
    expect(isCatalogUpdate({ source: { kind: "local" } }, bundle("9.9.9", "dd"))).toBe(false)
    expect(
      isCatalogUpdate(
        { source: { kind: "git", url: "g", sha: "s1" } },
        bundle("1.0.0", "ee"),
      ),
    ).toBe(false)
  })
})
