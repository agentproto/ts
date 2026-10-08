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
  Event: new (type: string, init?: { bubbles?: boolean }) => Event
  location: { search: string }
  history: { back: () => void; pushState: unknown; replaceState: unknown }
  navigator: object
  getSelection: () => { toString: () => string } | null
}

type PanelDocument = ReturnType<typeof renderPanel>["document"]
type FormEl = { hidden: boolean; value: string; dispatchEvent: (e: unknown) => boolean }

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

describe("store panel — detail view, copy block, icons, search", () => {
  const SHA = "e".repeat(64)
  const REMOTE = {
    appId: "@acme/greeter",
    name: "Greeter",
    description: "Says hello to everyone.\nSecond line.",
    category: "utilities",
    source: { kind: "agentapp", url: "https://x.test/greeter.agentapp", sha256: SHA, version: "1.0.0", size: 2_500_000 },
    version: "1.0.0",
    tier: "bundle",
    publisher: "Acme Inc",
    license: { kind: "free", url: "https://x.test/license" },
    icon: "https://x.test/greeter.png",
    requires: { agentprotoVersion: ">=0.20.0", apps: ["@acme/base"], agents: ["planner"] },
    origin: "default",
    catalogUrl: "https://x.test/catalog.json",
    stale: true,
    installed: false,
    hasUi: true,
  }
  const GIT = {
    appId: "@acme/gitty",
    name: "Gitty",
    description: "From git",
    category: "dev",
    source: { kind: "git", url: "https://github.com/acme/it's repo", ref: "main", subdir: "apps/gitty", sha: "abc123" },
    tier: "git",
    publisher: "Acme Inc",
    icon: "javascript:alert(1)",
    catalogUrl: "https://x.test/catalog.json",
    installed: false,
  }
  const LOCAL = { appId: "@me/local", name: "Local Thing", description: "A local dir app", category: "utilities", installed: true, hasUi: true }
  const INSTALLED = {
    appId: "@acme/greeter",
    name: "Greeter",
    version: "0.9.0",
    description: "Says hello",
    dir: "/apps/greeter",
    dataDir: "/data/greeter",
    dirMissing: true,
    source: { kind: "agentapp", url: "https://x.test/greeter-old.agentapp", sha256: "f".repeat(64), version: "0.9.0" },
    agents: ["greeter-agent", "helper-agent"],
    workflows: ["greet-flow"],
    requires: ["@acme/base", "@acme/other"],
    runs: Array.from({ length: 12 }, (_, i) => ({
      appRunId: "run-" + i,
      status: i === 11 ? "failed" : "completed",
      startedAt: `2026-10-0${1 + (i % 9)}T10:00:00.000Z`,
      endedAt: i === 0 ? undefined : `2026-10-0${1 + (i % 9)}T10:01:05.000Z`,
      harness: "claude-code",
      model: "sonnet",
      sessions: 1,
    })),
  }
  const INSTALLED_LOCAL = { appId: LOCAL.appId, name: LOCAL.name, dir: "/x/local", source: { kind: "local" } }
  const BUILTIN = { appId: "@agentproto/review-panel", name: "Reviews", description: "PR review ledger", category: "builtin", installed: true, hasUi: true, toolId: "agentproto_reviews", resourceUri: "ui://agentproto_reviews/view" }
  const handlers: Record<string, ToolHandler> = {
    app_catalog: () => ok([REMOTE, GIT, LOCAL, BUILTIN, { appId: "@agentproto/store", name: "App Store", category: "builtin", installed: true, hasUi: true }]),
    app_list: () => ok([INSTALLED, INSTALLED_LOCAL]),
    app_updates: () => ok([{ appId: "@acme/greeter" }]),
  }
  const BASE = "https://example.test/apps/%40agentproto%2Fstore/ui"
  const nothingInstalledRemote = { ...handlers, app_list: () => ok([INSTALLED_LOCAL]), app_updates: () => ok([]) }

  function installHandler(log: ToolCall[]): ToolHandler {
    return args => {
      log.push({ tool: "app_install", args })
      if (typeof args.confirm !== "string") {
        return ok({ needsConfirmation: true, confirm: "tok", kind: "agentapp", url: args.url, runsBuildCommand: false })
      }
      return ok({ appId: "@acme/greeter" })
    }
  }

  function text(document: PanelDocument, sel: string): string {
    return document.querySelector(sel)?.textContent ?? ""
  }

  function copyTexts(document: PanelDocument): string[] {
    return Array.from(document.querySelectorAll(".store-copy-text")).map(e => (e as { textContent: string | null }).textContent ?? "")
  }

  it("clicking a card title opens the detail view (?app=), Back returns, browser back works", async () => {
    const { window, document } = renderPanel({ handlers })
    await settle()
    expect(document.querySelector(".store-detail")).toBeNull()
    click(window, '#store-entry-\\@acme\\/gitty a.store-app-link')
    expect(document.querySelector(".store-detail")).toBeTruthy()
    expect(window.location.search).toBe("?app=%40acme%2Fgitty")
    expect((document.getElementById("store-filter") as unknown as FormEl).hidden).toBe(true)
    click(window, "a.store-back")
    expect(document.querySelector(".store-detail")).toBeNull()
    expect(window.location.search).toBe("")
    expect((document.getElementById("store-filter") as unknown as FormEl).hidden).toBe(false)
    window.history.back()
    for (let i = 0; i < 50 && !document.querySelector(".store-detail"); i++) await settle(20)
    expect(document.querySelector(".store-detail")).toBeTruthy()
    expect(text(document, ".store-detail-name")).toBe("Gitty")
  })

  it("the icon is a link to the detail view too", async () => {
    const { window, document } = renderPanel({ handlers })
    await settle()
    click(window, '#store-entry-\\@acme\\/greeter a.store-icon-link')
    expect(text(document, ".store-detail-id")).toBe("@acme/greeter")
  })

  it("detail of a remote, not-installed entry: all catalog fields, requires, source, Install", async () => {
    const { document } = renderPanel({ handlers: nothingInstalledRemote, url: BASE + "?app=%40acme%2Fgreeter" })
    await settle()
    const d = document.querySelector(".store-detail")!
    const t = d.textContent ?? ""
    for (const want of ["Greeter", "@acme/greeter", "Acme Inc", "free", "https://x.test/license", "bundle", "2.4 MB", "default", "https://x.test/catalog.json", "stale", "utilities", ">=0.20.0", "@acme/base", "planner", SHA, "https://x.test/greeter.agentapp"]) {
      expect(t).toContain(want)
    }
    expect(d.querySelector(".store-detail-desc")!.textContent).toBe("Says hello to everyone.\nSecond line.")
    expect(d.querySelector("button[data-decision=install]")).toBeTruthy()
    expect(d.querySelector("button[data-decision=uninstall]")).toBeNull()
    expect(d.querySelector("img")!.getAttribute("src")).toBe("https://x.test/greeter.png")
  })

  it("copy block for a catalog agentapp: CLI install lines + the exact app_install MCP args (no confirm)", async () => {
    const { document } = renderPanel({ handlers, url: BASE + "?app=%40acme%2Fgitty" })
    await settle()
    const texts = copyTexts(document)
    expect(texts[0]).toBe("agentproto app install @acme/gitty")
    expect(texts[1]).toBe("agentproto app install 'https://github.com/acme/it'\\''s repo' --ref main --subdir apps/gitty --sha abc123")
    expect(JSON.parse(texts[2]!)).toEqual({
      name: "app_install",
      arguments: { url: GIT.source.url, ref: "main", subdir: "apps/gitty", sha: "abc123", allowBuild: false, catalogUrl: GIT.catalogUrl },
    })
    // unsafe icon url never reaches the DOM — initial-letter tile instead
    expect(document.querySelector(".store-detail img")).toBeNull()
    expect(text(document, ".store-detail .store-icon-fallback")).toBe("G")
  })

  it("agentapp copy block uses --sha256 and matches what the Install button sends", async () => {
    const log: ToolCall[] = []
    const { window, document } = renderPanel({ handlers: { ...nothingInstalledRemote, app_install: installHandler(log) }, url: BASE + "?app=%40acme%2Fgreeter" })
    await settle()
    const texts = copyTexts(document)
    expect(texts[1]).toBe(`agentproto app install https://x.test/greeter.agentapp --sha256 ${SHA}`)
    const mcp = JSON.parse(texts[2]!) as { name: string; arguments: Record<string, unknown> }
    click(window, ".store-detail button[data-decision=install]")
    await settle(100)
    expect(log).toHaveLength(2)
    expect(log[0]!.args).toEqual(mcp.arguments)
    expect(log[1]!.args.confirm).toBe("tok")
  })

  it("detail of an installed app: version/update badge, dirs + dirMissing warning, agents, workflows, last-10 runs, resync/uninstall copy", async () => {
    const { document } = renderPanel({ handlers, url: BASE + "?app=%40acme%2Fgreeter" })
    await settle()
    const d = document.querySelector(".store-detail")!
    const t = d.textContent ?? ""
    expect(t).toContain("0.9.0 → 1.0.0 available")
    expect(d.querySelector(".store-update-badge")).toBeTruthy()
    expect(t).toContain("/apps/greeter")
    expect(t).toContain("/data/greeter")
    expect(d.querySelector(".store-dir-missing")).toBeTruthy()
    expect(t).toContain("greeter-agent")
    expect(t).toContain("helper-agent")
    expect(t).toContain("greet-flow")
    expect(t).toContain("@acme/other")
    expect(t).toContain(("f".repeat(64)))
    const rows = d.querySelectorAll("table.store-runs tbody tr")
    expect(rows).toHaveLength(10)
    expect(d.querySelector(".store-detail-more")!.textContent).toContain("last 10 of 12")
    expect(rows[0]!.textContent).toContain("claude-code / sonnet")
    expect(t).toContain("1m 5s")
    expect(d.querySelector("button[data-decision=resync]")).toBeTruthy()
    expect(d.querySelector("button[data-decision=uninstall]")).toBeTruthy()
    expect(d.querySelector("button[data-decision=open]")).toBeTruthy()
    expect(d.querySelector("button[data-decision=install]")).toBeNull()
    const texts = copyTexts(document)
    expect(texts).toContain("agentproto app resync @acme/greeter")
    expect(texts).toContain("agentproto app uninstall @acme/greeter")
    expect(texts.some(x => x.startsWith("agentproto app install"))).toBe(false)
  })

  it("detail buttons reuse the handlers: Update → app_resync, Uninstall → confirm + app_uninstall", async () => {
    const { window, calls } = renderPanel({ handlers, url: BASE + "?app=%40acme%2Fgreeter" })
    await settle()
    calls.length = 0
    click(window, ".store-detail button[data-decision=resync]")
    await settle(60)
    expect(calls.find(c => c.tool === "app_resync")?.args).toEqual({ appId: "@acme/greeter" })
    click(window, ".store-detail button[data-decision=uninstall]")
    await settle(60)
    expect(window.confirm).toHaveBeenCalled()
    expect(calls.find(c => c.tool === "app_uninstall")?.args).toEqual({ appId: "@acme/greeter" })
  })

  it("a local installed app has no Update button and no resync command", async () => {
    const { document } = renderPanel({ handlers, url: BASE + "?app=%40me%2Flocal" })
    await settle()
    expect(document.querySelector(".store-detail button[data-decision=resync]")).toBeNull()
    expect(document.querySelector(".store-detail button[data-decision=uninstall]")).toBeTruthy()
    expect(copyTexts(document)).toEqual(["agentproto app uninstall @me/local", expect.stringContaining("app_uninstall")])
  })

  it("a builtin's detail shows the MCP tool id / resource URI instead of install commands", async () => {
    const { window, document } = renderPanel({ handlers, url: BASE + "?app=%40agentproto%2Freview-panel" })
    await settle()
    expect(copyTexts(document)).toEqual(["agentproto_reviews", "ui://agentproto_reviews/view"])
    expect(document.querySelector(".store-detail button[data-decision=install]")).toBeNull()
    expect(document.querySelector(".store-detail button[data-decision=uninstall]")).toBeNull()
    click(window, ".store-detail button[data-decision=open]")
    expect(window.open).toHaveBeenCalledWith("/apps/@agentproto/review-panel/ui", "_blank", "noopener")
  })

  it("builtin list entries link to their detail view", async () => {
    const { window, document } = renderPanel({ handlers })
    await settle()
    click(window, "li.store-builtin-item a.store-app-link")
    expect(text(document, ".store-detail-id")).toBe("@agentproto/review-panel")
  })

  it("an unknown ?app= renders a not-found message with a way back", async () => {
    const { document } = renderPanel({ handlers, url: BASE + "?app=%40nope%2Fnothing" })
    await settle()
    expect(text(document, ".store-detail")).toContain("@nope/nothing")
    expect(document.querySelector("a.store-back")).toBeTruthy()
  })

  it("?install= still deep-links while the shelves show; combined with ?app= both work", async () => {
    const log: ToolCall[] = []
    const { document } = renderPanel({ handlers: { ...handlers, app_install: installHandler(log) }, url: BASE + "?install=%40acme%2Fgitty&app=%40acme%2Fgitty" })
    await settle(120)
    expect(document.querySelector(".store-detail")).toBeTruthy()
    expect(log.length).toBe(2)
  })

  it("Copy writes the block text to navigator.clipboard", async () => {
    const written: string[] = []
    const { window, document } = renderPanel({ handlers, url: BASE + "?app=%40acme%2Fgitty" })
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText: (v: string) => (written.push(v), Promise.resolve()) }, configurable: true })
    await settle()
    click(window, 'button[data-decision=copy][data-copy-id="store-copy-0"]')
    await settle(20)
    expect(written).toEqual(["agentproto app install @acme/gitty"])
    expect(document.getElementById("statusbar")!.textContent).toBe("Copied")
  })

  it("Copy falls back to selecting the text when the clipboard API is missing", async () => {
    const { window, document } = renderPanel({ handlers, url: BASE + "?app=%40acme%2Fgitty" })
    await settle()
    click(window, 'button[data-decision=copy][data-copy-id="store-copy-0"]')
    expect(document.getElementById("statusbar")!.textContent).toContain("Selected")
    expect(window.getSelection()!.toString()).toBe("agentproto app install @acme/gitty")
  })

  it("a failing icon image swaps to the initial-letter tile", async () => {
    const { window, document } = renderPanel({ handlers })
    await settle()
    const img = document.querySelector("#store-entry-\\@acme\\/greeter .store-icon img")!
    expect(img.getAttribute("src")).toBe("https://x.test/greeter.png")
    img.dispatchEvent(new window.Event("error"))
    const tile = document.querySelector("#store-entry-\\@acme\\/greeter .store-icon")!
    expect(tile.querySelector("img")).toBeNull()
    expect(tile.textContent).toBe("G")
    expect(tile.classList.contains("store-icon-fallback")).toBe(true)
  })

  it("history writes being refused (host iframe) still navigates in-panel", async () => {
    const { window, document } = renderPanel({ handlers })
    window.history.pushState = () => {
      throw new Error("SecurityError")
    }
    window.history.replaceState = () => {
      throw new Error("SecurityError")
    }
    await settle()
    click(window, '#store-entry-\\@acme\\/gitty a.store-app-link')
    expect(document.querySelector(".store-detail")).toBeTruthy()
    click(window, "a.store-back")
    expect(document.querySelector(".store-detail")).toBeNull()
  })

  function typeSearch(window: TestWindow, value: string): void {
    const input = window.document.getElementById("store-search") as unknown as FormEl
    input.value = value
    input.dispatchEvent(new window.Event("input", { bubbles: true }))
  }

  it("search filters across sections by name/appId/description/publisher, case-insensitively, state in ?q=", async () => {
    const { window, document } = renderPanel({ handlers })
    await settle()
    typeSearch(window, "GITTY")
    const content = document.getElementById("content")!
    expect(content.querySelector("#store-entry-\\@acme\\/gitty")).toBeTruthy()
    expect(content.querySelector("#store-entry-\\@acme\\/greeter")).toBeNull()
    expect(window.location.search).toBe("?q=GITTY")
    typeSearch(window, "from git")
    expect(content.querySelector("#store-entry-\\@acme\\/gitty")).toBeTruthy()
    typeSearch(window, "acme inc")
    expect(content.querySelectorAll(".card").length).toBe(3) // greeter installed + available, gitty available
    typeSearch(window, "local dir")
    expect(content.querySelector("#store-entry-\\@me\\/local")).toBeTruthy()
    expect(content.querySelector("#store-entry-\\@acme\\/gitty")).toBeNull()
    typeSearch(window, "ledger")
    expect(content.querySelector("li.store-builtin-item")).toBeTruthy()
    typeSearch(window, "")
    expect(window.location.search).toBe("")
  })

  it("an empty result shows a message, not a blank page or the 'catalog empty' state", async () => {
    const { window, document } = renderPanel({ handlers })
    await settle()
    typeSearch(window, "zzzz-nothing")
    const html = document.getElementById("content")!.innerHTML
    expect(html).toContain("store-no-results")
    expect(html).toContain("zzzz-nothing")
    expect(html).not.toContain("store-empty-hint\">Add a")
    expect(html).not.toContain("store-builtins")
  })

  it("category chips filter (?cat=), combine with search, and All clears", async () => {
    const { window, document } = renderPanel({ handlers })
    await settle()
    const chips = Array.from(document.querySelectorAll("#store-cats button")).map(b => b.getAttribute("data-cat"))
    expect(chips).toEqual(["", "builtin", "dev", "utilities"])
    click(window, '#store-cats button[data-cat="dev"]')
    const content = document.getElementById("content")!
    expect(content.querySelector("#store-entry-\\@acme\\/gitty")).toBeTruthy()
    expect(content.querySelector("#store-entry-\\@acme\\/greeter")).toBeNull()
    expect(window.location.search).toBe("?cat=dev")
    expect(document.querySelector('#store-cats button[data-cat="dev"]')!.classList.contains("active")).toBe(true)
    typeSearch(window, "acme")
    expect(window.location.search).toBe("?cat=dev&q=acme")
    click(window, '#store-cats button[data-cat=""]')
    expect(content.querySelector("#store-entry-\\@acme\\/greeter")).toBeTruthy()
  })

  it("?q= and ?cat= in the URL are applied on load and prefill the search box", async () => {
    const { document } = renderPanel({ handlers, url: BASE + "?q=gitty&cat=dev" })
    await settle()
    expect((document.getElementById("store-search") as unknown as FormEl).value).toBe("gitty")
    expect(document.querySelector("#store-entry-\\@acme\\/gitty")).toBeTruthy()
    expect(document.querySelector("#store-entry-\\@acme\\/greeter")).toBeNull()
  })

  it("the detail back link keeps the active search/category", async () => {
    const { window, document } = renderPanel({ handlers, url: BASE + "?q=acme&app=%40acme%2Fgitty" })
    await settle()
    click(window, "a.store-back")
    expect(window.location.search).toBe("?q=acme")
    expect(document.querySelector(".store-detail")).toBeNull()
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
