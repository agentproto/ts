/**
 * The pure CSP helpers from dom.ts — plain strings in, strings out, no DOM.
 */
import { describe, expect, it } from "vitest"

import { buildCspMeta, buildCspPolicy, injectCsp, toResourcePermissions } from "../dom.js"
import { buildSandboxCspHeader } from "../csp.js"

const DEFAULT_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; font-src data:; media-src data: blob:; " +
  "connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'"

describe("buildCspPolicy", () => {
  it("defaults every network directive to 'none' when csp is absent", () => {
    expect(buildCspPolicy(undefined)).toBe(DEFAULT_POLICY)
    expect(buildCspPolicy({})).toBe(DEFAULT_POLICY)
  })

  it("spreads resourceDomains over script/style/img/font/media and keeps the rest separate", () => {
    const policy = buildCspPolicy({
      resourceDomains: ["https://cdn.example.com"],
      connectDomains: ["https://api.example.com", "wss://live.example.com"],
      frameDomains: ["https://www.youtube.com"],
      baseUriDomains: ["https://base.example.com"],
    })
    expect(policy).toBe(
      "default-src 'none'; " +
        "script-src 'unsafe-inline' https://cdn.example.com; " +
        "style-src 'unsafe-inline' https://cdn.example.com; " +
        "img-src data: blob: https://cdn.example.com; " +
        "font-src data: https://cdn.example.com; " +
        "media-src data: blob: https://cdn.example.com; " +
        "connect-src https://api.example.com wss://live.example.com; " +
        "frame-src https://www.youtube.com; " +
        "object-src 'none'; " +
        "base-uri https://base.example.com",
    )
  })

  it("frameDomains omitted ⇒ frame-src 'none', even when other domains are declared", () => {
    const policy = buildCspPolicy({ connectDomains: ["https://api.example.com"] })
    expect(policy).toContain("frame-src 'none'")
    expect(policy).toContain("connect-src https://api.example.com")
  })

  it("drops tokens that could inject a directive or keyword", () => {
    const policy = buildCspPolicy({
      connectDomains: ["https://ok.example.com", "https://x.com; script-src *", "'unsafe-eval'", "a b"],
    })
    expect(policy).toContain("connect-src https://ok.example.com;")
    expect(policy).not.toContain("unsafe-eval")
    expect(policy).not.toContain("script-src *")
  })
})

describe("buildCspMeta", () => {
  it("renders an http-equiv meta tag", () => {
    expect(buildCspMeta(undefined)).toBe(
      `<meta http-equiv="Content-Security-Policy" content="${DEFAULT_POLICY}">`,
    )
  })
})

describe("injectCsp", () => {
  const meta = buildCspMeta(undefined)

  it("inserts the meta as the first child of an existing <head>", () => {
    const html = `<!doctype html><html lang="en"><head><title>x</title></head><body></body></html>`
    expect(injectCsp(html, undefined)).toBe(
      `<!doctype html><html lang="en"><head>${meta}<title>x</title></head><body></body></html>`,
    )
  })

  it("matches <head> with attributes but not <header>", () => {
    const html = `<html><header>h</header><head data-x="1"><title>x</title></head></html>`
    expect(injectCsp(html, undefined)).toBe(
      `<html><header>h</header><head data-x="1">${meta}<title>x</title></head></html>`,
    )
  })

  it("creates <head> right after <html> when there is none", () => {
    const html = `<!DOCTYPE html><html><body><p>hi</p></body></html>`
    expect(injectCsp(html, undefined)).toBe(
      `<!DOCTYPE html><html><head>${meta}</head><body><p>hi</p></body></html>`,
    )
  })

  it("creates <head> after the doctype for a bare fragment document", () => {
    expect(injectCsp(`<!doctype html><div>hi</div>`, undefined)).toBe(
      `<!doctype html><head>${meta}</head><div>hi</div>`,
    )
    expect(injectCsp(`<div>hi</div>`, undefined)).toBe(`<head>${meta}</head><div>hi</div>`)
  })

  it("keeps a CSP meta the view ships itself, ours first (policies intersect)", () => {
    const own = `<meta http-equiv="Content-Security-Policy" content="img-src 'self'">`
    const html = `<html><head>${own}</head><body></body></html>`
    const out = injectCsp(html, { frameDomains: ["https://embed.example.com"] })
    const ours = buildCspMeta({ frameDomains: ["https://embed.example.com"] })
    expect(out).toBe(`<html><head>${ours}${own}</head><body></body></html>`)
    expect(out.indexOf(ours)).toBeLessThan(out.indexOf(own))
  })
})

describe("toResourcePermissions", () => {
  it("keeps only known permissions requested as objects", () => {
    expect(
      toResourcePermissions({ camera: {}, microphone: true, clipboardWrite: {}, bogus: {} }),
    ).toEqual({ camera: {}, clipboardWrite: {} })
    expect(toResourcePermissions(undefined)).toEqual({})
  })
})

describe("buildSandboxCspHeader", () => {
  it("defaults: 'self' sources, none for frames, base-uri 'self', no embedder", () => {
    expect(buildSandboxCspHeader(undefined, undefined)).toBe(
      "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; " +
        "connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    )
  })

  it("honours every declared domain, including baseUriDomains", () => {
    const h = buildSandboxCspHeader(
      {
        resourceDomains: ["https://cdn.example.com"],
        connectDomains: ["https://api.example.com"],
        frameDomains: ["https://www.youtube.com"],
        baseUriDomains: ["https://archive.org"],
      },
      "http://127.0.0.1:18790",
    )
    expect(h).toContain("script-src 'self' 'unsafe-inline' https://cdn.example.com")
    expect(h).toContain("connect-src 'self' https://api.example.com")
    expect(h).toContain("frame-src https://www.youtube.com")
    expect(h).toContain("base-uri https://archive.org")
    expect(h).toContain("frame-ancestors http://127.0.0.1:18790")
  })

  it("pins frame-ancestors to a bare http(s) origin only (R6)", () => {
    expect(buildSandboxCspHeader(undefined, "https://host.example.com/some/path?q=1")).toContain(
      "frame-ancestors https://host.example.com",
    )
    for (const bad of ["javascript:alert(1)", "*", "https://a.com; script-src *", "", "not a url"]) {
      expect(buildSandboxCspHeader(undefined, bad)).toContain("frame-ancestors 'none'")
    }
  })

  it("still drops directive-injecting tokens, and the daemon can drop its own origin", () => {
    const h = buildSandboxCspHeader(
      { connectDomains: ["https://ok.example.com", "https://x.com; script-src *", "'unsafe-eval'", "http://127.0.0.1:1"] },
      undefined,
      { dropSource: (s) => s.includes("127.0.0.1") },
    )
    expect(h).toContain("connect-src 'self' https://ok.example.com;")
    expect(h).not.toContain("unsafe-eval")
    expect(h).not.toContain("script-src *")
    expect(h).not.toContain("127.0.0.1")
  })
})

describe("injectCsp — the meta lands where the HTML parser will see it", () => {
  const META = buildCspMeta(undefined)
  it("ignores <head> inside comments and script/style/textarea/title content", () => {
    for (const html of [
      "<!-- <head> --><html><head><title>t</title></head><body></body></html>",
      '<html><script>var s = "<head>"</script><head></head></html>',
      "<html><style>/* <head> */</style><head></head></html>",
      "<html><textarea><head></textarea><head></head></html>",
      "<html><title><head></title><head></head></html>",
    ]) {
      const out = injectCsp(html, undefined)
      // Our meta must come right after the REAL <head>, never inside the decoy.
      const real = out.lastIndexOf("<head>")
      expect(out.slice(real, real + "<head>".length + META.length), html).toBe(`<head>${META}`)
      expect(out.split(META).length, html).toBe(2)
    }
  })

  it("an unterminated comment cannot swallow the injection", () => {
    const out = injectCsp("<!-- <head>", undefined)
    expect(out.startsWith(`<head>${META}</head>`)).toBe(true)
  })

  it("handles quoted > inside attributes of the head tag", () => {
    const out = injectCsp('<html><head data-x="a>b"><title>t</title></head></html>', undefined)
    expect(out).toContain(`<head data-x="a>b">${META}<title>`)
  })
})

describe("SAFE_SOURCE rejects control characters", () => {
  it("drops sources containing NUL / CR / LF (they would make writeHead throw or split headers)", () => {
    const h = buildSandboxCspHeader({ connectDomains: ["https://a.example.com", "https://b\u0000.example.com", "https://c\r\nx.example.com"] }, undefined)
    expect(h).toContain("connect-src 'self' https://a.example.com;")
    expect(h).not.toContain("\u0000")
    expect(h).not.toContain("b.example")
  })
})
