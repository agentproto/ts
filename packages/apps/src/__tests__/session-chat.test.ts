import { describe, it, expect, vi } from "vitest"
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
    // CSP: frame AND connect to the daemon origin only (the standalone app
    // host — framed by the direct mount, fetched by the blob pass-through).
    expect(app.csp?.frameDomains).toEqual(["http://127.0.0.1:18790"])
    expect(app.csp?.connectDomains).toEqual(["http://127.0.0.1:18790"])
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

  // A host-cached widget (Claude Desktop keeps a conversation's srcdoc)
  // replays the embed token baked in at render time, which dies with that
  // daemon boot — so every result ships a live one for the panel to adopt.
  it("ships a live embed token with each installed result", async () => {
    const app = makeSessionChatApp({
      httpBaseUrl: "http://127.0.0.1:18790",
      isSessionChatInstalled: () => true,
      mintEmbedToken: () => "tok_live",
    })
    expect(await app.execute!({ sessionId: "sess_abc" })).toEqual({
      installed: true,
      url: "http://127.0.0.1:18790/apps/@agentik/session-chat/ui?session=sess_abc&embed=1",
      embedToken: "tok_live",
    })
  })

  it("mints no token when there is no deep link to authorize", async () => {
    const mintEmbedToken = vi.fn(() => "tok_live")
    const app = makeSessionChatApp({
      httpBaseUrl: "http://127.0.0.1:18790",
      isSessionChatInstalled: () => false,
      mintEmbedToken,
    })
    expect(await app.execute!({})).toEqual({ installed: false, url: null })
    expect(mintEmbedToken).not.toHaveBeenCalled()
  })

  it("omits embedToken entirely when the host supplies no minter", async () => {
    const app = makeSessionChatApp({
      httpBaseUrl: "http://127.0.0.1:18790",
      isSessionChatInstalled: () => true,
    })
    expect(await app.execute!({})).not.toHaveProperty("embedToken")
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
    // The baked url goes through the same blob-first mount() as a pushed
    // one, never as an inline src.
    expect(html).toContain("mount(bootUrl)")
    expect(html).not.toMatch(/<iframe[^>]*\ssrc=/)
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
    // The deep-linked mounts (and only they — the open-in-tab link stays
    // token-free) go through the token: the blob fetch and the direct frame.
    expect(html).toContain("var tokened = withEmbedToken(url)")
    expect(html).toContain("fetch(tokened, { credentials: 'omit' })")
    expect(html).toContain("frame.src = withEmbedToken(url)")
    expect(html).toContain("'<a href=\"' + escapeHtml(url) + '\" target=\"_blank\"")
  })

  it("mounts the chat as a blob: document first (host frame-src 'self' blob: data:), direct frame as the fallback", () => {
    const html = sessionChatEmbedHtml({})
    // The shared transform is embedded, and the fetched html goes through it.
    expect(html).toContain("function transformChatHtmlForBlob(html, url, token)")
    expect(html).toContain("transformChatHtmlForBlob(html, url, window.__AGENPROTO_EMBED_TOKEN__)")
    expect(html).toContain("URL.createObjectURL(new Blob([doc], { type: 'text/html' }))")
    expect(html).toContain("frame.src = blobUrl")
    // Object-url lifecycle: revoked on re-mount / not-installed / fallback.
    expect(html).toContain("URL.revokeObjectURL(blobUrl)")
    expect(html.match(/revokeBlob\(\)/g)!.length).toBeGreaterThanOrEqual(3)
    // Boot ack probe: the blob document must announce itself or the panel
    // falls back to the direct frame (whose block probe ends on the card).
    expect(html).toContain("d.type !== \"agentproto-blob-boot\"")
    expect(html).toContain("evt.source !== frame.contentWindow")
    expect(html).toContain("armBlobBootProbe(frame, url, gen)")
    // Both failure modes (fetch refused, no boot ack) land on mountDirect.
    expect(html.match(/mountDirect\(url\)/g)!.length).toBeGreaterThanOrEqual(3)
    // No token baked (standalone tab / VS Code) ⇒ no blob attempt at all.
    expect(html).toContain("if (tokened === url) {")
    // Still no vendored chat machinery.
    expect(html).not.toContain("conversation_read")
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
    // The anchor is the fallback for hosts without the capability; hosts
    // that advertise hostCapabilities.openLinks route through the bridge's
    // host-mediated ui/open-link instead (a plain click is a no-op in a
    // sandboxed widget iframe without allow-popups).
    expect(html).toContain('<a id="card-open" href="#" target="_blank" rel="noreferrer">Open chat</a>')
    expect(html).toContain("getHostCapabilities().openLinks")
    expect(html).toContain("openLink(cardUrl)")
    // The bridge script is embedded inline, so it must expose the getter
    // the card CTA depends on.
    expect(html).toContain("getHostCapabilities")
  })

  it("re-checks the frame before removing it when the block-probe settle window closes (no false positive on a slow load)", () => {
    const html = sessionChatEmbedHtml({})
    // The settle timeout must re-read the frame's location instead of
    // unconditionally removing it — a legitimately slow (not blocked) load
    // that lands its `load` event mid-window must not get torn down.
    expect(html).toContain("settle = setTimeout(function () {")
    expect(html).toContain("if (isBlank(frame)) frame.remove();")
  })

  it("adopts a result's live embed token before mounting, so a host-cached widget re-arms after a daemon restart", () => {
    const html = sessionChatEmbedHtml({})
    // The refresh overwrites the token the bridge script baked in...
    expect(html).toContain("window.__AGENPROTO_EMBED_TOKEN__ = body.embedToken;")
    // ...but only for a render that WAS baked: a standalone tab / VS Code
    // HTTP-iframe panel keeps the literal placeholder (it already passes
    // the daemon's origin checks, and a token would push it onto the blob
    // path for nothing).
    expect(html).toContain("if (!cur || cur === '__AGENPROTO_EMBED_TOKEN__') return;")
    // Adopted on every path that can carry a token, always before mount().
    expect(html).toContain("adoptEmbedToken(out);")
    expect(html).toContain("adoptEmbedToken(body);")
    expect(html).toContain("adoptEmbedToken(window.__APP_INIT__);")
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

  it("allowlists session_restart, so an ended session is restartable from the chat", () => {
    // `app_tool_call` refuses anything outside `ui.tools`, so dropping this
    // entry would silently turn the chat's "Restart session" affordance into
    // an allowlist error at click time.
    expect(sessionChatApp.ui?.tools).toContain("session_restart")
  })

  it("keeps the read path (session list + transcript) and spawn in the allowlist", () => {
    expect(sessionChatApp.ui?.tools).toEqual(
      expect.arrayContaining([
        "session_list",
        "agent_start",
        "adapter_list",
        "conversation_read",
      ]),
    )
  })
})
