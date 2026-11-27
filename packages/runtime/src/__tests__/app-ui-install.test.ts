/**
 * Installable app UI (AIP-53 "Installable UI"): the derived web app manifest,
 * its icons, and the tags injected into the served page — over the real REST
 * layer, plus unit checks of the pure helpers.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createAppRegistry, type AppRegistry } from "../app-registry.js"
import {
  appBasePath,
  appleIconIndex,
  generatedIconSvg,
  injectIntoHead,
  installHeadTags,
  sniffIconType,
} from "../app-ui-install.js"

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)])
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>'
const HTML = "<!doctype html><html><head><title>T</title></head><body>marker</body></html>"

describe("pure helpers", () => {
  it("sniffs by content, not extension", () => {
    expect(sniffIconType(PNG)).toBe("image/png")
    expect(sniffIconType(Buffer.from(SVG))).toBe("image/svg+xml")
    expect(sniffIconType(Buffer.from("<html><script>alert(1)</script>"))).toBeUndefined()
  })

  it("appBasePath keeps the request prefix", () => {
    expect(appBasePath("/apps/@acme/demo/ui")).toBe("/apps/@acme/demo")
    expect(appBasePath("/apps/@acme/demo/ui/")).toBe("/apps/@acme/demo")
    expect(appBasePath("/d/abc/apps/@acme/demo/manifest.webmanifest")).toBe("/d/abc/apps/@acme/demo")
    expect(appBasePath("/apps/@acme/demo/icons/3")).toBe("/apps/@acme/demo")
    expect(appBasePath("/other")).toBeUndefined()
  })

  it("injects after <head>, leaves a document with its own manifest alone", () => {
    const app = { appId: "@acme/demo", dir: "/x", name: "Demo" }
    const tags = installHeadTags(HTML, app, "/apps/@acme/demo", 0)
    expect(tags).toContain('<link rel="manifest" href="/apps/@acme/demo/manifest.webmanifest">')
    expect(tags).toContain('<link rel="apple-touch-icon" href="/apps/@acme/demo/icons/0">')
    expect(injectIntoHead(HTML, tags)).toMatch(/<head><link rel="manifest"/)
    expect(installHeadTags('<head><link rel="manifest" href="m.json"></head>', app, "/apps/x", 0)).toBe("")
    expect(injectIntoHead("<p>x</p>", "<meta>")).toBe("<meta><p>x</p>")
  })

  it("picks the largest png for the apple icon", () => {
    expect(
      appleIconIndex([
        { path: "a.svg", sizes: "any" },
        { path: "b.png", sizes: "192x192" },
        { path: "c.png", sizes: "512x512" },
      ]),
    ).toBe(2)
    expect(appleIconIndex([])).toBeUndefined()
  })

  it("generated icon escapes the name and uses initials", () => {
    const svg = generatedIconSvg({ appId: "@a/b", dir: "/x", name: "<Zed> Chat" })
    expect(svg).not.toContain("<Zed>")
    expect(svg).toContain("&lt;C")
  })
})

describe("installable UI — REST routes", () => {
  let dir: string
  let registry: AppRegistry

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentproto-app-install-"))
    await mkdir(join(dir, "store"), { recursive: true })
    await writeFile(join(dir, "ui.html"), HTML, "utf8")
    await writeFile(join(dir, "store", "icon512.png"), PNG)
    await writeFile(join(dir, "store", "icon.svg"), SVG)
    await writeFile(join(dir, "fake.png"), "<html><script>alert(1)</script></html>")
    await writeFile(join(dir, "..", `${dir.split("/").pop()}-secret.png`), PNG)
    registry = createAppRegistry()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(`${dir}-secret.png`, { force: true })
  })

  function install(appId: string, ui: Record<string, unknown>, name = "Demo App"): void {
    registry.upsertApp({
      appId,
      dir,
      name,
      agents: [],
      workflows: [],
      unvalidatedAgentTools: [],
      ui: { path: join(dir, "ui.html"), ...ui },
    })
  }

  async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = createServer()
      srv.once("error", reject)
      srv.listen(0, "127.0.0.1", () => {
        const p = (srv.address() as AddressInfo).port
        srv.close(() => resolve(p))
      })
    })
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
      conversations: {
        async open() {},
        async appendTurn() {},
        async read() {
          return { meta: {} as never, turns: [] }
        },
        async list() {
          return []
        },
        pathFor: (id: string) => id,
      },
      events: createRuntimeEvents(),
      heartbeat: { start() {}, stop() {}, async fireNow() {} },
      meta: { workspace: process.cwd(), registered: [] },
      appRegistry: registry,
    })
    try {
      await fn(`http://127.0.0.1:${port}`)
    } finally {
      await http.stop()
    }
  }

  it("serves a manifest derived from the app, and links it from the page", async () => {
    install("@acme/demo", {
      title: "Demo UI",
      install: {
        shortName: "Demo",
        themeColor: "#123456",
        icons: [
          { path: "store/icon.svg", sizes: "any" },
          { path: "store/icon512.png", sizes: "512x512", purpose: "maskable" },
        ],
      },
    })
    await withServer(async base => {
      const res = await fetch(`${base}/apps/@acme/demo/manifest.webmanifest`)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("application/manifest+json")
      const m = (await res.json()) as Record<string, unknown> & { icons: Array<Record<string, string>> }
      expect(m).toMatchObject({
        name: "Demo App",
        short_name: "Demo",
        start_url: "/apps/@acme/demo/ui",
        scope: "/apps/@acme/demo/",
        display: "standalone",
        theme_color: "#123456",
        background_color: "#123456",
      })
      expect(m.icons).toEqual([
        { src: "/apps/@acme/demo/icons/0", sizes: "any", type: "image/svg+xml" },
        { src: "/apps/@acme/demo/icons/1", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ])
      const png = await fetch(`${base}/apps/@acme/demo/icons/1`)
      expect(png.headers.get("content-type")).toBe("image/png")
      expect(Buffer.from(await png.arrayBuffer()).equals(PNG)).toBe(true)

      const page = await (await fetch(`${base}/apps/@acme/demo/ui`)).text()
      expect(page).toContain('<link rel="manifest" href="/apps/@acme/demo/manifest.webmanifest">')
      expect(page).toContain('<meta name="theme-color" content="#123456">')
      expect(page).toContain('<link rel="apple-touch-icon" href="/apps/@acme/demo/icons/1">')
      expect(page).toContain("marker")
      // The trailing-slash spelling a basepath SPA reloads at gets the same absolute links.
      expect(await (await fetch(`${base}/apps/@acme/demo/ui/`)).text()).toContain(
        'href="/apps/@acme/demo/manifest.webmanifest"',
      )
    })
  })

  it("falls back to store.icon, then to a generated icon", async () => {
    install("@acme/store-icon", {})
    await mkdir(join(dir, ".agentproto"), { recursive: true })
    await writeFile(join(dir, ".agentproto", "APP.md"), "---\nschema: app/v1\nstore:\n  icon: store/icon.svg\n---\n")
    install("@acme/generated", {}, "Plain")
    await withServer(async base => {
      const a = (await (await fetch(`${base}/apps/@acme/store-icon/manifest.webmanifest`)).json()) as { icons: Array<{ type: string }> }
      expect(a.icons).toHaveLength(1)
      expect((await fetch(`${base}/apps/@acme/store-icon/icons/0`)).headers.get("content-type")).toBe("image/svg+xml")
    })
    // Remove the APP.md so the second app has no store icon.
    await rm(join(dir, ".agentproto"), { recursive: true })
    await withServer(async base => {
      const m = (await (await fetch(`${base}/apps/@acme/generated/manifest.webmanifest`)).json()) as {
        name: string
        icons: Array<{ type: string; sizes: string }>
      }
      expect(m.name).toBe("Plain")
      expect(m.icons).toEqual([{ src: "/apps/@acme/generated/icons/0", sizes: "any", type: "image/svg+xml" }])
      const svg = await (await fetch(`${base}/apps/@acme/generated/icons/0`)).text()
      expect(svg).toContain("<svg")
      expect(svg).toContain(">PL<")
    })
  })

  it("never serves an icon that is not an image or leaves the app dir", async () => {
    await symlink(`${dir}-secret.png`, join(dir, "link.png"))
    install("@acme/bad", {
      install: {
        icons: [{ path: "fake.png" }, { path: "link.png" }, { path: "missing.png" }, { path: "store/icon512.png", sizes: "512x512" }],
      },
    })
    await withServer(async base => {
      const m = (await (await fetch(`${base}/apps/@acme/bad/manifest.webmanifest`)).json()) as { icons: Array<{ src: string }> }
      // Only the good one is advertised.
      expect(m.icons.map(i => i.src)).toEqual(["/apps/@acme/bad/icons/3"])
      for (const n of [0, 1, 2]) expect((await fetch(`${base}/apps/@acme/bad/icons/${n}`)).status).toBe(404)
      expect((await fetch(`${base}/apps/@acme/bad/icons/9`)).status).toBe(404)
    })
  })

  it("404s for an unknown app and leaves a document's own manifest link alone", async () => {
    await writeFile(join(dir, "ui.html"), '<html><head><link rel="manifest" href="own.json"></head><body>x</body></html>')
    install("@acme/own", {})
    await withServer(async base => {
      expect((await fetch(`${base}/apps/@acme/none/manifest.webmanifest`)).status).toBe(404)
      expect((await fetch(`${base}/apps/@acme/none/icons/0`)).status).toBe(404)
      const page = await (await fetch(`${base}/apps/@acme/own/ui`)).text()
      expect(page.match(/rel="manifest"/g)).toHaveLength(1)
      expect(page).not.toContain("apple-touch-icon")
    })
  })
})
