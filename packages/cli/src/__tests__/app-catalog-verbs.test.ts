/**
 * The catalog-facing `app` verbs (`catalog`, `uninstall`, `update`, `store`,
 * and `list`'s empty hint) against a mocked daemon /mcp client: the right
 * tool + arguments per verb, both output formats, and browser-opening only
 * through `lib/open-browser.js`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Imported AFTER beforeEach points HOME at a temp dir (commands/app.ts
// resolves the app registry from the module-load-time home dir).
type AppModule = typeof import("../commands/app.js")
let appModule: AppModule | null = null
async function load(): Promise<AppModule> {
  if (!appModule) throw new Error("module not loaded yet")
  return appModule
}

const h = vi.hoisted(() => {
  return {
    calls: [] as { name: string; arguments: Record<string, unknown> }[],
    // Tool name -> callTool result (or Error to simulate a daemon failure).
    responses: {} as Record<string, unknown>,
  }
})

vi.mock("../app-serve.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../app-serve.js")>()
  return {
    ...mod,
    resolveDaemonMcpUrl: vi.fn(async () => "http://127.0.0.1:18790/mcp"),
    createDaemonMcpClientGetter: vi.fn(
      (_url: string, _name: string) =>
        async () => ({
          callTool: async (req: { name: string; arguments: Record<string, unknown> }) => {
            h.calls.push({ name: req.name, arguments: req.arguments })
            const r = h.responses[req.name]
            if (r instanceof Error) throw r
            return r
          },
        }),
    ),
  }
})

vi.mock("../lib/open-browser.js", () => ({
  openInBrowser: vi.fn(),
}))

import { openInBrowser } from "../lib/open-browser.js"

let home: string
const originalHome = process.env.HOME

function result(texts: unknown[], isError = false) {
  return {
    isError,
    content: (texts as unknown[]).map((text) => ({ type: "text", text: typeof text === "string" ? text : JSON.stringify(text) })),
  }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "app-verbs-"))
  process.env.HOME = home
  h.calls.length = 0
  h.responses = {}
  vi.mocked(openInBrowser).mockClear()
  appModule = await import("../commands/app.js")
})

afterEach(async () => {
  process.env.HOME = originalHome
  await rm(home, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function of(fn: (m: AppModule) => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const so = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => { out.push(String(c)); return true })
  const se = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => { err.push(String(c)); return true })
  const code = await fn(appModule!)
  so.mockRestore()
  se.mockRestore()
  return { code, out: out.join(""), err: err.join("") }
}

const CATALOG_ENTRIES = [
  {
    appId: "@acme/greeter",
    version: "1.2.0",
    tier: "bundle",
    origin: "default",
    catalogUrl: "https://catalog.example/apps.json",
    installed: false,
    source: { kind: "agentapp", url: "https://releases.example/greeter-1.2.0.agentapp", sha256: "ff" },
  },
  {
    appId: "@acme/installed",
    version: "0.3.0",
    instance: "git",
    tier: "git",
    origin: "default",
    installed: true,
    updateAvailable: true,
    source: { kind: "git", url: "https://github.com/acme/installed", sha: "abc", ref: "main" },
  },
]

describe("looksLikeAppId", () => {
  it("matches @scope/name only", async () => {
    const m = await load()
    expect(m.looksLikeAppId("@acme/greeter")).toBe(true)
    expect(m.looksLikeAppId("greeter")).toBe(false)
    expect(m.looksLikeAppId("site.agentapp")).toBe(false)
    expect(m.looksLikeAppId("https://x/y")).toBe(false)
  })
})

describe("app catalog", () => {
  beforeEach(() => {
    h.responses.app_catalog = result([CATALOG_ENTRIES, { warnings: ["catalog source https://c: boom"] }])
  })

  it("lists entries as plain rows and prints source warnings", async () => {
    const { code, out, err } = await of((m) => m.runAppCatalog([]))
    expect(code).toBe(0)
    expect(h.calls).toEqual([{ name: "app_catalog", arguments: {} }])
    expect(out).toContain("@acme/greeter  v1.2.0  bundle  not installed  default")
    expect(out).toContain("@acme/installed  v0.3.0  git  installed  update available  default")
    expect(out).not.toContain("greeter-1.2.0.agentapp")
    expect(err).toContain("warning: catalog source https://c: boom")
  })

  it("--refresh reaches the daemon as refresh: true", async () => {
    await of((m) => m.runAppCatalog(["--refresh"]))
    expect(h.calls[0]!.arguments).toEqual({ refresh: true })
  })

  it("--json prints the entries and warnings verbatim", async () => {
    const { code, out } = await of((m) => m.runAppCatalog(["--json"]))
    const parsed = JSON.parse(out) as { entries: unknown[]; warnings: string[] }
    expect(code).toBe(0)
    expect(parsed.entries).toEqual(CATALOG_ENTRIES)
    expect(parsed.warnings).toEqual(["catalog source https://c: boom"])
  })

  it("surfaces a daemon error with the verb's name", async () => {
    h.responses.app_catalog = new Error("daemon down")
    const { code, err } = await of((m) => m.runAppCatalog([]))
    expect(code).toBe(1)
    expect(err).toContain("agentproto app catalog: could not reach the daemon (daemon down)")
  })
})

describe("app uninstall", () => {
  beforeEach(() => {
    h.responses.app_uninstall = result([{ appId: "@acme/greeter" }])
  })

  it("calls app_uninstall and prints a human line", async () => {
    const { code, out } = await of((m) => m.runAppUninstall(["@acme/greeter"]))
    expect(code).toBe(0)
    expect(h.calls).toEqual([{ name: "app_uninstall", arguments: { appId: "@acme/greeter" } }])
    expect(out).toContain("agentproto: uninstalled @acme/greeter")
  })

  it("--json echoes the daemon result", async () => {
    const { code, out } = await of((m) => m.runAppUninstall(["@acme/greeter", "--json"]))
    expect(code).toBe(0)
    expect(JSON.parse(out)).toEqual({ appId: "@acme/greeter" })
  })

  it("a missing appId is usage error exit 2", async () => {
    const { code } = await of((m) => m.runAppUninstall([]))
    expect(code).toBe(2)
    expect(h.calls).toEqual([])
  })
})

describe("app update", () => {
  const UPDATES = result([
    { updates: [{ appId: "@acme/installed", from: "0.3.0", to: "0.4.0", catalogUrl: "https://c" }], upToDate: [], notListed: [], untracked: [] },
  ])
  const NO_UPDATES = result([{ updates: [], upToDate: [], notListed: [], untracked: [] }])

  it("with no appId: app_updates lists the updates and the apply hint", async () => {
    h.responses.app_updates = UPDATES
    const { code, out } = await of((m) => m.runAppUpdate([]))
    expect(code).toBe(0)
    expect(h.calls).toEqual([{ name: "app_updates", arguments: {} }])
    expect(out).toContain("@acme/installed  0.3.0 -> 0.4.0")
    expect(out).toContain("agentproto app update <appId>")
    expect(out).toContain("@acme/installed  0.3.0 -> 0.4.0")
  })

  it("with no appId and no updates: a quiet all-clear", async () => {
    h.responses.app_updates = NO_UPDATES
    const { code, out } = await of((m) => m.runAppUpdate([]))
    expect(code).toBe(0)
    expect(out).toContain("everything is up to date")
  })

  it("with an appId: app_resync {appId}", async () => {
    h.responses.app_resync = result([{ changed: true, from: "0.3.0", to: "0.4.0" }])
    const { code, out } = await of((m) => m.runAppUpdate(["@acme/installed"]))
    expect(code).toBe(0)
    expect(h.calls).toEqual([{ name: "app_resync", arguments: { appId: "@acme/installed" } }])
    expect(out).toContain('"changed":true')
  })

  it("--dry-run with an appId: only app_updates, never app_resync", async () => {
    h.responses.app_updates = UPDATES
    const { code, out } = await of((m) => m.runAppUpdate(["@acme/installed", "--dry-run"]))
    expect(code).toBe(0)
    expect(h.calls.map(c => c.name)).toEqual(["app_updates"])
    expect(out).toContain("0.3.0 -> 0.4.0  (dry run)")
  })

  it("--all: each update from app_updates is resynced", async () => {
    h.responses.app_updates = UPDATES
    h.responses.app_resync = result([{ changed: true }])
    const { code } = await of((m) => m.runAppUpdate(["--all"]))
    expect(code).toBe(0)
    expect(h.calls).toEqual([
      { name: "app_updates", arguments: {} },
      { name: "app_resync", arguments: { appId: "@acme/installed" } },
    ])
  })

  it("--all --dry-run: lists without resyncing", async () => {
    h.responses.app_updates = UPDATES
    const { code } = await of((m) => m.runAppUpdate(["--all", "--dry-run"]))
    expect(code).toBe(0)
    expect(h.calls.map(c => c.name)).toEqual(["app_updates"])
  })

  it("--json echoes the raw daemon payload", async () => {
    h.responses.app_updates = UPDATES
    const { code, out } = await of((m) => m.runAppUpdate(["--json"]))
    expect(code).toBe(0)
    expect(JSON.parse(out).updates[0]).toEqual({ appId: "@acme/installed", from: "0.3.0", to: "0.4.0", catalogUrl: "https://c" })
  })
})

describe("app store", () => {
  it("--print prints just the daemon store URL", async () => {
    const { code, out } = await of((m) => m.runAppStore(["--print"]))
    expect(code).toBe(0)
    expect(out.trim()).toBe("http://127.0.0.1:18790/store")
    expect(vi.mocked(openInBrowser)).not.toHaveBeenCalled()
  })

  it("without --print opens the browser and prints the URL", async () => {
    const { code, out } = await of((m) => m.runAppStore([]))
    expect(code).toBe(0)
    expect(vi.mocked(openInBrowser)).toHaveBeenCalledWith("http://127.0.0.1:18790/store")
    expect(out).toContain("opening http://127.0.0.1:18790/store")
  })
})

describe("app list empty hint", () => {
  it("points at both browse verbs", async () => {
    const { code, out } = await of((m) => m.runAppList())
    expect(code).toBe(0)
    expect(out).toContain("No apps installed. Browse: agentproto app store  (or: agentproto app catalog)")
  })
})
