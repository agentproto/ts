/**
 * `app_install` from a git URL / `.agentapp`, source pins, and `app_resync`.
 * Fully offline: git over a local bare repo via `file://`, bundles built by
 * `packApp` in the test and served from disk or a loopback http server.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import matter from "gray-matter"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { defineApp, packApp } from "@agentproto/app-kit"
import { defineAgent } from "@agentproto/agent"
import { defineWorkflow } from "@agentproto/workflow"

import { registerAppTools } from "../app-tools.js"
import { createAppRegistry } from "../app-registry.js"
import { createSessionsRegistry } from "../sessions.js"

function parse(result: unknown): any {
  const text = (result as { content?: { type: string; text?: string }[] }).content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("no text content")
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
const isError = (r: unknown): boolean => (r as { isError?: boolean }).isError === true
const errText = (r: unknown): string => String(parse(r)?.error ?? parse(r))

async function emitFixture(dir: string): Promise<void> {
  await defineApp({
    id: "@test/remote-app",
    name: "Remote App",
    agents: [
      {
        agent: defineAgent({
          schema: "agent/v1",
          id: "worker",
          description: "A worker.",
          model: "claude-sonnet-5",
          workflows: [{ ref: "do-thing" }],
        }),
        body: "Work.",
      },
    ],
    workflows: [
      defineWorkflow({
        id: "do-thing",
        name: "Do thing",
        description: "Does a thing.",
        version: "0.1.0",
        inputs: {},
        outputs: {},
        steps: [{ id: "s1", kind: "tool", tool: "known_tool" }],
      }),
    ],
  }).emit(dir)
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
}
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`)
  return r.stdout.trim()
}

/** Add a `ui` block (with a `ui.build` writing a marker + the bundle) to an emitted app. */
async function addUiBuild(appDir: string, opts: { prebuilt: boolean }): Promise<void> {
  const appMd = join(appDir, ".agentproto", "APP.md")
  const parsed = matter(await readFile(appMd, "utf8"))
  const data = { ...parsed.data, ui: { path: ".agentproto/ui/index.html", build: { command: "sh build.sh" } } }
  await writeFile(appMd, matter.stringify(parsed.content, data))
  await writeFile(
    join(appDir, "build.sh"),
    "touch build-ran.marker\nmkdir -p .agentproto/ui\nprintf '<html>built</html>' > .agentproto/ui/index.html\n",
  )
  if (opts.prebuilt) {
    await mkdir(join(appDir, ".agentproto", "ui"), { recursive: true })
    await writeFile(join(appDir, ".agentproto", "ui", "index.html"), "<html>prebuilt</html>")
  }
}

describe("app_install remote sources + app_resync", { timeout: 60_000 }, () => {
  let root: string
  let appsDir: string
  let client: Client
  let catalogConfig: { defaultSource?: string | false; sources?: { url: string }[] }
  const servers: Server[] = []

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "app-remote-"))
    appsDir = join(root, "state", "apps")
    catalogConfig = { defaultSource: false }
    const server = new McpServer({ name: "t", version: "0.0.0" })
    registerAppTools(server, {
      registry: createSessionsRegistry({ persist: false }),
      listRegisteredToolIds: async () => ["known_tool"],
      appRegistry: createAppRegistry(),
      appsDir,
      resolveAgentAdapter: async slug =>
        slug === "mastra-agent"
          ? { startSession: async () => ({ sessionId: "x", send: async function* () {}, cancel: async () => {}, close: async () => {} }), commandPreview: "mock" }
          : null,
      loadCatalogConfig: async () => ({ catalog: catalogConfig }),
      catalogCacheDir: join(root, "state", "cache", "catalog"),
    } as Parameters<typeof registerAppTools>[1])
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    client = new Client({ name: "c", version: "0.0.0" })
    await client.connect(ct)
  })
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise(r => s.close(r))
    await rm(root, { recursive: true, force: true })
  })

  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args })

  /** Loopback http server serving `files` (path → body); mutate the map to republish. */
  async function serveFiles(files: Map<string, Buffer | string>): Promise<string> {
    const srv = createServer((req, res) => {
      const body = files.get(req.url ?? "")
      if (body === undefined) {
        res.statusCode = 404
        res.end()
        return
      }
      res.end(body)
    })
    await new Promise<void>(r => srv.listen(0, "127.0.0.1", r))
    servers.push(srv)
    return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
  }

  /** Pack the fixture app at `version`, serve it, and return its catalog source. */
  async function publishBundle(
    files: Map<string, Buffer | string>,
    base: string,
    version: string,
  ): Promise<{ kind: "agentapp"; url: string; sha256: string; version: string }> {
    const src = join(root, `pub-${version}`)
    await emitFixture(src)
    const appMd = join(src, ".agentproto", "APP.md")
    const parsed = matter(await readFile(appMd, "utf8"))
    await writeFile(appMd, matter.stringify(parsed.content, { ...parsed.data, version }))
    const out = join(root, `remote-app-${version}.agentapp`)
    const { manifest } = await packApp({ appDir: src, out })
    files.set(`/remote-app-${version}.agentapp`, await readFile(out))
    return { kind: "agentapp", url: `${base}/remote-app-${version}.agentapp`, sha256: manifest.sha256, version }
  }

  const catalogDoc = (...sources: { kind: "agentapp"; url: string; sha256: string; version: string }[]) =>
    JSON.stringify({
      schema: "app-catalog/v1",
      entries: sources.map(s => ({ appId: "@test/remote-app", version: s.version, source: s })),
    })

  /** Bare repo `<name>.git` seeded from a work tree whose `appPath` holds the app. */
  async function makeGitRemote(name: string, appPath = ""): Promise<{ url: string; work: string; push: () => void }> {
    const bare = join(root, `${name}.git`)
    const work = join(root, `${name}-work`)
    await mkdir(work, { recursive: true })
    git(work, "init", "-q", "-b", "main")
    await emitFixture(appPath === "" ? work : join(work, appPath))
    git(work, "add", "-A")
    git(work, "commit", "-q", "-m", "init")
    git(root, "init", "-q", "--bare", "-b", "main", bare)
    git(work, "remote", "add", "origin", pathToFileURL(bare).href)
    git(work, "push", "-q", "origin", "main")
    return { url: pathToFileURL(bare).href, work, push: () => git(work, "push", "-q", "origin", "HEAD") }
  }

  it("git: installs under the state dir, pins the sha, resync is a no-op then picks up a new commit", async () => {
    const remote = await makeGitRemote("fixture-app")
    const sha1 = git(remote.work, "rev-parse", "HEAD")

    const res = await call("app_install", { url: remote.url })
    expect(isError(res), errText(res)).toBe(false)
    const rec = parse(res)
    expect(rec.appId).toBe("@test/remote-app")
    expect(rec.dir).toBe(join(appsDir, "fixture-app"))
    expect(rec.source).toEqual({ kind: "git", url: remote.url, sha: sha1 })

    // durable data written under the default dataDir must survive a resync
    await mkdir(rec.dataDir, { recursive: true })
    await writeFile(join(rec.dataDir, "keep.txt"), "mine")

    const noop = parse(await call("app_resync", { appId: rec.appId }))
    expect(noop).toEqual({ appId: rec.appId, changed: false })

    await writeFile(join(remote.work, "NEW.md"), "new\n")
    git(remote.work, "add", "-A")
    git(remote.work, "commit", "-q", "-m", "second")
    remote.push()
    const sha2 = git(remote.work, "rev-parse", "HEAD")

    const changed = parse(await call("app_resync", { appId: rec.appId }))
    expect(changed).toEqual({ appId: rec.appId, changed: true, from: sha1, to: sha2 })
    expect(existsSync(join(appsDir, "fixture-app", "NEW.md"))).toBe(true)
    expect(await readFile(join(rec.dataDir, "keep.txt"), "utf8")).toBe("mine")

    const listed = parse(await call("app_list", { full: true }))
    const item = (Array.isArray(listed) ? listed : listed.items).find((a: any) => a.appId === rec.appId)
    expect(item.source.sha).toBe(sha2)
    expect(parse(await call("app_resync", { appId: rec.appId })).changed).toBe(false)
    // no staging leftovers next to the app
    expect((await import("node:fs")).readdirSync(appsDir)).toEqual(["fixture-app"])
  })

  it("git: --ref branch and subdir are honored and recorded", async () => {
    const remote = await makeGitRemote("mono", "apps/remote")
    git(remote.work, "checkout", "-q", "-b", "dev")
    await writeFile(join(remote.work, "DEV.md"), "dev\n")
    git(remote.work, "add", "-A")
    git(remote.work, "commit", "-q", "-m", "dev")
    git(remote.work, "push", "-q", "origin", "dev")
    const devSha = git(remote.work, "rev-parse", "HEAD")

    const rec = parse(await call("app_install", { url: remote.url, ref: "dev", subdir: "apps/remote" }))
    expect(rec.dir).toBe(join(appsDir, "mono-apps-remote", "apps", "remote"))
    expect(rec.source).toEqual({ kind: "git", url: remote.url, ref: "dev", sha: devSha, subdir: "apps/remote" })
    expect(existsSync(join(appsDir, "mono-apps-remote", "DEV.md"))).toBe(true)
    expect(parse(await call("app_resync", { appId: rec.appId })).changed).toBe(false)
  })

  it("git: a bad subdir or unreachable url is refused and leaves the previous install untouched", async () => {
    const remote = await makeGitRemote("fixture-app")
    const first = parse(await call("app_install", { url: remote.url }))

    const badSubdir = await call("app_install", { url: remote.url, subdir: "nope" })
    expect(isError(badSubdir)).toBe(true)
    expect(errText(badSubdir)).toContain("subdir")
    const escape = await call("app_install", { url: remote.url, subdir: "../x" })
    expect(isError(escape)).toBe(true)
    const dead = await call("app_install", { url: pathToFileURL(join(root, "missing.git")).href })
    expect(isError(dead)).toBe(true)

    const still = parse(await call("app_list", { full: true }))
    const rows = Array.isArray(still) ? still : still.items
    expect(rows).toHaveLength(1)
    expect(rows[0].source.sha).toBe(first.source.sha)
    expect(existsSync(join(appsDir, "fixture-app", ".agentproto", "APP.md"))).toBe(true)
  })

  async function packFixture(name: string, extra?: string): Promise<{ file: string; sha256: string; url: string }> {
    const appDir = join(root, `${name}-src`)
    await rm(appDir, { recursive: true, force: true })
    await emitFixture(appDir)
    if (extra !== undefined) await writeFile(join(appDir, "EXTRA.md"), extra)
    const { file, manifest } = await packApp({ appDir, out: join(root, `${name}.agentapp`) })
    return { file, sha256: manifest.sha256, url: pathToFileURL(file).href }
  }

  it(".agentapp: {file} and {url} install with the verified sha256/version pinned", async () => {
    const bundle = await packFixture("bundle")

    const viaFile = parse(await call("app_install", { file: bundle.file }))
    expect(viaFile.appId).toBe("@test/remote-app")
    expect(viaFile.dir).toBe(join(appsDir, "test-remote-app"))
    expect(viaFile.source).toEqual({ kind: "agentapp", url: bundle.url, sha256: bundle.sha256, version: expect.any(String) })

    const viaUrl = parse(await call("app_install", { url: bundle.url }))
    expect(viaUrl.source.sha256).toBe(bundle.sha256)
    expect(viaUrl.dir).toBe(viaFile.dir)
  })

  it(".agentapp: served over http, resync is a no-op until the bundle changes", async () => {
    let bundle = await packFixture("served")
    const server = createServer((_req, res) => {
      void readFile(bundle.file).then(buf => res.end(buf))
    })
    servers.push(server)
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as { port: number }).port
    const url = `http://127.0.0.1:${port}/served.agentapp`

    const rec = parse(await call("app_install", { url }))
    expect(rec.source).toMatchObject({ kind: "agentapp", url, sha256: bundle.sha256 })
    expect(parse(await call("app_resync", { appId: rec.appId })).changed).toBe(false)

    bundle = await packFixture("served", "more\n")
    const changed = parse(await call("app_resync", { appId: rec.appId }))
    expect(changed).toEqual({ appId: rec.appId, changed: true, from: expect.any(String), to: bundle.sha256 })
    expect(changed.from).not.toBe(changed.to)
    expect(existsSync(join(appsDir, "test-remote-app", "EXTRA.md"))).toBe(true)
  })

  it(".agentapp: a tampered bundle is refused and the previous install stays", async () => {
    const good = await packFixture("bundle")
    const rec = parse(await call("app_install", { file: good.file }))

    const scratch = join(root, "scratch")
    await mkdir(scratch)
    spawnSync("tar", ["-xzf", good.file, "-C", scratch])
    await writeFile(join(scratch, ".agentproto", "APP.md"), (await readFile(join(scratch, ".agentproto", "APP.md"), "utf8")) + "\n<!-- x -->\n")
    const bad = join(root, "bad.agentapp")
    spawnSync("tar", ["-czf", bad, ".agentproto", "manifest.json"], { cwd: scratch })

    const res = await call("app_install", { file: bad })
    expect(isError(res)).toBe(true)
    expect(errText(res)).toContain("SHA-256 mismatch")

    const rows = parse(await call("app_list", { full: true }))
    const list = Array.isArray(rows) ? rows : rows.items
    expect(list).toHaveLength(1)
    expect(list[0].source.sha256).toBe(rec.source.sha256)
    expect((await import("node:fs")).readdirSync(appsDir)).toEqual(["test-remote-app"])
  })

  it(".agentapp: ref/subdir on a bundle url are rejected", async () => {
    const bundle = await packFixture("bundle")
    const res = await call("app_install", { url: bundle.url, ref: "main" })
    expect(isError(res)).toBe(true)
    expect(errText(res)).toContain("git URLs")
  })

  it("input union: exactly one source, otherwise a helpful error", async () => {
    for (const args of [{}, { dir: root, url: "https://x/y.git" }, { dir: root, file: "/a.agentapp" }, { dir: root, ref: "main" }, { file: "/a.agentapp", subdir: "x" }]) {
      const res = await call("app_install", args)
      expect(isError(res), JSON.stringify(args)).toBe(true)
      expect(errText(res)).toContain("exactly one source")
    }
  })

  it("app_resync: local installs and unknown apps are errors; {dir} installs carry no source", async () => {
    const dir = join(root, "local-app")
    await emitFixture(dir)
    const rec = parse(await call("app_install", { dir }))
    expect(rec.source).toBeUndefined()
    const local = await call("app_resync", { appId: rec.appId })
    expect(isError(local)).toBe(true)
    expect(errText(local)).toContain("local dir")
    expect(isError(await call("app_resync", { appId: "nope" }))).toBe(true)
  })

  async function makeUiGitRemote(name: string, prebuilt: boolean): Promise<{ url: string; work: string }> {
    const bare = join(root, `${name}.git`)
    const work = join(root, `${name}-work`)
    await mkdir(work, { recursive: true })
    git(work, "init", "-q", "-b", "main")
    await emitFixture(work)
    await addUiBuild(work, { prebuilt })
    git(work, "add", "-A")
    git(work, "commit", "-q", "-m", "init")
    git(root, "init", "-q", "--bare", "-b", "main", bare)
    git(work, "remote", "add", "origin", pathToFileURL(bare).href)
    git(work, "push", "-q", "origin", "main")
    return { url: pathToFileURL(bare).href, work }
  }

  const appsDirEntries = async (): Promise<string[]> => {
    try {
      return await readdir(appsDir)
    } catch {
      return []
    }
  }

  it("integrity: a wrong expected sha256 refuses the bundle and writes nothing; the right one installs", async () => {
    const src = join(root, "bundle-src")
    await emitFixture(src)
    const { file, manifest } = await packApp({ appDir: src, out: join(root, "x.agentapp") })

    const bad = await call("app_install", { file, sha256: "0".repeat(64) })
    expect(isError(bad)).toBe(true)
    expect(errText(bad)).toContain("digest mismatch")
    expect(await appsDirEntries()).toEqual([])

    const ok = await call("app_install", { file, sha256: manifest.sha256 })
    expect(isError(ok), errText(ok)).toBe(false)
    expect(parse(ok).source.sha256).toBe(manifest.sha256)
  })

  it("integrity: a wrong expected git sha is refused and leaves nothing behind", async () => {
    const remote = await makeGitRemote("pinned-app")
    const res = await call("app_install", { url: remote.url, sha: "f".repeat(40) })
    expect(isError(res)).toBe(true)
    expect(errText(res)).toContain("commit mismatch")
    expect(await appsDirEntries()).toEqual([])

    const sha = git(remote.work, "rev-parse", "HEAD")
    const ok = await call("app_install", { url: remote.url, sha })
    expect(isError(ok), errText(ok)).toBe(false)
  })

  it("ui.build from git: refused without allowBuild when the bundle is missing; built with allowBuild", async () => {
    const remote = await makeUiGitRemote("ui-app", false)
    const refused = await call("app_install", { url: remote.url })
    expect(isError(refused)).toBe(true)
    expect(errText(refused)).toContain("sh build.sh")
    expect(errText(refused)).toContain("allowBuild")
    expect(existsSync(join(appsDir, "ui-app", "build-ran.marker"))).toBe(false)

    const allowed = await call("app_install", { url: remote.url, allowBuild: true })
    expect(isError(allowed), errText(allowed)).toBe(false)
    const rec = parse(allowed)
    expect(existsSync(join(rec.dir, "build-ran.marker"))).toBe(true)
    expect(rec.ui.build).toEqual({ command: "sh build.sh" })
  })

  it("ui.build from git with a committed bundle installs without running the build and drops ui.build", async () => {
    const remote = await makeUiGitRemote("ui-prebuilt", true)
    const res = await call("app_install", { url: remote.url })
    expect(isError(res), errText(res)).toBe(false)
    const rec = parse(res)
    expect(existsSync(join(rec.dir, "build-ran.marker"))).toBe(false)
    expect(rec.ui.path).toBe(join(rec.dir, ".agentproto", "ui", "index.html"))
    expect(rec.ui.build).toBeUndefined()
  })

  it("a .agentapp that still declares ui.build installs without ever running it; allowBuild is rejected", async () => {
    const src = join(root, "ui-bundle-src")
    await emitFixture(src)
    await addUiBuild(src, { prebuilt: true })
    const { file } = await packApp({ appDir: src, out: join(root, "ui.agentapp") })

    const rejected = await call("app_install", { url: pathToFileURL(file).href, allowBuild: true })
    expect(isError(rejected)).toBe(true)
    expect(errText(rejected)).toContain("allowBuild")

    const res = await call("app_install", { file })
    expect(isError(res), errText(res)).toBe(false)
    const rec = parse(res)
    expect(existsSync(join(rec.dir, "build-ran.marker"))).toBe(false)
    expect(rec.ui.build).toBeUndefined()
  })

  it("remote installs default their dataDir to <state dir>/app-data/<id>, outside the code dir, and reinstall keeps it", async () => {
    const src = join(root, "data-src")
    await emitFixture(src)
    const { file } = await packApp({ appDir: src, out: join(root, "d.agentapp") })

    const first = parse(await call("app_install", { file }))
    const expected = join(root, "state", "app-data", encodeURIComponent("@test/remote-app"))
    expect(first.dataDir).toBe(expected)
    expect(first.dataDir.startsWith(first.dir)).toBe(false)
    await mkdir(first.dataDir, { recursive: true })
    await writeFile(join(first.dataDir, "keep.txt"), "mine")

    const again = await call("app_install", { file })
    expect(isError(again), errText(again)).toBe(false)
    expect(parse(again).dataDir).toBe(expected)
    expect(await readFile(join(expected, "keep.txt"), "utf8")).toBe("mine")
  })

  it("catalog-tracked bundle: app_updates reports 0.3.0 over 0.2.0 and app_resync follows the catalog", async () => {
    const files = new Map<string, Buffer | string>()
    const base = await serveFiles(files)
    const catalogUrl = `${base}/catalog.json`
    catalogConfig = { defaultSource: false, sources: [{ url: catalogUrl }] }

    const v2 = await publishBundle(files, base, "0.2.0")
    files.set("/catalog.json", catalogDoc(v2))
    const res = await call("app_install", { url: v2.url, sha256: v2.sha256, catalogUrl })
    expect(isError(res), errText(res)).toBe(false)
    const rec = parse(res)
    expect(rec.version).toBe("0.2.0")
    expect(rec.source.catalogId).toEqual({ url: catalogUrl, appId: "@test/remote-app" })

    expect(parse(await call("app_updates", { refresh: true }))).toMatchObject({
      updates: [],
      upToDate: ["@test/remote-app"],
    })
    expect(parse(await call("app_resync", { appId: "@test/remote-app" }))).toMatchObject({ changed: false })

    const v3 = await publishBundle(files, base, "0.3.0")
    files.set("/catalog.json", catalogDoc(v3))
    const upd = parse(await call("app_updates", { refresh: true }))
    expect(upd.updates).toHaveLength(1)
    expect(upd.updates[0]).toMatchObject({
      appId: "@test/remote-app",
      from: { version: "0.2.0", sha256: v2.sha256 },
      to: { version: "0.3.0", sha256: v3.sha256, url: v3.url },
      catalogUrl,
    })
    const listing = parse(await call("app_catalog", { refresh: true }))
    expect(listing.find((e: any) => e.appId === "@test/remote-app")).toMatchObject({
      installed: true,
      updateAvailable: true,
      installedVersion: "0.2.0",
    })

    const resync = parse(await call("app_resync", { appId: "@test/remote-app" }))
    expect(resync).toMatchObject({ changed: true, from: v2.sha256, to: v3.sha256, version: "0.3.0" })
    expect(parse(await call("app_updates", { refresh: true }))).toMatchObject({
      updates: [],
      upToDate: ["@test/remote-app"],
    })
  })

  it("a lower catalog version is not an update; another catalog's entry is ignored; untracked installs are listed", async () => {
    const files = new Map<string, Buffer | string>()
    const base = await serveFiles(files)
    const catalogUrl = `${base}/catalog.json`
    const otherUrl = `${base}/other.json`
    catalogConfig = { defaultSource: false, sources: [{ url: catalogUrl }, { url: otherUrl }] }
    const v1 = await publishBundle(files, base, "0.1.0")
    const v2 = await publishBundle(files, base, "0.2.0")
    const v9 = await publishBundle(files, base, "0.9.0")
    files.set("/catalog.json", catalogDoc(v1))
    files.set("/other.json", catalogDoc(v9))

    expect(isError(await call("app_install", { url: v2.url }))).toBe(false)
    expect(parse(await call("app_updates", { refresh: true }))).toMatchObject({
      updates: [],
      untracked: ["@test/remote-app"],
    })

    expect(isError(await call("app_install", { url: v2.url, catalogUrl }))).toBe(false)
    const upd = parse(await call("app_updates", { refresh: true }))
    expect(upd.updates).toEqual([])
    expect(upd.upToDate).toEqual(["@test/remote-app"])
    expect(parse(await call("app_resync", { appId: "@test/remote-app" }))).toMatchObject({ changed: false })
  })
})
