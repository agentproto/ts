import { afterEach, describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

import matter from "gray-matter"

import {
  AgentAppPackError,
  aggregateSha256,
  packApp,
  RELEASE_DEFAULT_EXCLUDE,
  globToRegExp,
  unpackApp,
} from "../pack.js"

const roots: string[] = []
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
})
async function mktmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "app-kit-pack-"))
  roots.push(d)
  return d
}

async function fixture(root: string): Promise<string> {
  const appDir = join(root, "demo-app")
  await mkdir(join(appDir, ".agentproto", "agents", "scout"), { recursive: true })
  await mkdir(join(appDir, "ui", "node_modules", "dep"), { recursive: true })
  await mkdir(join(appDir, "notes"), { recursive: true })
  await writeFile(
    join(appDir, ".agentproto", "APP.md"),
    `---\nid: demo-app\nname: Demo\nversion: 1.2.3\nagents:\n  - id: scout\n    path: .agentproto/agents/scout/AGENT.md\n---\n# Demo\n`,
  )
  await writeFile(join(appDir, ".agentproto", "agents", "scout", "AGENT.md"), "---\nid: scout\n---\nhi\n")
  await writeFile(join(appDir, "notes", "a.md"), "alpha\n")
  await writeFile(join(appDir, "ui", "node_modules", "dep", "x.js"), "skip me\n")
  return appDir
}

describe("packApp / unpackApp", () => {
  it("round-trips: manifest, sorted files, node_modules skipped, no manifest.json restored", async () => {
    const root = await mktmp()
    const appDir = await fixture(root)
    const out = join(root, "out", "demo.agentapp")

    const { file, manifest } = await packApp({ appDir, out })
    expect(file).toBe(out)
    expect(manifest.format).toBe("agentapp/v1")
    expect(manifest.id).toBe("demo-app")
    expect(manifest.version).toBe("1.2.3")
    expect(manifest.agents).toEqual(["scout"])
    expect(manifest.files).toEqual([...manifest.files].sort())
    expect(manifest.files).toContain("notes/a.md")
    expect(manifest.files.some((f) => f.includes("node_modules"))).toBe(false)
    expect(manifest.sha256).toBe(await aggregateSha256(appDir, manifest.files))

    const dest = join(root, "restored")
    const res = await unpackApp({ file, dest })
    expect(res.dir).toBe(dest)
    expect(res.manifest.sha256).toBe(manifest.sha256)
    expect(existsSync(join(dest, "manifest.json"))).toBe(false)
    expect(await readFile(join(dest, "notes", "a.md"), "utf8")).toBe("alpha\n")
    expect(existsSync(join(dest, "ui", "node_modules"))).toBe(false)
  })

  it("packApp rejects a dir without .agentproto/APP.md", async () => {
    const root = await mktmp()
    await expect(packApp({ appDir: root, out: join(root, "x.agentapp") })).rejects.toMatchObject({
      code: "not-an-app",
    })
  })

  it("unpackApp refuses a tampered bundle and creates nothing at dest", async () => {
    const root = await mktmp()
    const appDir = await fixture(root)
    const { file } = await packApp({ appDir, out: join(root, "demo.agentapp") })

    const scratch = join(root, "scratch")
    await mkdir(scratch)
    expect(spawnSync("tar", ["-xzf", file, "-C", scratch]).status).toBe(0)
    await writeFile(join(scratch, "notes", "a.md"), "tampered\n")
    const bad = join(root, "bad.agentapp")
    expect(spawnSync("tar", ["-czf", bad, ".agentproto", "manifest.json", "notes"], { cwd: scratch }).status).toBe(0)

    const dest = join(root, "dest")
    const err = await unpackApp({ file: bad, dest }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentAppPackError)
    expect((err as AgentAppPackError).code).toBe("digest-mismatch")
    expect(existsSync(dest)).toBe(false)
  })

  it("unpackApp refuses a manifest listing a path outside the bundle root", async () => {
    const root = await mktmp()
    const appDir = await fixture(root)
    const { file } = await packApp({ appDir, out: join(root, "demo.agentapp") })

    const scratch = join(root, "scratch")
    await mkdir(scratch)
    spawnSync("tar", ["-xzf", file, "-C", scratch])
    const manifest = JSON.parse(await readFile(join(scratch, "manifest.json"), "utf8"))
    manifest.files.push("../escape.txt")
    await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest))
    const bad = join(root, "bad.agentapp")
    spawnSync("tar", ["-czf", bad, ".agentproto", "manifest.json", "notes", "ui"], { cwd: scratch })

    await expect(unpackApp({ file: bad, dest: join(root, "dest") })).rejects.toMatchObject({ code: "unsafe-path" })
  })

  it("unpackApp reports a missing bundle and a missing manifest", async () => {
    const root = await mktmp()
    await expect(unpackApp({ file: join(root, "nope.agentapp") })).rejects.toMatchObject({ code: "bundle-not-found" })
    await mkdir(join(root, "s"))
    await writeFile(join(root, "s", "f.txt"), "x")
    const bundle = join(root, "nomanifest.agentapp")
    spawnSync("tar", ["-czf", bundle, "f.txt"], { cwd: join(root, "s") })
    await expect(unpackApp({ file: bundle, dest: join(root, "d") })).rejects.toMatchObject({ code: "missing-manifest" })
  })

  it("globToRegExp: ** spans segments, * stays in one", () => {
    expect(globToRegExp("ui/**").test("ui/src/a.ts")).toBe(true)
    expect(globToRegExp("**/dev/**").test("ui/dev/x.html")).toBe(true)
    expect(globToRegExp("**/dev/**").test("dev/x.html")).toBe(true)
    expect(globToRegExp("**/*.log").test(".agentproto/ui-build.log")).toBe(true)
    expect(globToRegExp("*.md").test("notes/a.md")).toBe(false)
    expect(globToRegExp(".agentproto/**").test(".agentproto/APP.md")).toBe(true)
    expect(RELEASE_DEFAULT_EXCLUDE).toContain("ui/**")
    // A shipped agent named `dev` must survive the release defaults.
    const defaults = RELEASE_DEFAULT_EXCLUDE.map(globToRegExp)
    expect(defaults.some((re) => re.test(".agentproto/agents/dev/AGENT.md"))).toBe(false)
    expect(defaults.some((re) => re.test("dev/fixture.json"))).toBe(true)
  })

  async function releaseFixture(root: string, opts: { built: boolean; extraFront?: string }): Promise<string> {
    const appDir = join(root, "rel-app")
    await mkdir(join(appDir, ".agentproto", "ui"), { recursive: true })
    await mkdir(join(appDir, "ui", "src"), { recursive: true })
    await mkdir(join(appDir, "ui", "dev"), { recursive: true })
    await mkdir(join(appDir, "docs"), { recursive: true })
    await mkdir(join(appDir, "data"), { recursive: true })
    await writeFile(
      join(appDir, ".agentproto", "APP.md"),
      "---\nid: rel-app\nversion: 0.2.0\nui:\n  path: .agentproto/ui/index.html\n  build:\n    command: pnpm run build\n    cwd: ui\n" +
        (opts.extraFront ?? "") +
        "---\n# Rel\n",
    )
    if (opts.built) await writeFile(join(appDir, ".agentproto", "ui", "index.html"), "<html></html>\n")
    await writeFile(join(appDir, ".agentproto", "ui-build.log"), "log\n")
    await writeFile(join(appDir, "ui", "src", "main.tsx"), "src\n")
    await writeFile(join(appDir, "ui", "dev", "x.html"), "dev\n")
    await writeFile(join(appDir, "docs", "README.md"), "docs\n")
    await writeFile(join(appDir, "data", "shot.png"), "png\n")
    await writeFile(join(appDir, "ui", "bundle.js.map"), "map\n")
    return appDir
  }

  it("release pack ships only .agentproto (no sources/docs/data/logs/maps) and strips ui.build", async () => {
    const root = await mktmp()
    const appDir = await releaseFixture(root, { built: true })
    const out = join(root, "rel.agentapp")
    const { manifest } = await packApp({ appDir, out, release: true })
    expect(manifest.files).toEqual([".agentproto/APP.md", ".agentproto/ui/index.html"])

    const dest = join(root, "rel-restored")
    await unpackApp({ file: out, dest })
    const fm = matter(await readFile(join(dest, ".agentproto", "APP.md"), "utf8")).data as {
      ui: Record<string, unknown>
    }
    expect(fm.ui.path).toBe(".agentproto/ui/index.html")
    expect(fm.ui.build).toBeUndefined()
    expect(existsSync(join(dest, "ui"))).toBe(false)
    expect(existsSync(join(dest, "docs"))).toBe(false)
    // The source APP.md on disk is untouched.
    expect(await readFile(join(appDir, ".agentproto", "APP.md"), "utf8")).toContain("command: pnpm run build")
  })

  it("release pack fails with missing-ui when ui.path was never built", async () => {
    const root = await mktmp()
    const appDir = await releaseFixture(root, { built: false })
    await expect(packApp({ appDir, out: join(root, "x.agentapp"), release: true })).rejects.toMatchObject({
      code: "missing-ui",
    })
  })

  it("package.stripBuild:false keeps ui.build; package.exclude adds to the release defaults", async () => {
    const root = await mktmp()
    const appDir = await releaseFixture(root, {
      built: true,
      extraFront: "package:\n  stripBuild: false\n  exclude:\n    - \".agentproto/ui/*.html.bak\"\n",
    })
    await writeFile(join(appDir, ".agentproto", "ui", "old.html.bak"), "bak\n")
    const out = join(root, "keep.agentapp")
    const { manifest } = await packApp({ appDir, out, release: true })
    expect(manifest.files).not.toContain(".agentproto/ui/old.html.bak")
    const dest = join(root, "keep-restored")
    await unpackApp({ file: out, dest })
    expect(await readFile(join(dest, ".agentproto", "APP.md"), "utf8")).toContain("command: pnpm run build")
  })

  it("package.include restricts a non-release pack; invalid package block is rejected", async () => {
    const root = await mktmp()
    const appDir = await fixture(root)
    await writeFile(
      join(appDir, ".agentproto", "APP.md"),
      `---\nid: demo-app\nversion: 1.2.3\npackage:\n  include:\n    - ".agentproto/**"\n---\n# Demo\n`,
    )
    const { manifest } = await packApp({ appDir, out: join(root, "inc.agentapp") })
    expect(manifest.files.every((f) => f.startsWith(".agentproto/"))).toBe(true)
    expect(manifest.files).not.toContain("notes/a.md")

    await writeFile(join(appDir, ".agentproto", "APP.md"), `---\nid: demo-app\npackage: nope\n---\n`)
    await expect(packApp({ appDir, out: join(root, "bad.agentapp") })).rejects.toMatchObject({
      code: "invalid-package",
    })
  })
})
