/**
 * `buildSessionLink` — the pure `<tunnelUrl>/s/<sessionId>` miniapp deep-link
 * helper (studio repo `services/telegram-session-chat-miniapp/src/server.ts`
 * owns the `/s/<sessionId>` route).
 */

import { describe, expect, it } from "vitest"
import { buildSessionLink } from "../tunnel-links.js"

describe("buildSessionLink", () => {
  it("appends the miniapp route to a bare tunnel origin", () => {
    expect(buildSessionLink("https://abc.trycloudflare.com", "sess_123")).toBe(
      "https://abc.trycloudflare.com/s/sess_123",
    )
  })

  it("strips a single trailing slash before appending", () => {
    expect(buildSessionLink("https://abc.trycloudflare.com/", "sess_123")).toBe(
      "https://abc.trycloudflare.com/s/sess_123",
    )
    expect(buildSessionLink("https://abc.trycloudflare.com/base/", "sess_123")).toBe(
      "https://abc.trycloudflare.com/base/s/sess_123",
    )
  })

  it("preserves the access guard's query string (signed-link token)", () => {
    expect(buildSessionLink("https://abc.trycloudflare.com?t=tok123", "sess_123")).toBe(
      "https://abc.trycloudflare.com/s/sess_123?t=tok123",
    )
  })

  it("throws on an empty session id", () => {
    expect(() => buildSessionLink("https://abc.trycloudflare.com", "")).toThrow(/sessionId/)
    expect(() => buildSessionLink("https://abc.trycloudflare.com", "   ")).toThrow(/sessionId/)
  })

  it("throws on a non-https scheme", () => {
    expect(() => buildSessionLink("ws://abc.trycloudflare.com", "sess_123")).toThrow(/https/)
    expect(() => buildSessionLink("http://abc.trycloudflare.com", "sess_123")).toThrow(/https/)
    expect(() => buildSessionLink("ftp://abc.trycloudflare.com", "sess_123")).toThrow(/https/)
  })

  it("throws on an empty or malformed tunnel URL", () => {
    expect(() => buildSessionLink("", "sess_123")).toThrow(/tunnelUrl/)
    expect(() => buildSessionLink("not a url", "sess_123")).toThrow(/invalid tunnel URL/)
  })
})
