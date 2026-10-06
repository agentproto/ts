/**
 * Tests for `agentproto catalog verify` (commands/catalog.ts): every check
 * runs against a REAL release-packed fixture bundle, substituted via
 * --offline-file, so no test touches the network. Failure cases mutate the
 * entry (size, sha256, APP.md id/version) or the APP.md (ui.build), not the
 * bundle, since a real bundle's digest always matches itself.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { runCatalog } from "../commands/catalog.js"
import { runAppPack } from "../commands/app.js"

const tmpRoots: string[] = []

afterEach(async () => {
  for (const p of tmpRoots) await rm(p, { recursive: true, force: true })
  tmpRoots.length = 0
  vi.restoreAllMocks()
})

async function mktmp(prefix = "catalog-verify-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tmpRoots.push(dir)
  return dir
}

async function runVerify(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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
    const code = await runCatalog(["verify", ...args])
    return { code, stdout: out.join(""), stderr: err.join("") }
  } finally {
    so.mockRestore()
    se.mockRestore()
  }
}

/** Pack a fixture app in release+entry mode; returns { entry, entryPath, bundle }. */
async function packFixture(root: string): Promise<{ entry: Record<string, unknown>; entryPath: string; bundle: string }> {
  const appDir = join(root, "verify-app")
  await mkdir(join(appDir, ".agentproto", "ui"), { recursive: true })
  await writeFile(
    join(appDir, ".agentproto", "APP.md"),
    `---\n` +
      `schema: app/v1\n` +
      `id: verify-app\n` +
      `name: Verify App\n` +
      `version: 1.0.0\n` +
      `description: Verify fixture\n` +
      `agents: []\n` +
      `workflows: []\n` +
      `ui:\n` +
      `  path: .agentproto/ui/index.html\n` +
      `---\n` +
      `# Verify\n`,
    "utf8",
  )
  await writeFile(join(appDir, ".agentproto", "ui", "index.html"), "<html>verify</html>\n", "utf8")

  const outDir = join(root, "dist")
  const so = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
  const se = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  try {
    expect(await runAppPack([appDir, "--release", "--entry", "--out", outDir])).toBe(0)
  } finally {
    so.mockRestore()
    se.mockRestore()
  }
  const bundle = join(outDir, "verify-app-1.0.0.agentapp")
  const entryPath = join(outDir, "verify-app-1.0.0.entry.json")
  const entry = JSON.parse(await readFile(entryPath, "utf8"))
  return { entry, entryPath, bundle }
}

async function writeEntry(root: string, name: string, entry: unknown): Promise<string> {
  const p = join(root, name)
  await writeFile(p, JSON.stringify(entry, null, 2) + "\n", "utf8")
  return p
}

describe("catalog verify", () => {
  it("passes for a real packed fixture (offline-file, no network)", async () => {
    const root = await mktmp()
    const { entry, entryPath, bundle } = await packFixture(root)
    const res = await runVerify([
      entryPath,
      "--offline-file",
      `verify-app=${bundle}`,
    ])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain("ok   verify-app")
    expect(res.stdout).toContain("[ok] sha256")
    expect(res.stdout).toContain("[ok] size")
    expect(res.stdout).toContain("[ok] app-id")
    expect(res.stdout).toContain("[ok] app-version")
    expect(res.stdout).toContain("[ok] no-ui-build")
    expect(res.stdout).toContain("[ok] app-validate")
  })

  it("--json prints the full report", async () => {
    const root = await mktmp()
    const { entry, entryPath, bundle } = await packFixture(root)
    const res = await runVerify([entryPath, "--json", "--offline-file", `verify-app=${bundle}`])
    expect(res.code).toBe(0)
    const report = JSON.parse(res.stdout) as { ok: boolean; entries: { appId: string; ok: boolean; checks: { name: string; ok: boolean }[] }[] }
    const first = report.entries[0]
    expect(report.ok).toBe(true)
    expect(first?.appId).toBe("verify-app")
    expect(first?.checks.every((c) => c.ok)).toBe(true)
    expect(first?.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(["schema", "source-kind", "download", "size", "sha256", "app-id", "app-version", "no-ui-build", "app-validate"]),
    )
  })

  it("fails on a wrong source.size", async () => {
    const root = await mktmp()
    const { entry, bundle } = await packFixture(root)
    const bad = { ...entry, source: { ...(entry.source as object), size: 12345 } }
    const p = await writeEntry(root, "bad-size.json", bad)
    const res = await runVerify([p, "--offline-file", `verify-app=${bundle}`])
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("size")
  })

  it("fails on a wrong source.sha256 (manifest digest mismatch)", async () => {
    const root = await mktmp()
    const { entry, bundle } = await packFixture(root)
    const bad = { ...entry, source: { ...(entry.source as object), sha256: "c".repeat(64) } }
    const p = await writeEntry(root, "bad-sha.json", bad)
    const res = await runVerify([p, "--offline-file", `verify-app=${bundle}`])
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("sha256")
  })

  it("fails when the APP.md id or version differ from the entry", async () => {
    const root = await mktmp()
    const { entry, bundle } = await packFixture(root)
    const p1 = await writeEntry(root, "bad-id.json", { ...entry, appId: "other-app" })
    const res1 = await runVerify([p1, "--offline-file", `other-app=${bundle}`])
    expect(res1.code).toBe(1)
    expect(res1.stderr).toContain("app-id")

    const p2 = await writeEntry(root, "bad-ver.json", {
      ...entry,
      version: "2.0.0",
      source: { ...(entry.source as object), version: "2.0.0" },
    })
    const res2 = await runVerify([p2, "--offline-file", `verify-app=${bundle}`])
    expect(res2.code).toBe(1)
    expect(res2.stderr).toContain("app-version")
  })

  it("fails when the packed APP.md still declares ui.build", async () => {
    const root = await mktmp()
    // Pack WITHOUT --release so ui.build stays in the APP.md.
    const appDir = join(root, "build-app")
    await mkdir(join(appDir, ".agentproto", "ui"), { recursive: true })
    await writeFile(
      join(appDir, ".agentproto", "APP.md"),
      "---\nid: build-app\nversion: 1.0.0\nui:\n  path: .agentproto/ui/index.html\n  build:\n    command: sh build.sh\n---\n# B\n",
      "utf8",
    )
    await writeFile(join(appDir, ".agentproto", "ui", "index.html"), "<html>b</html>\n", "utf8")
    const bundle = join(root, "build-app.agentapp")
    const so = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const se = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      expect(await runAppPack([appDir, "--out", bundle])).toBe(0)
    } finally {
      so.mockRestore()
      se.mockRestore()
    }
    // Extract the real manifest digest so only the ui.build check fails.
    const { unpackApp } = await import("@agentproto/app-kit")
    const dest = join(root, "peek")
    const { manifest: m } = await unpackApp({ file: bundle, dest })
    const entry = {
      appId: "build-app",
      version: "1.0.0",
      tier: "bundle",
      license: { kind: "free" },
      source: {
        kind: "agentapp",
        url: "https://example.com/build-app-1.0.0.agentapp",
        sha256: m.sha256,
        version: "1.0.0",
        size: m.totalSize,
      },
    }
    const p = await writeEntry(root, "build.json", entry)
    const res = await runVerify([p, "--offline-file", `build-app=${bundle}`])
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("no-ui-build")
  })

  it("refuses git sources unless --allow-git", async () => {
    const root = await mktmp()
    const gitEntry = {
      appId: "git-app",
      version: "1.0.0",
      tier: "git",
      source: { kind: "git", url: "https://github.com/example/app", sha: "a".repeat(40) },
    }
    const p = await writeEntry(root, "git.json", gitEntry)
    const refused = await runVerify([p])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("bundles only")

    const allowed = await runVerify([p, "--allow-git"])
    expect(allowed.code).toBe(0)
    expect(allowed.stdout).toContain("git source allowed")
  })

  it("refuses a non-https source.url", async () => {
    const root = await mktmp()
    const { AppCatalogEntrySchema } = await import("@agentproto/runtime/app-catalog")
    const entry = AppCatalogEntrySchema.parse({
      appId: "http-app",
      version: "1.0.0",
      tier: "bundle",
      license: { kind: "free" },
      source: {
        kind: "agentapp",
        url: "http://example.com/app.agentapp",
        sha256: "b".repeat(64),
        version: "1.0.0",
      },
    })
    const p = await writeEntry(root, "http.json", entry)
    const res = await runVerify([p])
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("https://")
  })

  it("an invalid entry file fails schema with the path named", async () => {
    const root = await mktmp()
    const p = await writeEntry(root, "bad.json", { appId: "oops" })
    const res = await runVerify([p])
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("bad.json")
  })

  it("an existing directory with no *.json verifies 0 entries", async () => {
    const root = await mktmp()
    await mkdir(join(root, "entries"), { recursive: true })
    await writeFile(join(root, "entries", ".gitkeep"), "", "utf8")
    const res = await runVerify([join(root, "entries")])
    expect(res.code).toBe(0)
    expect(res.stdout).toContain("0 entries verified")
  })
})
