/**
 * `agentproto app install @scope/name` — catalog resolution. A mocked
 * daemon returns `app_catalog`; the CLI must hand `app_install` the entry's
 * pinned source (`{url, sha256}` bundle / `{url, ref?, subdir?, sha}` git,
 * `allowBuild` only with `--allow-build`, plus `catalogUrl`), never call
 * the catalog for an existing path, and fail with a catalog hint on an
 * unknown id. HOME is a temp dir: the registering install writes
 * ~/.agentproto/apps.json.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const h = vi.hoisted(() => {
  return {
    calls: [] as { name: string; arguments: Record<string, unknown> }[],
    responses: {} as Record<string, unknown>,
    connectError: undefined as Error | undefined,
  }
})

vi.mock("../app-serve.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../app-serve.js")>()
  return {
    ...mod,
    resolveDaemonMcpUrl: vi.fn(async () => "http://127.0.0.1:18790/mcp"),
    createDaemonMcpClientGetter: vi.fn(
      (_url: string, _name: string) =>
        async () => {
          if (h.connectError) throw h.connectError
          return {
          callTool: async (req: { name: string; arguments: Record<string, unknown> }) => {
            h.calls.push({ name: req.name, arguments: req.arguments })
            const r = h.responses[req.name]
            if (r instanceof Error) throw r
            return r
          },
          }
        },
    ),
  }
})

type AppModule = typeof import("../commands/app.js")
let appModule: AppModule | null = null

let home: string
let cwd: string
const originalHome = process.env.HOME
const originalCwd = process.cwd()

function result(texts: unknown[], isError = false) {
  return {
    isError,
    content: (texts as unknown[]).map((text) => ({
      type: "text",
      text: typeof text === "string" ? text : JSON.stringify(text),
    })),
  }
}

const APP_MD = `---
schema: app/v1
id: "@scope/name"
name: Name
agents:
  - id: worker
    path: .agentproto/agents/worker/AGENT.md
workflows: []
---

# app
`

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "app-install-catalog-home-"))
  process.env.HOME = home
  cwd = await mkdtemp(join(tmpdir(), "app-install-catalog-cwd-"))
  process.chdir(cwd)
  h.calls.length = 0
  h.responses = {}
  h.connectError = undefined
  appModule = await import("../commands/app.js")
})

afterEach(async () => {
  process.env.HOME = originalHome
  process.chdir(originalCwd)
  await rm(home, { recursive: true, force: true })
  await rm(cwd, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function of(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const so = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => { out.push(String(c)); return true })
  const se = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => { err.push(String(c)); return true })
  const code = await fn()
  so.mockRestore()
  se.mockRestore()
  return { code, out: out.join(""), err: err.join("") }
}

function catalogResponse(entry: Record<string, unknown> | null) {
  const entryBlocks: unknown[] = [entry ? [entry] : []]
  h.responses.app_catalog = result(entryBlocks)
  h.responses.app_install = result([{ appId: "@scope/name", dir: "/state/apps/name" }])
}

describe("app install @scope/name catalog resolution", () => {
  it("a bundle entry installs {url, sha256, catalogUrl}", async () => {
    catalogResponse({
      appId: "@scope/name",
      version: "1.2.0",
      tier: "bundle",
      origin: "default",
      catalogUrl: "https://catalog.example/apps.json",
      installed: false,
      source: { kind: "agentapp", url: "https://releases.example/name-1.2.0.agentapp", sha256: "ff" },
    })
    const { code, out, err } = await of(async () => appModule!.runAppInstall(["@scope/name"]))
    expect(code).toBe(0)
    expect(err).toBe("")
    expect(h.calls.map(c => c.name)).toEqual(["app_catalog", "app_install"])
    expect(h.calls[1]!.arguments).toEqual({
      url: "https://releases.example/name-1.2.0.agentapp",
      sha256: "ff",
      catalogUrl: "https://catalog.example/apps.json",
    })
    expect(out).toContain("appId")
  })

  it("a git entry installs {url, ref, subdir, sha}, no allowBuild without the flag", async () => {
    catalogResponse({
      appId: "@scope/name",
      origin: "default",
      installed: false,
      source: { kind: "git", url: "https://github.com/scope/name", ref: "main", subdir: "app", sha: "abc123" },
    })
    const { code } = await of(() => appModule!.runAppInstall(["@scope/name"]))
    expect(code).toBe(0)
    expect(h.calls[1]!.arguments).toEqual({
      url: "https://github.com/scope/name",
      ref: "main",
      subdir: "app",
      sha: "abc123",
      catalogUrl: undefined,
    })
  })

  it("--allow-build reaches the daemon for a git entry", async () => {
    catalogResponse({
      appId: "@scope/name",
      installed: false,
      source: { kind: "git", url: "https://github.com/scope/name", sha: "abc" },
    })
    await of(() => appModule!.runAppInstall(["@scope/name", "--allow-build"]))

    expect(h.calls[1]!.arguments).toMatchObject({ url: "https://github.com/scope/name", sha: "abc", allowBuild: true })
  })

  it("an existing path wins — no catalog call; a reachable daemon installs it", async () => {
    const dir = join(cwd, "@scope", "name")
    await mkdir(dir, { recursive: true })
    await mkdir(join(dir, ".agentproto"), { recursive: true })
    await writeFile(join(dir, ".agentproto", "APP.md"), APP_MD, "utf8")
    h.responses["app_install"] = result([{ appId: "@scope/name" }])

    const { code, err } = await of(() => appModule!.runAppInstall(["@scope/name"]))
    expect(code, err).toBe(0)
    expect(h.calls.map((c) => c.name)).toEqual(["app_install"])
    expect(h.calls[0]!.arguments).toEqual({ dir: await realpath(dir) })
  })

  it("with no daemon reachable, a local dir installs offline (full record) instead", async () => {
    const dir = join(cwd, "@scope", "name")
    await mkdir(dir, { recursive: true })
    await mkdir(join(dir, ".agentproto"), { recursive: true })
    await writeFile(join(dir, ".agentproto", "APP.md"), APP_MD, "utf8")
    await mkdir(join(dir, ".agentproto", "agents", "worker"), { recursive: true })
    await writeFile(
      join(dir, ".agentproto", "agents", "worker", "AGENT.md"),
      "---\nschema: agent/v1\nid: worker\ndescription: A worker.\nmodel: claude-sonnet-5\n---\n\nWork.\n",
      "utf8",
    )
    h.connectError = new Error("ECONNREFUSED")

    const { code, out, err } = await of(() => appModule!.runAppInstall(["@scope/name"]))
    expect(code, err).toBe(0)
    expect(h.calls).toEqual([])
    expect(out).toContain("registered app '@scope/name'")
    const apps = (JSON.parse(await readFile(join(home, ".agentproto", "apps.json"), "utf8")) as { apps: Record<string, unknown>[] }).apps
    expect(apps[0]).toMatchObject({ appId: "@scope/name", agents: [{ id: "worker" }], workflows: [] })
  })

  it("an entry without its digest / commit pin is refused, never installed unverified", async () => {
    catalogResponse({
      appId: "@scope/name",
      installed: false,
      source: { kind: "agentapp", url: "https://releases.example/name-1.2.0.agentapp" },
    })
    const bundle = await of(() => appModule!.runAppInstall(["@scope/name"]))
    expect(bundle.code).toBe(1)
    expect(bundle.err).toContain("no sha256 pin")
    catalogResponse({ appId: "@scope/name", installed: false, source: { kind: "git", url: "https://github.com/scope/name" } })
    const git = await of(() => appModule!.runAppInstall(["@scope/name"]))
    expect(git.code).toBe(1)
    expect(git.err).toContain("no sha pin")
    expect(h.calls.map(c => c.name)).not.toContain("app_install")
  })

  it("an unknown appId errors with the catalog hint", async () => {
    catalogResponse(null)
    const { code, err } = await of(() => appModule!.runAppInstall(["@scope/name"]))
    expect(code).toBe(1)
    expect(err).toContain("no catalog entry named '@scope/name'")
    expect(err).toContain("agentproto app catalog")
    expect(h.calls.map(c => c.name)).toEqual(["app_catalog"])
  })

  it("an unreachable daemon surfaces as a catalog error", async () => {
    h.responses.app_catalog = new Error("connect ECONNREFUSED")
    const { code, err } = await of(() => appModule!.runAppInstall(["@scope/name"]))
    expect(code).toBe(1)
    expect(err).toContain("could not reach the daemon")
  })

  it("an entry with no remote source is refused", async () => {
    catalogResponse({
      appId: "@scope/name",
      installed: false,
      dir: "/some/dir",
      source: { kind: "local" },
    })
    const { code, err } = await of(() => appModule!.runAppInstall(["@scope/name"]))
    expect(code).toBe(1)
    expect(err).toContain("no remote source")
    expect(h.calls.map(c => c.name)).toEqual(["app_catalog"])
  })

  it("a non-appId missing path keeps the old not-an-app flow (no catalog)", async () => {
    const { code, err } = await of(() => appModule!.runAppInstall(["./nope"]))
    expect(code).toBe(2)
    expect(err).toContain("is not an agentproto app")
    expect(h.calls).toEqual([])
  })
})
