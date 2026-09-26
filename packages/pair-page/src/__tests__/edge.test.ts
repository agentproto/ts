import { describe, expect, it } from "vitest"
import {
  cacheControl,
  classifyHost,
  contentSecurityPolicy,
  handleRequest,
  isAppRoute,
  parsePreviewHosts,
  securityHeaders,
  type EdgeEnv,
} from "../edge"

const FP = "ae5be03faa146dd7"
const prod = { pairDomain: "agentproto.cloud", previewHosts: [] as string[] }

describe("classifyHost", () => {
  it("accepts <fingerprint>.agentproto.cloud as that daemon's origin", () => {
    expect(classifyHost(`${FP}.agentproto.cloud`, prod)).toEqual({ kind: "daemon", fingerprint: FP, loopback: false })
    // Hostnames are case-insensitive; URL.hostname is already lowercase, but a
    // raw Host header may not be.
    expect(classifyHost(`${FP.toUpperCase()}.AgentProto.Cloud`, prod)).toMatchObject({ kind: "daemon", fingerprint: FP })
    expect(classifyHost(`${FP}.agentproto.cloud.`, prod)).toMatchObject({ kind: "daemon" })
  })

  it("rejects the apex, non-fingerprint labels, deeper names and other domains", () => {
    for (const host of [
      "agentproto.cloud",
      "www.agentproto.cloud",
      "ae5be03faa146dd.agentproto.cloud", // 15 hex
      "ae5be03faa146dd70.agentproto.cloud", // 17 hex
      "ae5be03faa146ddz.agentproto.cloud", // not hex
      `x.${FP}.agentproto.cloud`,
      `${FP}.x.agentproto.cloud`,
      `${FP}.agentproto.cloud.evil.com`,
      `${FP}agentproto.cloud`,
      "agentproto-pair-page.example.workers.dev",
      "localhost",
      "127.0.0.1",
    ]) {
      expect(classifyHost(host, prod), host).toEqual({ kind: "reject" })
    }
  })

  it("serves extra hosts only when listed in PREVIEW_HOSTS", () => {
    const opts = { ...prod, previewHosts: parsePreviewHosts(" agentproto-pair-page.example.workers.dev , Localhost ") }
    expect(classifyHost("agentproto-pair-page.example.workers.dev", opts)).toEqual({ kind: "preview", loopback: false })
    expect(classifyHost("localhost", opts)).toEqual({ kind: "preview", loopback: true })
    expect(classifyHost("other.workers.dev", opts)).toEqual({ kind: "reject" })
    expect(parsePreviewHosts(undefined)).toEqual([])
    expect(parsePreviewHosts("")).toEqual([])
  })

  it("treats <fingerprint>.localhost as a daemon origin under a local pair domain", () => {
    expect(classifyHost(`${FP}.localhost`, { pairDomain: "localhost", previewHosts: [] })).toEqual({
      kind: "daemon",
      fingerprint: FP,
      loopback: true,
    })
  })
})

describe("security headers", () => {
  it("sends the strict CSP, without loopback ws:, on a production daemon origin", () => {
    const h = securityHeaders({ kind: "daemon", fingerprint: FP, loopback: false })
    expect(h["Content-Security-Policy"]).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' wss:; " +
        "worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    )
    expect(h).toMatchObject({
      "Cross-Origin-Opener-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    })
    expect(h["Permissions-Policy"]).toContain("camera=()")
    expect(h["Content-Security-Policy"]).not.toContain("unsafe")
  })

  it("allows ws: to loopback only for preview and loopback hosts", () => {
    expect(securityHeaders({ kind: "preview", loopback: false })["Content-Security-Policy"]).toContain(
      "connect-src 'self' wss: ws://127.0.0.1:* ws://localhost:*",
    )
    expect(securityHeaders({ kind: "daemon", fingerprint: FP, loopback: true })["Content-Security-Policy"]).toContain(
      "ws://127.0.0.1:*",
    )
    expect(contentSecurityPolicy({ loopbackWs: false })).not.toContain("ws://")
  })
})

describe("routes and caching", () => {
  it("serves the document for /, /pair and /d/*", () => {
    for (const p of ["/", "/pair", "/pair/", `/d/${FP}`, `/d/${FP}/apps/x/ui/`]) expect(isAppRoute(p), p).toBe(true)
    for (const p of ["/pair-sw.js", "/assets/app-X.js", "/manifest.webmanifest", "/d"]) expect(isAppRoute(p), p).toBe(false)
  })

  it("never caches the worker script or the document, caches hashed assets forever", () => {
    expect(cacheControl("/pair-sw.js", 200)).toBe("no-cache")
    expect(cacheControl("/pair", 200)).toBe("no-cache")
    expect(cacheControl(`/d/${FP}`, 200)).toBe("no-cache")
    expect(cacheControl("/assets/app-ABC123.js", 200)).toBe("public, max-age=31536000, immutable")
    expect(cacheControl("/icon-192.png", 200)).toBe("public, max-age=86400")
    expect(cacheControl("/nope", 404)).toBe("no-store")
  })
})

describe("handleRequest", () => {
  const files: Record<string, [string, string]> = {
    "/index.html": ["<!doctype html>", "text/html"],
    "/pair-sw.js": ["self.x=1", "text/javascript"],
    "/assets/app-ABC.js": ["x", "text/javascript"],
  }
  const seen: string[] = []
  const env: EdgeEnv = {
    PAIR_DOMAIN: "agentproto.cloud",
    PREVIEW_HOSTS: "agentproto-pair-page.example.workers.dev",
    ASSETS: {
      async fetch(input) {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname
        seen.push(path)
        const f = files[path]
        return f ? new Response(f[0], { headers: { "Content-Type": f[1] } }) : new Response("missing", { status: 404 })
      },
    },
  }
  const get = (url: string, method = "GET") => handleRequest(new Request(url, { method }), env)

  it("404s a non-daemon host without touching the assets, headers included", async () => {
    seen.length = 0
    for (const url of ["https://agentproto.cloud/pair", "https://www.agentproto.cloud/pair", "https://evil.example/pair"]) {
      const res = await get(url)
      expect(res.status, url).toBe(404)
      expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'")
      expect(res.headers.get("Cache-Control")).toBe("no-store")
    }
    expect(seen).toEqual([])
  })

  it("serves the document for app routes on a daemon origin, with the headers", async () => {
    for (const path of ["/pair", `/d/${FP}`, `/d/${FP}/apps/@agentik/session-chat/ui/`]) {
      seen.length = 0
      const res = await get(`https://${FP}.agentproto.cloud${path}`)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe("<!doctype html>")
      expect(seen).toEqual(["/index.html"])
      expect(res.headers.get("Cache-Control")).toBe("no-cache")
      expect(res.headers.get("X-Frame-Options")).toBe("DENY")
      expect(res.headers.get("Content-Security-Policy")).not.toContain("ws://")
    }
  })

  it("serves assets as named, and 404s missing ones", async () => {
    const sw = await get(`https://${FP}.agentproto.cloud/pair-sw.js`)
    expect(sw.status).toBe(200)
    expect(sw.headers.get("Cache-Control")).toBe("no-cache")
    expect(sw.headers.get("Content-Security-Policy")).toContain("connect-src 'self' wss:")
    const asset = await get(`https://${FP}.agentproto.cloud/assets/app-ABC.js`)
    expect(asset.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable")
    const missing = await get(`https://${FP}.agentproto.cloud/index.php`)
    expect(missing.status).toBe(404)
    expect(missing.headers.get("Cache-Control")).toBe("no-store")
  })

  it("refuses methods other than GET and HEAD", async () => {
    const res = await get(`https://${FP}.agentproto.cloud/pair`, "POST")
    expect(res.status).toBe(405)
    expect(res.headers.get("Allow")).toBe("GET, HEAD")
  })

  it("serves a PREVIEW_HOSTS host in preview mode", async () => {
    const res = await get("https://agentproto-pair-page.example.workers.dev/pair")
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Security-Policy")).toContain("ws://127.0.0.1:*")
  })
})
