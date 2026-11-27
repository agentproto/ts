/**
 * Unit tests for the MCP App sandbox-origin store/handler (mcp-app-sandbox.ts).
 * The daemon-level guarantees (403 on a sandbox Origin, host routing) are in
 * mcp-app-sandbox-http.test.ts.
 */
import { EventEmitter } from "node:events"
import type { IncomingMessage, ServerResponse } from "node:http"
import { describe, expect, it } from "vitest"

import { createMcpAppSandbox, parseRegistration, type McpAppSandbox } from "../mcp-app-sandbox.js"

/** `register` is null only for a remote host without a public origin. */
function reg(sb: McpAppSandbox, input: Parameters<McpAppSandbox["register"]>[0]) {
  const v = sb.register(input)
  if (!v) throw new Error("expected a registered view")
  return v
}

function fakeRes() {
  const out: { status?: number; headers: Record<string, string>; body?: string } = { headers: {} }
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      out.status = status
      out.headers = Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
      return res
    },
    end(body?: string) {
      out.body = body
    },
  }
  return { res: res as unknown as ServerResponse, out }
}

function fakeReq(method: string, url: string, headers: Record<string, string> = {}): IncomingMessage {
  return Object.assign(new EventEmitter(), { method, url, headers }) as unknown as IncomingMessage
}

const HTML = "<!doctype html><html><head></head><body>view</body></html>"

describe("createMcpAppSandbox — URLs and origins", () => {
  it("subdomain mode: per-view origin that differs from the daemon's (R7)", () => {
    const sb = createMcpAppSandbox(undefined, { port: 18790 })
    const a = reg(sb, { html: HTML })
    const b = reg(sb, { html: HTML })
    expect(a.mode).toBe("subdomain")
    expect(a.origin).toBe(`http://${a.token}.sandbox.localhost:18790`)
    expect(a.url).toBe(`${a.origin}/v/${a.token}`)
    expect(a.origin).not.toBe("http://127.0.0.1:18790")
    expect(a.origin).not.toBe(b.origin)
    expect(a.token).toMatch(/^[0-9a-f]{32}$/)
  })

  it("port mode: one dedicated origin, and the port must differ from the daemon's", () => {
    expect(() => createMcpAppSandbox({ mode: "port" }, { port: 18790 })).toThrow()
    expect(() => createMcpAppSandbox({ mode: "port", port: 18790 }, { port: 18790 })).toThrow()
    const sb = createMcpAppSandbox({ mode: "port", port: 18791 }, { port: 18790 })
    const v = reg(sb, { html: HTML })
    expect(v.mode).toBe("port")
    expect(v.origin).toBe("http://127.0.0.1:18791")
  })

  it("public origin is used when the registering page was reached through a non-loopback host", () => {
    const sb = createMcpAppSandbox({ publicOrigin: "https://sbx.example.com" }, { port: 18790 })
    expect(reg(sb, { html: HTML, requestHost: "app.example.com" }).origin).toBe("https://sbx.example.com")
    expect(reg(sb, { html: HTML, requestHost: "127.0.0.1:18790" }).mode).toBe("subdomain")
    expect(reg(sb, { html: HTML, requestHost: "localhost:18790" }).mode).toBe("subdomain")
  })

  it("off mode: not enabled, classifies nothing", () => {
    const sb = createMcpAppSandbox({ mode: "off" }, { port: 18790 })
    expect(sb.enabled).toBe(false)
    expect(sb.classifyHost("abc.sandbox.localhost:18790")).toBeNull()
  })

  it("classifyHost: any *.sandbox.localhost host is sandbox-side, even with a bogus label", () => {
    const sb = createMcpAppSandbox(undefined, { port: 18790 })
    expect(sb.classifyHost("127.0.0.1:18790")).toBeNull()
    expect(sb.classifyHost("localhost:18790")).toBeNull()
    expect(sb.classifyHost("evil.sandbox.localhost:18790")).toEqual({ kind: "subdomain", label: "evil" })
    expect(sb.classifyHost("A.B.SANDBOX.LOCALHOST")).toEqual({ kind: "subdomain", label: "a.b" })
  })

  it("isSandboxOrigin covers subdomains, the public origin and the sandbox port; never the daemon", () => {
    const sb = createMcpAppSandbox(
      { mode: "port", port: 18791, publicOrigin: "https://sbx.example.com" },
      { port: 18790 },
    )
    expect(sb.isSandboxOrigin("http://abc.sandbox.localhost:18790")).toBe(true)
    expect(sb.isSandboxOrigin("https://sbx.example.com")).toBe(true)
    expect(sb.isSandboxOrigin("http://127.0.0.1:18791")).toBe(true)
    expect(sb.isSandboxOrigin("http://localhost:18791")).toBe(true)
    expect(sb.isSandboxOrigin("http://127.0.0.1:18790")).toBe(false)
    expect(sb.isSandboxOrigin("null")).toBe(false)
    expect(sb.isSandboxOrigin(undefined)).toBe(false)
  })

  it("isSandboxRequest checks Origin and Referer", () => {
    const sb = createMcpAppSandbox(undefined, { port: 18790 })
    expect(sb.isSandboxRequest(fakeReq("GET", "/", { origin: "http://x.sandbox.localhost:18790" }))).toBe(true)
    expect(
      sb.isSandboxRequest(fakeReq("GET", "/", { referer: "http://x.sandbox.localhost:18790/v/abc" })),
    ).toBe(true)
    expect(sb.isSandboxRequest(fakeReq("GET", "/", { origin: "http://127.0.0.1:18790" }))).toBe(false)
    expect(sb.isSandboxRequest(fakeReq("GET", "/", {}))).toBe(false)
  })
})

describe("createMcpAppSandbox — serving", () => {
  it("serves the view with the CSP as an HTTP header (R3) and hardening headers", () => {
    const sb = createMcpAppSandbox(undefined, { port: 18790 })
    const v = reg(sb, {
      html: HTML,
      csp: { connectDomains: ["https://api.example.com"], baseUriDomains: ["https://archive.org"] },
      ancestor: "http://127.0.0.1:18790",
    })
    const { res, out } = fakeRes()
    sb.handle(fakeReq("GET", `/v/${v.token}`), res, { kind: "subdomain", label: v.token })
    expect(out.status).toBe(200)
    expect(out.body).toBe(HTML)
    expect(out.headers["content-type"]).toContain("text/html")
    expect(out.headers["cache-control"]).toBe("no-store")
    expect(out.headers["x-content-type-options"]).toBe("nosniff")
    expect(out.headers["referrer-policy"]).toBe("no-referrer")
    const csp = out.headers["content-security-policy"] ?? ""
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("connect-src 'self' https://api.example.com")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri https://archive.org")
    expect(csp).toContain("frame-ancestors http://127.0.0.1:18790")
    expect(csp).toContain("frame-src 'none'")
    // No CORS: the view's origin is not granted anything.
    expect(out.headers["access-control-allow-origin"]).toBeUndefined()
  })

  it("CSP defaults: base-uri 'self', frame-ancestors 'none' without an embedder (R6)", () => {
    const sb = createMcpAppSandbox(undefined, { port: 18790 })
    const v = reg(sb, { html: HTML })
    const { res, out } = fakeRes()
    sb.handle(fakeReq("GET", `/v/${v.token}`), res, { kind: "subdomain", label: v.token })
    const csp = out.headers["content-security-policy"] ?? ""
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it("a sandbox origin can never be recorded as the embedder", () => {
    const sb = createMcpAppSandbox(undefined, { port: 18790 })
    const v = reg(sb, { html: HTML, ancestor: "http://x.sandbox.localhost:18790" })
    const { res, out } = fakeRes()
    sb.handle(fakeReq("GET", `/v/${v.token}`), res, { kind: "subdomain", label: v.token })
    expect(out.headers["content-security-policy"]).toContain("frame-ancestors 'none'")
  })

  it("drops declared sources that target the daemon itself (R3)", () => {
    const sb = createMcpAppSandbox(undefined, { port: 18790 })
    const v = reg(sb, {
      html: HTML,
      ancestor: "https://host.example.com",
      csp: {
        connectDomains: [
          "http://127.0.0.1:18790",
          "http://localhost:18790",
          "127.0.0.1:18790",
          "https://host.example.com",
          "https://ok.example.com",
        ],
      },
    })
    const { res, out } = fakeRes()
    sb.handle(fakeReq("GET", `/v/${v.token}`), res, { kind: "subdomain", label: v.token })
    const connect = (out.headers["content-security-policy"] ?? "").split("; ").find((d) => d.startsWith("connect-src"))
    expect(connect).toBe("connect-src 'self' https://ok.example.com")
  })

  it("drops broad and wildcard sources that could reach a plain-http loopback daemon (R3)", () => {
    const sb = createMcpAppSandbox(undefined, { port: 18790 })
    const v = reg(sb, {
      html: HTML,
      csp: {
        connectDomains: [
          "*",
          "http:",
          "ws:",
          "*.localhost",
          "http://127.0.0.1:*",
          "http://localhost:*",
          "http://[::1]:18790",
          "http://0.0.0.0:18790",
          "ws://localhost:18790",
          "https://ok.example.com",
          "wss://ok.example.com",
          "https:",
        ],
      },
    })
    const { res, out } = fakeRes()
    sb.handle(fakeReq("GET", `/v/${v.token}`), res, { kind: "subdomain", label: v.token })
    const connect = (out.headers["content-security-policy"] ?? "").split("; ").find((d) => d.startsWith("connect-src"))
    expect(connect).toBe("connect-src 'self' https://ok.example.com wss://ok.example.com https:")
  })

  it("the store has a total byte budget: the oldest views are evicted (R4)", () => {
    const sb = createMcpAppSandbox({ maxTotalBytes: 100 }, { port: 18790 })
    const big = "x".repeat(60)
    const first = reg(sb, { html: big })
    reg(sb, { html: big })
    expect(sb.size()).toBe(1)
    const { res, out } = fakeRes()
    sb.handle(fakeReq("GET", `/v/${first.token}`), res, { kind: "subdomain", label: first.token })
    expect(out.status).toBe(404)
  })

  it("drops every spelling of a loopback host, on any port, plus data: frames (R1/R3)", () => {
    const sb = createMcpAppSandbox(undefined, { port: 18790 })
    const v = reg(sb, {
      html: HTML,
      csp: {
        connectDomains: [
          "http://127.1:18790",
          "http://2130706433:18790",
          "http://0x7f.1",
          "http://127.0.0.1:3000",
          "http://localhost.:18790",
          "http://foo.localhost:18790",
          "http://[::ffff:127.0.0.1]:18790",
          "http://[::ffff:7f00:1]:18790",
          "http://[::1]:9",
          "ws://127.0.0.2:18790",
          "https://ok.example.com",
        ],
        frameDomains: ["data:", "about:", "blob:", "https://www.youtube.com"],
      },
    })
    const { res, out } = fakeRes()
    sb.handle(fakeReq("GET", `/v/${v.token}`), res, { kind: "subdomain", label: v.token })
    const directives = (out.headers["content-security-policy"] ?? "").split("; ")
    expect(directives.find((d) => d.startsWith("connect-src"))).toBe("connect-src 'self' https://ok.example.com")
    expect(directives.find((d) => d.startsWith("frame-src"))).toBe("frame-src blob: https://www.youtube.com")
  })

  it("drops private/local-network hosts, userinfo tricks and the page's own hostname in any spelling (R3)", () => {
    const sb = createMcpAppSandbox(undefined, { port: 18790 })
    const v = reg(sb, {
      html: HTML,
      ancestor: "https://host.example.com",
      csp: {
        connectDomains: [
          "http://10.0.0.5:18790",
          "http://192.168.1.2:*",
          "http://172.16.0.1",
          "http://172.31.255.254:18790",
          "http://169.254.1.1",
          "http://100.64.0.1",
          "http://[fd00::1]:18790",
          "http://[fe80::1]",
          "http://printer.local",
          "http://nas.internal:8080",
          "*.local",
          "http://user@127.0.0.1:18790",
          "https://host.example.com:*",
          "https://host.example.com.",
          "https://HOST.example.com:8443",
          "https://api.example.com",
          "http://172.32.0.1",
          "http://8.8.8.8",
        ],
      },
    })
    const { res, out } = fakeRes()
    sb.handle(fakeReq("GET", `/v/${v.token}`), res, { kind: "subdomain", label: v.token })
    const connect = (out.headers["content-security-policy"] ?? "").split("; ").find((d) => d.startsWith("connect-src"))
    expect(connect).toBe("connect-src 'self' https://api.example.com http://172.32.0.1 http://8.8.8.8")
  })

  it("classifies the public hostname canonically: case, trailing dot, default port (R2)", () => {
    const sb = createMcpAppSandbox({ publicOrigin: "https://sbx.example.com" }, { port: 18790 })
    for (const h of ["sbx.example.com", "SBX.Example.com", "sbx.example.com.", "sbx.example.com:443", "sbx.example.com.:443"]) {
      expect(sb.classifyHost(h), h).toEqual({ kind: "public" })
    }
    expect(sb.classifyHost("sbx.example.com:8443")).toBeNull()
    expect(sb.classifyHost("other.example.com")).toBeNull()
    for (const o of ["https://sbx.example.com", "https://SBX.example.com.", "https://sbx.example.com:443"]) {
      expect(sb.isSandboxOrigin(o), o).toBe(true)
    }
    expect(sb.isSandboxOrigin("https://app.example.com")).toBe(false)
  })

  it("classifies a trailing-dot sandbox host, and *.sandbox.localhost origins with a trailing dot", () => {
    const sb = createMcpAppSandbox(undefined, { port: 18790 })
    expect(sb.classifyHost("abc.sandbox.localhost.:18790")).toEqual({ kind: "subdomain", label: "abc" })
    expect(sb.isSandboxOrigin("http://abc.sandbox.localhost.:18790")).toBe(true)
  })

  it("port mode uses a hostname different from the registering page's (cookie jar)", () => {
    const sb = createMcpAppSandbox({ mode: "port", port: 18791 }, { port: 18790 })
    expect(reg(sb, { html: HTML, requestHost: "127.0.0.1:18790" }).origin).toBe("http://localhost:18791")
    expect(reg(sb, { html: HTML, requestHost: "localhost:18790" }).origin).toBe("http://127.0.0.1:18791")
  })

  it("the public origin also wipes cookies on load (dedicated hostname)", () => {
    const sb = createMcpAppSandbox({ publicOrigin: "https://sbx.example.com" }, { port: 18790 })
    const v = reg(sb, { html: HTML, requestHost: "app.example.com" })
    const r = fakeRes()
    sb.handle(fakeReq("GET", `/v/${v.token}`), r.res, { kind: "public" })
    expect(r.out.headers["clear-site-data"]).toBe('"cache", "cookies", "storage"')
  })

  it("a page reached through a non-loopback host gets no *.localhost URL unless a public origin exists", () => {
    const sb = createMcpAppSandbox(undefined, { port: 18790 })
    expect(sb.register({ html: HTML, requestHost: "app.example.com" })).toBeNull()
    expect(sb.size()).toBe(0)
  })

  it("shared-origin modes wipe the origin's storage on each document load; subdomain does not need to (R7)", () => {
    const shared = createMcpAppSandbox({ mode: "port", port: 18791 }, { port: 18790 })
    const v = reg(shared, { html: HTML })
    let r = fakeRes()
    shared.handle(fakeReq("GET", `/v/${v.token}`), r.res, { kind: "port" })
    expect(r.out.headers["clear-site-data"]).toBe('"cache", "storage"')
    const iso = createMcpAppSandbox(undefined, { port: 18790 })
    const w = reg(iso, { html: HTML })
    r = fakeRes()
    iso.handle(fakeReq("GET", `/v/${w.token}`), r.res, { kind: "subdomain", label: w.token })
    expect(r.out.headers["clear-site-data"]).toBeUndefined()
  })

  it("subdomain mode refuses a document on any origin but its own (R7)", () => {
    const sb = createMcpAppSandbox(undefined, { port: 18790 })
    const a = reg(sb, { html: HTML })
    const b = reg(sb, { html: HTML })
    const { res, out } = fakeRes()
    sb.handle(fakeReq("GET", `/v/${a.token}`), res, { kind: "subdomain", label: b.token })
    expect(out.status).toBe(404)
  })

  it("only GET|HEAD /v/<token>: other paths 404, other methods 405 (R2)", () => {
    const sb = createMcpAppSandbox(undefined, { port: 18790 })
    const v = reg(sb, { html: HTML })
    const kind = { kind: "subdomain", label: v.token } as const
    for (const path of ["/", "/health", "/mcp", "/sessions", `/v/${v.token}/x`, "/v/nothex", "/v/", "/apps/a/ui"]) {
      const { res, out } = fakeRes()
      sb.handle(fakeReq("GET", path), res, kind)
      expect(out.status, path).toBe(404)
    }
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
      const { res, out } = fakeRes()
      sb.handle(fakeReq(method, `/v/${v.token}`), res, kind)
      expect(out.status, method).toBe(405)
      expect(out.headers["access-control-allow-origin"]).toBeUndefined()
    }
    const { res, out } = fakeRes()
    sb.handle(fakeReq("HEAD", `/v/${v.token}`), res, kind)
    expect(out.status).toBe(200)
    expect(out.body).toBeUndefined()
  })

  it("tokens expire (R4)", () => {
    let t = 1_000
    const sb = createMcpAppSandbox({ ttlMs: 500 }, { port: 18790, now: () => t })
    const v = reg(sb, { html: HTML })
    const kind = { kind: "subdomain", label: v.token } as const
    let r = fakeRes()
    sb.handle(fakeReq("GET", `/v/${v.token}`), r.res, kind)
    expect(r.out.status).toBe(200)
    t += 501
    r = fakeRes()
    sb.handle(fakeReq("GET", `/v/${v.token}`), r.res, kind)
    expect(r.out.status).toBe(404)
  })

  it("the store is bounded: the oldest view is evicted (R4)", () => {
    const sb = createMcpAppSandbox({ maxViews: 2 }, { port: 18790 })
    const first = reg(sb, { html: HTML })
    reg(sb, { html: HTML })
    reg(sb, { html: HTML })
    expect(sb.size()).toBe(2)
    const { res, out } = fakeRes()
    sb.handle(fakeReq("GET", `/v/${first.token}`), res, { kind: "subdomain", label: first.token })
    expect(out.status).toBe(404)
  })

  it("unknown tokens 404", () => {
    const sb = createMcpAppSandbox(undefined, { port: 18790 })
    const t = "0".repeat(32)
    const { res, out } = fakeRes()
    sb.handle(fakeReq("GET", `/v/${t}`), res, { kind: "subdomain", label: t })
    expect(out.status).toBe(404)
  })
})

describe("parseRegistration", () => {
  it("accepts html + a well-formed csp and keeps only the four known keys", () => {
    const r = parseRegistration({ html: HTML, csp: { connectDomains: ["https://a"], extra: ["x"] } }, 1000)
    expect(r).toEqual({ ok: true, html: HTML, csp: { connectDomains: ["https://a"] } })
  })

  it("rejects bad bodies", () => {
    expect(parseRegistration(null, 1000)).toEqual({ ok: false, error: "invalid_body" })
    expect(parseRegistration({}, 1000)).toEqual({ ok: false, error: "invalid_html" })
    expect(parseRegistration({ html: "" }, 1000)).toEqual({ ok: false, error: "invalid_html" })
    expect(parseRegistration({ html: "x".repeat(11) }, 10)).toEqual({ ok: false, error: "html_too_large" })
    expect(parseRegistration({ html: HTML, csp: "x" }, 1000)).toEqual({ ok: false, error: "invalid_csp" })
    expect(parseRegistration({ html: HTML, csp: { connectDomains: "x" } }, 1000)).toEqual({
      ok: false,
      error: "invalid_csp",
    })
    expect(parseRegistration({ html: HTML, csp: { connectDomains: [1] } }, 1000)).toEqual({
      ok: false,
      error: "invalid_csp",
    })
  })
})
