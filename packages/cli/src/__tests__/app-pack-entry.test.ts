/**
 * Tests for `app pack --release --entry` (commands/app.ts + the pure
 * builder): the catalog entry's sha256/size/url/version, the flag
 * contract (--entry requires --release, missing version is an error),
 * and the .agentapp/.entry.json naming.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { runAppPack, runAppUnpack } from "../commands/app.js"

const tmpRoots: string[] = []

afterEach(async () => {
  for (const p of tmpRoots) await rm(p, { recursive: true, force: true })
  tmpRoots.length = 0
  vi.restoreAllMocks()
})

async function mktmp(prefix = "pack-entry-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tmpRoots.push(dir)
  return dir
}

/** Minimal static-UI app fixture (release-packable without a build step). */
async function buildFixture(root: string, appMd?: string): Promise<string> {
  const appDir = join(root, "shop-app")
  await mkdir(join(appDir, ".agentproto", "ui"), { recursive: true })
  await writeFile(
    join(appDir, ".agentproto", "APP.md"),
    appMd ??
      `---\n` +
        `id: "@agentik/shop-app"\n` +
        `name: Shop App\n` +
        `version: 2.0.1\n` +
        `description: A shop\n` +
        `category: commerce\n` +
        `icon: shop.svg\n` +
        `placement: any\n` +
        `ui:\n` +
        `  path: .agentproto/ui/index.html\n` +
        `---\n` +
        `# Shop\n`,
    "utf8",
  )
  await writeFile(
    join(appDir, ".agentproto", "ui", "index.html"),
    "<!doctype html><html><body>shop</body></html>\n",
    "utf8",
  )
  return appDir
}

interface Packed {
  code: number
  stdout: string
  stderr: string
}

async function runPack(args: string[]): Promise<Packed> {
  const out: string[] = []
  const err: string[] = []
  const so = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
    out.push(String(c))
    return true
  })
  const se = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
    err.push(String(c))
    return true
  })
  try {
    const code = await runAppPack(args)
    return { code, stdout: out.join(""), stderr: err.join("") }
  } finally {
    so.mockRestore()
    se.mockRestore()
  }
}

describe("app pack --release --entry", () => {
  it("writes <slug>-<version>.agentapp and a matching .entry.json with correct sha256/size/url", async () => {
    const root = await mktmp()
    const appDir = await buildFixture(root)
    const outDir = join(root, "dist")

    const res = await runPack([appDir, "--release", "--entry", "--out", outDir, "--publisher", "Agentik"])
    expect(res.code).toBe(0)

    const bundle = join(outDir, "shop-app-2.0.1.agentapp")
    const entryFile = join(outDir, "shop-app-2.0.1.entry.json")
    expect(existsSync(bundle)).toBe(true)
    expect(existsSync(entryFile)).toBe(true)

    const entry = JSON.parse(await readFile(entryFile, "utf8"))
    expect(entry.appId).toBe("@agentik/shop-app")
    expect(entry.name).toBe("Shop App")
    expect(entry.description).toBe("A shop")
    expect(entry.category).toBe("commerce")
    expect(entry.icon).toBe("shop.svg")
    expect(entry.version).toBe("2.0.1")
    expect(entry.tier).toBe("bundle")
    expect(entry.placement).toBe("any")
    expect(entry.publisher).toBe("Agentik")
    expect(entry.license).toEqual({ kind: "free" })
    expect(entry.source.kind).toBe("agentapp")
    expect(entry.source.url).toBe(
      "https://github.com/agentproto/apps/releases/download/shop-app%402.0.1/shop-app-2.0.1.agentapp",
    )
    expect(entry.source.version).toBe("2.0.1")
    expect(entry.source.size).toBe((await stat(bundle)).size)
    expect(entry.source.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it("entry sha256 is the manifest digest verified by unpack (app_install contract)", async () => {
    const root = await mktmp()
    const appDir = await buildFixture(root)
    const outDir = join(root, "dist")
    await runPack([appDir, "--release", "--entry", "--out", outDir])

    const bundle = join(outDir, "shop-app-2.0.1.agentapp")
    const entry = JSON.parse(await readFile(join(outDir, "shop-app-2.0.1.entry.json"), "utf8"))

    // unpackApp verifies the aggregate sha256 exactly like stageAgentApp
    // does at install time; a wrong entry digest would not match it.
    const dest = join(root, "restored")
    const { unpackApp } = await import("@agentproto/app-kit")
    const unpacked = await unpackApp({ file: bundle, dest })
    expect(unpacked.manifest.sha256).toBe(entry.source.sha256)
    expect(entry.source.size).toBe((await stat(bundle)).size)
    await expect(runAppUnpack([bundle, "--dir", join(root, "restored-2")])).resolves.toBe(0)
  })

  it("--asset-url overrides the GitHub Releases URL; --out ending in .agentapp is used as-is", async () => {
    const root = await mktmp()
    const appDir = await buildFixture(root)
    const bundle = join(root, "custom.agentapp")

    const res = await runPack([
      appDir, "--release", "--entry", "--out", bundle, "--asset-url", "https://cdn.example.com/shop-app.agentapp",
    ])
    expect(res.code).toBe(0)
    expect(existsSync(bundle)).toBe(true)
    const entry = JSON.parse(await readFile(join(root, "shop-app-2.0.1.entry.json"), "utf8"))
    expect(entry.source.url).toBe("https://cdn.example.com/shop-app.agentapp")
  })

  it("--json prints the entry", async () => {
    const root = await mktmp()
    const appDir = await buildFixture(root)
    const res = await runPack([appDir, "--release", "--entry", "--out", join(root, "dist"), "--json"])
    expect(res.code).toBe(0)
    const parsed = JSON.parse(res.stdout) as { entry: { appId: string }; entryFile: string; bundle: string }
    expect(parsed.entry.appId).toBe("@agentik/shop-app")
    expect(existsSync(parsed.entryFile)).toBe(true)
    expect(existsSync(parsed.bundle)).toBe(true)
  })

  it("refuses --entry without --release (exit 2)", async () => {
    const root = await mktmp()
    const appDir = await buildFixture(root)
    const res = await runPack([appDir, "--entry"])
    expect(res.code).toBe(2)
    expect(res.stderr).toContain("--entry requires --release")
  })

  it("fails clearly when APP.md has no version", async () => {
    const root = await mktmp()
    const appDir = await buildFixture(
      root,
      "---\nid: shop-app\nname: Shop\nui:\n  path: .agentproto/ui/index.html\n---\n# Shop\n",
    )
    const res = await runPack([appDir, "--release", "--entry", "--out", join(root, "dist")])
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("version")
  })

  it("defaults the bundle location to cwd when --out is absent", async () => {
    const root = await mktmp()
    const cwd = await mktmp("pack-entry-cwd-")
    const appDir = await buildFixture(root)
    const original = process.cwd()
    process.chdir(cwd)
    try {
      const res = await runPack([appDir, "--release", "--entry"])
      expect(res.code).toBe(0)
    } finally {
      process.chdir(original)
    }
    expect(existsSync(join(cwd, "shop-app-2.0.1.agentapp"))).toBe(true)
    expect(existsSync(join(cwd, "shop-app-2.0.1.entry.json"))).toBe(true)
  })
})
