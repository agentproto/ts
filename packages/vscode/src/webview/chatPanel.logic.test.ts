import { describe, expect, it } from "vitest"

import { buildChatPanelHtml, chatPanelUrl, daemonOrigin } from "./chatPanel.logic.js"

describe("daemonOrigin", () => {
  it("derives the origin from the daemon url (never hardcoded)", () => {
    expect(daemonOrigin("http://127.0.0.1:18790")).toBe("http://127.0.0.1:18790")
    expect(daemonOrigin("http://localhost:9999/path")).toBe("http://localhost:9999")
  })

  it("returns null on an unparseable url", () => {
    expect(daemonOrigin("not a url")).toBeNull()
  })
})

describe("buildChatPanelHtml", () => {
  it("embeds the chat url in a full-viewport iframe", () => {
    const url = chatPanelUrl("http://127.0.0.1:18790", "sess_abc")
    const html = buildChatPanelHtml(url, "http://127.0.0.1:18790")
    expect(html).toContain(`<iframe id="chat" title="Session Chat" src="${url.replace(/&/g, "&amp;")}"></iframe>`)
    expect(html).toContain("height: 100vh")
  })

  it("pins the CSP frame-src to the daemon origin with default-src 'none'", () => {
    const html = buildChatPanelHtml("http://127.0.0.1:18790/x", "http://10.0.0.5:18790")
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("frame-src http://10.0.0.5:18790")
    expect(html).not.toContain("frame-src 'self'")
    expect(html).not.toContain("script-src")
  })

  it("falls back to frame-src * when the origin is unavailable (degraded but functional)", () => {
    const html = buildChatPanelHtml("http://127.0.0.1:18790/x", null)
    expect(html).toContain("frame-src *")
    expect(html).toContain("default-src 'none'")
  })

  it("escapes the url for the src attribute", () => {
    const html = buildChatPanelHtml("http://h/a?b=1&c=2", "http://h")
    expect(html).toContain('src="http://h/a?b=1&amp;c=2"')
  })
})
