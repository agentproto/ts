/**
 * ssrf-sends-original-host-header — V-1 probe regression: connecting by
 * pre-validated IP must NOT turn the HTTP Host header into a literal IP.
 * Name-based vhosts (cloudflared/CF edge tested live) serve the hostname,
 * answer a literal-IP Host with 403/421 — which would mis-categorise every
 * subscriber as `non_2xx` instead of `challenge_failed`.
 */

import { afterEach, describe, expect, it } from "vitest"

import { setEgressDispatcherForTests, type EgressDispatcher } from "../../webhook-egress/ssrf-fetch.js"

afterEach(() => {
  setEgressDispatcherForTests(null)
})

describe("ssrf-sends-original-host-header", () => {
  it("the wire request keeps the ORIGINAL hostname as HTTP Host (never the connect IP)", async () => {
    const seen: Array<{ url: string; host?: string; authorizationPresent?: boolean }> = []
    const dispatcher: EgressDispatcher = async (req) => {
      const host = req.headers.Host ?? req.headers.host
      seen.push({ url: req.url, host })
      return { status: 200, body: "" }
    }
    setEgressDispatcherForTests(dispatcher)
    const bytes = new TextEncoder().encode("host-header-test")
    const { ssrfFetch } = await import("../../webhook-egress/ssrf-fetch.js")
    await ssrfFetch("https://radar.example.com/challenge-echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bytes,
      timeoutMs: 1_000,
    })
    const first = seen[0]
    if (!first) throw new Error("expected one dispatcher call")
    expect(first.url).toBe("https://radar.example.com/challenge-echo")
    expect(first.host).toBe("radar.example.com")
  })

  it("an explicit caller Host header is preserved verbatim", async () => {
    let host: string | undefined
    const dispatcher: EgressDispatcher = async (req) => {
      host = req.headers.Host ?? req.headers.host
      return { status: 200, body: "" }
    }
    setEgressDispatcherForTests(dispatcher)
    const { ssrfFetch } = await import("../../webhook-egress/ssrf-fetch.js")
    await ssrfFetch("https://radar.example.com/x", {
      method: "POST",
      headers: { Host: "proxy-router.example.org" },
      timeoutMs: 1_000,
    })
    expect(host).toBe("proxy-router.example.org")
  })

  it("a non-standard port keeps the hostname in Host (no :port only when default)", async () => {
    // 8443 is a non-default port; the Host header mirrors the submitted URL's
    // authority, not the connect IP.
    let host: string | undefined
    const dispatcher: EgressDispatcher = async (req) => {
      host = req.headers.Host ?? req.headers.host
      return { status: 200, body: "" }
    }
    setEgressDispatcherForTests(dispatcher)
    const { ssrfFetch } = await import("../../webhook-egress/ssrf-fetch.js")
    await ssrfFetch("https://radar.example.com:8443/x", {
      method: "POST",
      headers: {},
      timeoutMs: 1_000,
    })
    expect(host).toBe("radar.example.com:8443")
  })
})
