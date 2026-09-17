/**
 * Behavioural coverage for the session-chat blob pass-through transform
 * (session-chat/blob-embed.ts). The panel ships `blobEmbedScript()` as a JS
 * string; this file evaluates THAT string (no TS twin to drift from) and
 * exercises `transformChatHtmlForBlob` on a stand-in of what the daemon's
 * `GET /apps/@agentik/session-chat/ui` returns — the app's html with
 * runtime's standalone REST bridge (`fetch("./tool-call"`) injected right
 * after `<head>`. The injected shim is then run against a stub `window` to
 * prove the embed token rides on daemon-origin requests only.
 */

import { describe, it, expect, vi } from "vitest"
import { BLOB_BOOT_MESSAGE_TYPE, blobEmbedScript } from "../session-chat/blob-embed.js"

const URL_ = "http://127.0.0.1:18790/apps/@agentik/session-chat/ui?session=sess_1&embed=1"
const TOKEN = "tok_per_boot"

// What the daemon serves (app-ui-apps.ts STANDALONE_REST_BRIDGE_SCRIPT is
// injected right after <head> by injectStandaloneAppBridge).
const SERVED_HTML = `<!doctype html>
<html lang="en">
<head><script>
(function () {
  window.McpApp = { connect: function () { return fetch("./tool-call", { method: "POST" }); } };
})();
</script><title>Session Chat</title></head>
<body><div id="root"></div><script type="module">fetch("http://127.0.0.1:18790/sessions")</script></body>
</html>`

type Transform = (html: string, url: string, token: string) => string

const transform = new Function(`${blobEmbedScript()}\nreturn transformChatHtmlForBlob;`)() as Transform

/** The shim `<script>` the transform injects (the first script after <base>). */
function injectedShimSource(out: string): string {
  const start = out.indexOf("<script>", out.indexOf("<base "))
  const end = out.indexOf("</script>", start)
  return out.slice(start + "<script>".length, end)
}

describe("blobEmbedScript / transformChatHtmlForBlob", () => {
  it("compiles as valid JavaScript", () => {
    expect(() => new Function(blobEmbedScript())).not.toThrow()
  })

  it("injects <base href=deep-link> right after <head>, attribute-escaped", () => {
    const out = transform(SERVED_HTML, URL_, TOKEN)
    const head = out.indexOf("<head>") + "<head>".length
    expect(out.slice(head)).toMatch(
      /^<base href="http:\/\/127\.0\.0\.1:18790\/apps\/@agentik\/session-chat\/ui\?session=sess_1&amp;embed=1">/,
    )
    // The base is the document url itself, never `…/ui/` (a trailing slash
    // would make `./tool-call` resolve to `…/ui/tool-call`).
    expect(out).not.toContain('/ui/"')
  })

  it("rewrites the standalone bridge's ./tool-call to the absolute tokened url", () => {
    const out = transform(SERVED_HTML, URL_, TOKEN)
    expect(out).not.toContain('fetch("./tool-call"')
    expect(out).toContain(
      'fetch("http://127.0.0.1:18790/apps/@agentik/session-chat/tool-call?et=tok_per_boot", { method: "POST" })',
    )
  })

  it("leaves the app's own scripts and markup untouched", () => {
    const out = transform(SERVED_HTML, URL_, TOKEN)
    expect(out).toContain('<div id="root"></div>')
    expect(out).toContain('<script type="module">fetch("http://127.0.0.1:18790/sessions")</script>')
  })

  it("prepends the base + shim when the document has no <head>", () => {
    const out = transform("<div>bare</div>", URL_, TOKEN)
    expect(out.startsWith('<base href="')).toBe(true)
    expect(out.endsWith("<div>bare</div>")).toBe(true)
  })

  it("adds no CSP meta — the blob document inherits its creator's CSP regardless", () => {
    expect(transform(SERVED_HTML, URL_, TOKEN)).not.toMatch(/http-equiv=["']?Content-Security-Policy/i)
  })

  describe("the injected shim, run against a stub window", () => {
    function runShim(url = URL_) {
      const out = transform(SERVED_HTML, url, TOKEN)
      const src = injectedShimSource(out)
      const inner = vi.fn<(input: unknown, init?: unknown) => Promise<Response>>(
        async () => new Response("ok"),
      )
      const postMessage = vi.fn<(msg: unknown, target: string) => void>()
      const win: Record<string, unknown> = { fetch: inner, parent: { postMessage } }
      new Function("window", "document", src)(win, { baseURI: url })
      return { win, inner, postMessage }
    }

    it("posts the boot ack to its parent FIRST, so a CSP-killed script is detectable by its absence", () => {
      const out = transform(SERVED_HTML, URL_, TOKEN)
      const src = injectedShimSource(out)
      expect(src.indexOf("postMessage")).toBeLessThan(src.indexOf("window.fetch"))
      const { postMessage } = runShim()
      expect(postMessage).toHaveBeenCalledWith({ type: BLOB_BOOT_MESSAGE_TYPE }, "*")
      expect(BLOB_BOOT_MESSAGE_TYPE).toBe("agentproto-blob-boot")
    })

    it("points __AGENTPROTO_BASEURL__ at the deep link's daemon origin (non-default ports work)", () => {
      const { win } = runShim("http://127.0.0.1:19999/apps/@agentik/session-chat/ui?embed=1")
      expect(win.__AGENTPROTO_BASEURL__).toBe("http://127.0.0.1:19999")
    })

    it("appends et= to absolute daemon-origin requests (the app's /mcp, /sessions, SSE fetches)", async () => {
      const { win, inner } = runShim()
      const fetch = win.fetch as (i: unknown, init?: unknown) => Promise<unknown>
      await fetch("http://127.0.0.1:18790/mcp", { method: "POST" })
      await fetch("http://127.0.0.1:18790/sessions/sess_1/events/stream?since=0")
      expect(inner.mock.calls.map(c => c[0])).toEqual([
        "http://127.0.0.1:18790/mcp?et=tok_per_boot",
        "http://127.0.0.1:18790/sessions/sess_1/events/stream?since=0&et=tok_per_boot",
      ])
      // Init is passed through untouched.
      expect(inner.mock.calls[0]![1]).toEqual({ method: "POST" })
    })

    it("resolves relative urls against the document base before tokening them", async () => {
      const { win, inner } = runShim()
      await (win.fetch as (i: unknown) => Promise<unknown>)("./tool-call")
      expect(inner.mock.calls[0]![0]).toBe(
        "http://127.0.0.1:18790/apps/@agentik/session-chat/tool-call?et=tok_per_boot",
      )
    })

    it("never leaks the token to another origin, and never doubles it", async () => {
      const { win, inner } = runShim()
      const fetch = win.fetch as (i: unknown) => Promise<unknown>
      await fetch("https://other.example/api")
      await fetch("http://127.0.0.1:18790/mcp?et=already")
      expect(inner.mock.calls.map(c => c[0])).toEqual([
        "https://other.example/api",
        "http://127.0.0.1:18790/mcp?et=already",
      ])
    })

    it("tokens a Request-object input too", async () => {
      const { win, inner } = runShim()
      await (win.fetch as (i: unknown) => Promise<unknown>)(
        new Request("http://127.0.0.1:18790/sessions", { method: "GET" }),
      )
      const passed = inner.mock.calls[0]![0] as Request
      expect(passed).toBeInstanceOf(Request)
      expect(passed.url).toBe("http://127.0.0.1:18790/sessions?et=tok_per_boot")
    })
  })
})
