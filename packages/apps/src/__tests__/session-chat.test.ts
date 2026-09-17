import { describe, it, expect } from "vitest"
import {
  makeSessionChatApp,
  sessionChatApp,
  sessionChatAppUrl,
  SESSION_CHAT_APP_ID,
  SESSION_CHAT_FALLBACK_HTML,
  sessionChatEmbedHtml,
} from "../session-chat/index.js"

describe("sessionChatAppUrl", () => {
  it("builds the standalone app-host deep link with session + embed params", () => {
    expect(sessionChatAppUrl("http://127.0.0.1:18790", "sess_abc")).toBe(
      "http://127.0.0.1:18790/apps/@agentik/session-chat/ui?session=sess_abc&embed=1",
    )
  })

  it("omits the session param when no sessionId is given (picker view)", () => {
    expect(sessionChatAppUrl("http://127.0.0.1:18790")).toBe(
      "http://127.0.0.1:18790/apps/@agentik/session-chat/ui?embed=1",
    )
  })

  it("encodes special characters in the sessionId", () => {
    expect(sessionChatAppUrl("http://127.0.0.1:18790", "sess a&b")).toContain(
      "session=sess+a%26b",
    )
  })

  it("strips trailing slashes from the base url", () => {
    expect(sessionChatAppUrl("http://127.0.0.1:18790/", "s1")).toBe(
      "http://127.0.0.1:18790/apps/@agentik/session-chat/ui?session=s1&embed=1",
    )
  })
})

describe("makeSessionChatApp", () => {
  it("exposes the builtin tool metadata and catalog identity", () => {
    const app = makeSessionChatApp({
      httpBaseUrl: "http://127.0.0.1:18790",
      isSessionChatInstalled: () => true,
    })
    expect(app.id).toBe("agentproto_session_chat")
    expect(app.title).toBe("Session Chat")
    expect(app.inputSchema.shape.sessionId).toBeDefined()
    // sessionId is optional — omitting it opens the app's session picker.
    expect(app.inputSchema.safeParse({}).success).toBe(true)
    // CSP: frame the daemon origin only (the standalone app host).
    expect(app.csp?.frameDomains).toEqual(["http://127.0.0.1:18790"])
  })

  it("resolves sessionId -> deep-link url when the app is installed", async () => {
    const app = makeSessionChatApp({
      httpBaseUrl: "http://127.0.0.1:18790",
      isSessionChatInstalled: () => true,
    })
    const out = await app.execute!({ sessionId: "sess_abc" })
    expect(out).toEqual({
      installed: true,
      url: "http://127.0.0.1:18790/apps/@agentik/session-chat/ui?session=sess_abc&embed=1",
    })
  })

  it("returns installed: false / url: null when the app is missing", async () => {
    const app = makeSessionChatApp({
      httpBaseUrl: "http://127.0.0.1:18790",
      isSessionChatInstalled: () => false,
    })
    const out = await app.execute!({})
    expect(out).toEqual({ installed: false, url: null })
  })

  it("treats a missing installed-check as not installed", async () => {
    const app = makeSessionChatApp({ httpBaseUrl: "http://127.0.0.1:18790" })
    expect(await app.execute!({})).toEqual({ installed: false, url: null })
  })

  it("renders the thin iframe page with the deep link when installed", () => {
    const app = makeSessionChatApp({
      httpBaseUrl: "http://127.0.0.1:18790",
      isSessionChatInstalled: () => true,
    })
    const html = (app.html as (init: { installed: boolean; url: string | null }) => string)({
      installed: true,
      url: "http://127.0.0.1:18790/apps/@agentik/session-chat/ui?session=s1&embed=1",
    })
    expect(html).toContain('<iframe id="chat" title="Session Chat"></iframe>')
    // The url mounts through the embed token, never as an inline src.
    expect(html).toContain("frame.src = withEmbedToken(mountedUrl)")
    expect(html).toContain("open in a tab")
    // No vendored chat UI — the page must not carry chat machinery.
    expect(html).not.toContain("conversation_read")
  })

  it("renders no iframe when not installed", () => {
    const app = makeSessionChatApp({
      httpBaseUrl: "http://127.0.0.1:18790",
      isSessionChatInstalled: () => false,
    })
    const html = (app.html as (init: { installed: boolean; url: string | null }) => string)({
      installed: false,
      url: null,
    })
    expect(html).not.toContain("<iframe")
    expect(html).toContain("app not installed")
  })

  it("the fallback notice points at the install command, not a reimplemented UI", () => {
    expect(SESSION_CHAT_FALLBACK_HTML).toContain("agentproto app install @agentik/session-chat")
    expect(SESSION_CHAT_FALLBACK_HTML).not.toContain("<iframe")
  })

  it("the embed page escapes the sessionId in the payload and the href attribute", () => {
    const html = sessionChatEmbedHtml({
      installed: true,
      url: 'http://127.0.0.1:18790/apps/@agentik/session-chat/ui?session=x"&embed=1',
    })
    // The url travels as JSON in __APP_INIT__ (raw quote escaped) and in the
    // escaped href attribute — never as an unescaped attribute value.
    expect(html).not.toContain('session=x"')
    expect(html).toContain("&quot;")
  })

  it("the static ui:// render (empty initData) self-bootstraps over the bridge and consumes agent_start's result", () => {
    // registerMcpApps renders the resource ONCE with `{}` — the page must
    // not bake a decision in: no iframe, no notice, a spec-correct bridge
    // handshake, and the tool-result hook that pins the spawned session.
    const html = sessionChatEmbedHtml({})
    expect(html).not.toContain("<iframe")
    expect(html).not.toContain('id="notice" class="show"')
    expect(html).toContain("appInfo")
    expect(html).not.toContain("clientInfo")
    expect(html).toContain("ui/notifications/tool-result")
    expect(html).toContain("extractToolResultSessionId")
    // agent_start's result is a session descriptor (`id`); the widget turns
    // it into the deep link by calling its own tool over the bridge.
    expect(html).toContain("callTool('agentproto_session_chat'")
    expect(html).toContain("window.__APP_INIT__ = {}")
    // Still no vendored chat machinery.
    expect(html).not.toContain("conversation_read")
  })

  it("mounts the iframe through the per-boot embed token (opaque MCP-Apps hosts pass no origin check)", () => {
    const html = sessionChatEmbedHtml({})
    // The placeholder rides in the shared bridge script; registerMcpApps
    // bakes a real token over it when serving the resource.
    expect(html).toContain('window.__AGENPROTO_EMBED_TOKEN__ = "__AGENPROTO_EMBED_TOKEN__"')
    expect(html).toContain("function withEmbedToken(url)")
    // The deep-linked mount (and only it — the open-in-tab link stays
    // token-free) goes through the token.
    expect(html).toContain("frame.src = withEmbedToken(url)")
    // With a baked token the mounted url gains `et=`.
    const baked = sessionChatEmbedHtml({ installed: true, url: "http://127.0.0.1:18790/apps/x/ui?embed=1" })
    expect(baked).toContain("frame.src = withEmbedToken(url)")
  })

  it("degrades to an inline launcher card when the host refuses the frame", () => {
    const html = sessionChatEmbedHtml({})
    // The card is the default surface; the iframe mounts OVER it and is
    // removed by the block probe when a host CSP (Claude Desktop / Codex:
    // frame-src 'self' blob: data:, csp.frameDomains not yet merged) refuses it.
    expect(html).toContain('<div id="card">')
    expect(html).toContain('id="card-open"')
    expect(html).toContain("armBlockProbe(frame)")
    expect(html).toContain("frame.contentWindow.location.href === 'about:blank'")
    // The card routes its CTA through the spec's ui/open-link when the host
    // advertises it, falling back to the anchor.
    expect(html).toContain("openLink(cardUrl)")
  })

  it("the not-installed render shows the notice inline and still carries the bridge", () => {
    const html = sessionChatEmbedHtml({ installed: false, url: null })
    expect(html).toContain('id="notice" class="show"')
    expect(html).toContain("agentproto app install @agentik/session-chat")
    expect(html).toContain("ui/notifications/tool-result")
  })
})

describe("sessionChatApp (AppHandle / catalog path)", () => {
  it("is a zero-agent UI-only app whose static ui.html is the fallback notice", () => {
    expect(sessionChatApp.id).toBe("@agentproto/session-chat-widget")
    expect(sessionChatApp.agents).toEqual([])
    expect(sessionChatApp.ui?.html).toBe(SESSION_CHAT_FALLBACK_HTML)
    expect(sessionChatApp.ui?.title).toBe("Session Chat")
  })

  it("keeps SESSION_CHAT_APP_ID pointed at the installed studio app", () => {
    expect(SESSION_CHAT_APP_ID).toBe("@agentik/session-chat")
  })
})
