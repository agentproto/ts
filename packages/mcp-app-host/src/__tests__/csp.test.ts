/**
 * The pure CSP helpers from dom.ts — plain strings in, strings out, no DOM.
 */
import { describe, expect, it } from "vitest"

import { buildCspMeta, buildCspPolicy, injectCsp, toResourcePermissions } from "../dom.js"

const DEFAULT_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; font-src data:; media-src data: blob:; " +
  "connect-src 'none'; frame-src 'none'; base-uri 'none'"

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
