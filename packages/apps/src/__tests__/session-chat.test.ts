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
    expect(html).toContain('src="http://127.0.0.1:18790/apps/@agentik/session-chat/ui?session=s1&amp;embed=1"')
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

  it("the embed page escapes the sessionId in the iframe src attribute", () => {
    const html = sessionChatEmbedHtml({
      installed: true,
      url: 'http://127.0.0.1:18790/apps/@agentik/session-chat/ui?session=x"&embed=1',
    })
    expect(html).toContain('src="http://127.0.0.1:18790/apps/@agentik/session-chat/ui?session=x&quot;&amp;embed=1"')
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
