/**
 * Real-DOM coverage for the App Store panel — the built `STORE_HTML` loaded
 * through jsdom with `runScripts: "dangerously"`, a fake `window.McpApp`
 * bridge standing in for the daemon so `panel-bridge.ts` takes its
 * standalone code path (same technique as review-panel-actions.dom.test.ts;
 * a builtin panel is never an installed app, so `app_tool_call` can't route
 * for it — the fake bridge records the exact tool/args pairs).
 *
 * Covers what S6's brief requires of the panel itself: a render with NO
 * catalog and NO installs is never a blank page, the Install button calls
 * `app_install` with the catalog entry's OWN sha (bundle) / git fields, the
 * Update-available badge renders from `app_updates`, and the
 * ?install=<appId> deep link opens the entry's confirmation.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { JSDOM } from "jsdom"
import type { DomWindow } from "jsdom"
import { STORE_HTML } from "../store/panel.js"
import { STORE_UI_TOOLS, STORE_APP_ID, STORE_TOOL_ID } from "../store/panel.js"

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: true }
interface ToolCall {
  tool: string
  args: Record<string, unknown>
}
type ToolHandler = (args: Record<string, unknown>) => unknown

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] }
}

const CATALOG_ENTRY = {
  appId: "@acme/greeter",
  name: "Greeter",
  description: "Says hello",
  category: "utilities",
  source: { kind: "agentapp", url: "https://x.test/greeter.agentapp", sha256: "e".repeat(64), version: "1.0.0" },
  version: "1.0.0",
  tier: "bundle",
  origin: "default",
  catalogUrl: "https://x.test/catalog.json",
  installed: false,
  hasUi: true,
}

/** What POST /apps/:id/tool-call really answers for a builtin tool — the
 *  already-wrapped result wrapped a second time (runtime app-tools.ts). */
function okDoubleWrapped(data: unknown): ToolResult {
  return ok(ok(data))
}

const BUILTIN_ROWS = [
  { appId: "@agentproto/review-panel", name: "Reviews", description: "PR review ledger", category: "builtin", installed: true, hasUi: true },
  { appId: "@agentproto/session-chat-widget", name: "Session Chat", description: "Chat widget", category: "builtin", installed: true, hasUi: true },
  { appId: "@agentproto/store", name: "App Store", description: "This panel", category: "builtin", installed: true, hasUi: true },
]

const BASE_HANDLERS: Record<string, ToolHandler> = {
  app_catalog: () => ok([CATALOG_ENTRY]),
  app_list: () =>
    ok([
      {
        appId: "@acme/greeter",
        name: "Greeter",
        version: "0.9.0",
        dir: "/apps/greeter",
        source: { kind: "agentapp", url: "https://x.test/greeter-old.agentapp", sha256: "f".repeat(64), version: "0.9.0" },
      },
    ]),
  app_updates: () =>
    ok([{ appId: "@acme/greeter", catalogUrl: "https://x.test/catalog.json", from: { sha256: "f".repeat(64) }, to: { sha256: "e".repeat(64) } }]),
  app_install: () => {
    throw new Error("app_install must not be called without a confirm flow")
  },
  app_resync: () => ok({ appId: "@acme/greeter", changed: true, from: "f", to: "e" }),
  app_uninstall: () => ok({ appId: "@acme/greeter" }),
}

const openWindows: DomWindow[] = []

/** jsdom's `DomWindow` type doesn't name every constructor/value the tests
 *  install BEFORE the panel script runs (confirm/CSS/McpApp/MouseEvent) —
 *  an intersection (not an `interface extends`, which is strictly checked)
 *  names them for both the `beforeParse` setup and the click helper. */
type TestWindow = DomWindow & {
  confirm: (message?: string) => boolean
  open: (url?: string) => unknown
  CSS: { escape: (css: string) => string }
  McpApp: unknown
  MouseEvent: new (type: string, init?: { bubbles?: boolean }) => Event
}

function testWindow(window: DomWindow): TestWindow {
  return window as unknown as TestWindow
}

function renderPanel(options: { handlers?: Record<string, ToolHandler>; url?: string } = {}) {
  const calls: ToolCall[] = []
  const handlers = { ...BASE_HANDLERS, ...options.handlers }
  const dom = new JSDOM(STORE_HTML, {
    runScripts: "dangerously",
    url: options.url ?? "https://example.test/apps/%40agentproto%2Fstore/ui",
    beforeParse(window) {
      const w = testWindow(window)
      w.confirm = vi.fn(() => true)
      w.open = vi.fn(() => null)
      w.CSS = { escape: (s: string) => s.replace(/([^a-zA-Z0-9_-])/g, "\\$1") }
      w.McpApp = {
        connect: () =>
          Promise.resolve({
            callTool: (name: string, args: Record<string, unknown>) => {
              calls.push({ tool: name, args })
              const handler = handlers[name]
              if (!handler) return Promise.resolve({ content: [{ type: "text", text: "unknown tool" }], isError: true })
              const out = handler(args)
              return Promise.resolve(out as ToolResult)
            },
            updateModelContext: () => Promise.resolve(),
            openLink: () => Promise.resolve(),
            onTeardown: () => {},
          }),
      }
    },
  })
  openWindows.push(dom.window)
  return { window: testWindow(dom.window), calls, document: dom.window.document }
}

async function settle(ms = 60): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function click(window: TestWindow, selector: string): void {
  const el = window.document.querySelector(selector)
  if (!el) throw new Error(`${selector} not found`)
  el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
}

afterEach(() => {
  while (openWindows.length) openWindows.pop()!.close()
  vi.restoreAllMocks()
})

describe("store panel — render (real panel script, fake bridge)", () => {
  it("never renders a blank page without a catalog or installs — the empty state names the way out", async () => {
    const { window, calls } = renderPanel({
      handlers: { app_catalog: () => ok([]), app_list: () => ok([]), app_updates: () => ok([]) },
    })
    await settle()
    expect(calls.map(c => c.tool)).toEqual(["app_catalog", "app_list", "app_updates"])
    const document = window.document
    expect(document.getElementById("content")!.innerHTML).toContain("store-empty")
    expect(document.getElementById("content")!.innerHTML).toContain("store-empty-hint")
    // The Install-from-URL form is static html, wired at boot — present and
    // reachable from the empty state's hint even with nothing installed.
    expect(document.getElementById("store-url")).toBeTruthy()
    expect(document.getElementById("store-install-from-url-btn")).toBeTruthy()
  })

  it("renders the installed shelf with version/source and the Update-available badge", async () => {
    const { window } = renderPanel()
    await settle()
    const html = window.document.getElementById("content")!.innerHTML
    expect(html).toContain("Greeter")
    expect(html).toContain("0.9.0")
    expect(html).toContain("Update available")
    expect(html).toContain("agentapp")
  })

  it("the catalog Install button calls app_install with the entry's OWN sha256 (url + sha256 + catalogUrl)", async () => {
    const confirmed: ToolCall[] = []
    const { window, calls } = renderPanel({
      handlers: {
        app_install: args => {
          confirmed.push({ tool: "app_install", args })
          if (typeof args.confirm !== "string") {
            return ok({ needsConfirmation: true, confirm: "tok-" + args.url, kind: "agentapp", url: args.url, sha256: "e".repeat(64), runsBuildCommand: false })
          }
          return ok({ appId: "@acme/greeter" })
        },
      },
    })
    await settle()
    calls.length = 0
    click(window, '#store-entry-\\@acme\\/greeter button[data-decision="install"]')
    await settle(100)
    expect(confirmed).toHaveLength(2)
    expect(confirmed[0]!.args).toEqual({ url: CATALOG_ENTRY.source.url, sha256: CATALOG_ENTRY.source.sha256, catalogUrl: CATALOG_ENTRY.catalogUrl })
    expect(confirmed[1]!.args.confirm).toBe("tok-" + CATALOG_ENTRY.source.url)
  })

  it("Uninstall asks for confirmation, then calls app_uninstall {appId}", async () => {
    const { window, calls } = renderPanel()
    await settle()
    calls.length = 0
    click(window, '#store-entry-\\@acme\\/greeter button[data-decision="uninstall"]')
    await settle(100)
    expect(window.confirm).toHaveBeenCalled()
    const c = calls.find(x => x.tool === "app_uninstall")
    expect(c?.args).toEqual({ appId: "@acme/greeter" })
  })

  it("Update calls app_resync {appId}", async () => {
    const { window, calls } = renderPanel()
    await settle()
    calls.length = 0
    click(window, '#store-entry-\\@acme\\/greeter button[data-decision="resync"]')
    await settle(100)
    const c = calls.find(x => x.tool === "app_resync")
    expect(c?.args).toEqual({ appId: "@acme/greeter" })
  })

  it("?install=<appId> deep-links: scrolls to and confirms the entry's install", async () => {
    MarkerProbe: {
    const { window, calls } = renderPanel({
      url: "https://example.test/apps/%40agentproto%2Fstore/ui?install=%40acme/greeter",
      handlers: {
        app_install: args => {
          if (typeof args.confirm !== "string") {
            return ok({ needsConfirmation: true, confirm: "tok", kind: "agentapp", url: args.url, runsBuildCommand: false })
          }
          return ok({ appId: "@acme/greeter" })
        },
      },
    })
    await settle(120)
    const installs = calls.filter(c => c.tool === "app_install")
    expect(installs.length).toBe(2)
    expect(installs[0]!.args.url).toBe(CATALOG_ENTRY.source.url)
    }
  })
})

describe("store panel — standalone double-wrapped results, builtins, status", () => {
  const CHAT = { appId: "@agentik/session-chat", name: "Session Chat", installed: true, hasUi: true }
  const NO_UI = { appId: "@agentproto/code-team", name: "Code Team", installed: true, hasUi: false }
  const standalone = {
    app_catalog: () => okDoubleWrapped([...BUILTIN_ROWS, CHAT, NO_UI, CATALOG_ENTRY, { ...CATALOG_ENTRY, appId: "@acme/other", name: "Other" }]),
    app_list: () => okDoubleWrapped([{ appId: CHAT.appId, name: CHAT.name }, { appId: NO_UI.appId, name: NO_UI.name }]),
    app_updates: () => okDoubleWrapped([]),
  }

  it("renders from double-wrapped envelopes instead of the empty state", async () => {
    const { window } = renderPanel({ handlers: standalone })
    await settle()
    const html = window.document.getElementById("content")!.innerHTML
    expect(html).not.toContain("store-empty")
    expect(html).toContain("Installed")
    expect(html).toContain("Available")
    expect(html).toContain("Greeter")
  })

  it("lists builtin panels from the catalog (open by default), skipping the store itself", async () => {
    const { window, document } = renderPanel({ handlers: standalone })
    await settle()
    const details = document.querySelector("details.store-builtins")!
    expect(details.getAttribute("open")).not.toBeNull()
    const ids = Array.from(details.querySelectorAll("button[data-decision=open]")).map(b => b.getAttribute("data-appid"))
    expect(ids).toEqual(["@agentproto/review-panel", "@agentproto/session-chat-widget"])
    expect(details.textContent).toContain("PR review ledger")
    // Builtin rows never leak into Available/Featured.
    const main = document.getElementById("content")!.innerHTML.split("<details")[0]!
    expect(main).not.toContain("@agentproto/review-panel")
    void window
  })

  it("a builtin's Open button opens /apps/<appId>/ui in a new tab", async () => {
    const { window } = renderPanel({ handlers: standalone })
    await settle()
    click(window, 'button[data-decision="open"][data-appid="@agentproto/review-panel"]')
    expect(window.open).toHaveBeenCalledWith("/apps/@agentproto/review-panel/ui", "_blank", "noopener")
  })

  it("builtin-only catalog still shows the empty state, plus the builtin list", async () => {
    const { document } = renderPanel({
      handlers: { app_catalog: () => okDoubleWrapped(BUILTIN_ROWS), app_list: () => okDoubleWrapped([]), app_updates: () => okDoubleWrapped([]) },
    })
    await settle()
    const html = document.getElementById("content")!.innerHTML
    expect(html).toContain("store-empty")
    expect(html).toContain("store-builtin-item")
  })

  it("Open shows on installed cards whose catalog row hasUi, and only those", async () => {
    const { document } = renderPanel({ handlers: standalone })
    await settle()
    expect(document.querySelector('#store-entry-\\@agentik\\/session-chat button[data-decision="open"]')).toBeTruthy()
    expect(document.querySelector('#store-entry-\\@agentproto\\/code-team button[data-decision="open"]')).toBeNull()
  })

  it("replaces 'Connecting to bridge…' with installed/available/builtin counts", async () => {
    const { document } = renderPanel({ handlers: standalone })
    await settle()
    expect(document.getElementById("statusbar")!.textContent).toBe("2 installed · 2 available · 3 builtin")
  })
})

describe("STORE app identity", () => {
  it("names the builtin per the convention of the other panels", () => {
    expect(STORE_APP_ID).toBe("@agentproto/store")
    expect(STORE_TOOL_ID).toBe("agentproto_store")
    expect(STORE_UI_TOOLS).toEqual([
      "app_catalog",
      "app_list",
      "app_install",
      "app_resync",
      "app_updates",
      "app_uninstall",
      "app_status",
    ])
  })
})
