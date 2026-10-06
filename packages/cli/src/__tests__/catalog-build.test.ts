/**
 * Tests for `agentproto catalog build` (commands/catalog.ts): validation,
 * merge by appId (higher version wins, older refused with a warning),
 * deterministic sorted output, --check, --emit-ts, and the end-to-end
 * publishing path: pack --release --entry -> catalog build -> an entry
 * that passes AppCatalogEntrySchema with the sha256 unpack verifies.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL, fileURLToPath } from "node:url"

import { AppCatalogEntrySchema, type AppCatalogEntry } from "@agentproto/runtime/app-catalog"
import { runCatalog } from "../commands/catalog.js"
import { runAppPack } from "../commands/app.js"

const emitFiles: string[] = []
const tmpRoots: string[] = []

afterEach(async () => {
  for (const p of [...tmpRoots, ...emitFiles]) await rm(p, { recursive: true, force: true })
  tmpRoots.length = 0
  emitFiles.length = 0
  vi.restoreAllMocks()
})

async function mktmp(prefix = "catalog-build-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tmpRoots.push(dir)
  return dir
}

function entry(overrides: Partial<AppCatalogEntry> & { appId: string; version: string }): AppCatalogEntry {
  return {
    tier: "bundle",
    license: { kind: "free" },
    source: {
      kind: "agentapp",
      url: `https://github.com/agentproto/apps/releases/download/x%40${overrides.version}/x.agentapp`,
      sha256: "b".repeat(64),
      version: overrides.version,
      size: 100,
    },
    ...overrides,
  } as AppCatalogEntry
}

async function writeEntry(dir: string, name: string, entry: unknown): Promise<string> {
  const p = join(dir, name)
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, JSON.stringify(entry, null, 2) + "\n", "utf8")
  return p
}

async function runBuild(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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
    const code = await runCatalog(["build", ...args])
    return { code, stdout: out.join(""), stderr: err.join("") }
  } finally {
    so.mockRestore()
    se.mockRestore()
  }
}

describe("catalog build", () => {
  it("merges base + new entries and writes a sorted, deterministic document", async () => {
    const root = await mktmp()
    const base = {
      schema: "app-catalog/v1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      entries: [entry({ appId: "zeta", version: "1.0.0" })],
    }
    const basePath = join(root, "base.json")
    await writeFile(basePath, JSON.stringify(base, null, 2) + "\n", "utf8")
    const e1 = await writeEntry(root, "alpha.entry.json", entry({ appId: "alpha", version: "0.9.0" }))
    const e2 = await writeEntry(root, "beta.entry.json", entry({ appId: "beta", version: "2.0.0" }))
    const out = join(root, "apps.json")

    const res = await runBuild([e1, e2, "--base", basePath, "--out", out, "--generated-at", "2026-02-02T00:00:00.000Z"])
    expect(res.code).toBe(0)
    const doc = JSON.parse(await readFile(out, "utf8"))
    expect(doc.schema).toBe("app-catalog/v1")
    expect(doc.generatedAt).toBe("2026-02-02T00:00:00.000Z")
    expect(doc.entries.map((e: AppCatalogEntry) => e.appId)).toEqual(["alpha", "beta", "zeta"])
    // deterministic serialization: 2-space indent + trailing newline
    const raw = await readFile(out, "utf8")
    expect(raw.endsWith("\n")).toBe(true)
    expect(raw).toBe(JSON.stringify(doc, null, 2) + "\n")
  })

  it("replaces an existing entry when the incoming version is higher", async () => {
    const root = await mktmp()
    const basePath = join(root, "base.json")
    await writeFile(
      basePath,
      JSON.stringify({ schema: "app-catalog/v1", generatedAt: "2026-01-01T00:00:00.000Z", entries: [entry({ appId: "alpha", version: "1.0.0" })] }, null, 2) + "\n",
      "utf8",
    )
    const e = await writeEntry(root, "alpha.entry.json", entry({ appId: "alpha", version: "1.1.0" }))
    const out = join(root, "apps.json")
    const res = await runBuild([e, "--base", basePath, "--out", out, "--generated-at", "2026-03-03T00:00:00.000Z"])
    expect(res.code).toBe(0)
    const doc = JSON.parse(await readFile(out, "utf8"))
    expect(doc.entries).toHaveLength(1)
    expect(doc.entries[0].version).toBe("1.1.0")
  })

  it("keeps the existing entry and warns when the incoming version is older", async () => {
    const root = await mktmp()
    const basePath = join(root, "base.json")
    await writeFile(
      basePath,
      JSON.stringify({ schema: "app-catalog/v1", generatedAt: "2026-01-01T00:00:00.000Z", entries: [entry({ appId: "alpha", version: "2.0.0" })] }, null, 2) + "\n",
      "utf8",
    )
    const e = await writeEntry(root, "alpha.entry.json", entry({ appId: "alpha", version: "1.9.0" }))
    const out = join(root, "apps.json")
    const res = await runBuild([e, "--base", basePath, "--out", out, "--generated-at", "2026-03-03T00:00:00.000Z"])
    expect(res.code).toBe(0)
    expect(res.stderr).toContain("1.9.0 is older than the existing 2.0.0")
    const doc = JSON.parse(await readFile(out, "utf8"))
    expect(doc.entries[0].version).toBe("2.0.0")
  })

  it("exits 1 naming the file for an invalid entry", async () => {
    const root = await mktmp()
    const e = await writeEntry(root, "bad.entry.json", { appId: "oops", source: { kind: "agentapp" } })
    const res = await runBuild([e, "--out", join(root, "apps.json")])
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("bad.entry.json")
  })

  it("reads *.json from a directory recursively and accepts explicit files of any name", async () => {
    const root = await mktmp()
    await mkdir(join(root, "nested", "deeper"), { recursive: true })
    // any file name is accepted, not only *.entry.json (the agentproto/apps
    // repo holds entries/<appId>.json)
    await writeEntry(join(root, "entries"), "@agentik/one.json", entry({ appId: "one", version: "1.0.0" }))
    await writeFile(join(root, "nested", "deeper", "two.json"), JSON.stringify(entry({ appId: "two", version: "1.0.0" })), "utf8")
    const out = join(root, "apps.json")
    const res = await runBuild([join(root, "entries"), join(root, "nested"), "--out", out, "--generated-at", "2026-04-04T00:00:00.000Z"])
    expect(res.code).toBe(0)
    const doc = JSON.parse(await readFile(out, "utf8"))
    expect(doc.entries.map((e: AppCatalogEntry) => e.appId)).toEqual(["one", "two"])
  })

  it("errors (exit 1) on a duplicate appId among the given entries", async () => {
    const root = await mktmp()
    const e1 = await writeEntry(root, "a/alpha.json", entry({ appId: "alpha", version: "1.0.0" }))
    const e2 = await writeEntry(root, "b/alpha.json", entry({ appId: "alpha", version: "1.1.0" }))
    const res = await runBuild([e1, e2, "--out", join(root, "apps.json")])
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("duplicate appId 'alpha'")
  })

  it("without --base, the catalog is exactly the given entries (deletions propagate)", async () => {
    const root = await mktmp()
    const e = await writeEntry(root, "alpha.json", entry({ appId: "alpha", version: "1.0.0" }))
    const out = join(root, "apps.json")
    expect((await runBuild([e, "--out", out, "--generated-at", "2026-04-04T00:00:00.000Z"])).code).toBe(0)
    expect(JSON.parse(await readFile(out, "utf8")).entries).toHaveLength(1)
  })

  it("keeps --base generatedAt when nothing changed", async () => {
    const root = await mktmp()
    const unchanged = entry({ appId: "alpha", version: "1.0.0" })
    const basePath = join(root, "base.json")
    await writeFile(
      basePath,
      JSON.stringify({ schema: "app-catalog/v1", generatedAt: "2026-01-01T00:00:00.000Z", entries: [unchanged] }, null, 2) + "\n",
      "utf8",
    )
    // same entry re-published: no diff -> base generatedAt preserved
    const e = await writeEntry(root, "alpha.entry.json", unchanged)
    const out = join(root, "apps.json")
    const res = await runBuild([e, "--base", basePath, "--out", out])
    expect(res.code).toBe(0)
    const doc = JSON.parse(await readFile(out, "utf8"))
    expect(doc.generatedAt).toBe("2026-01-01T00:00:00.000Z")
  })

  it("--check passes in sync and fails out of sync without writing", async () => {
    const root = await mktmp()
    const e = await writeEntry(root, "alpha.entry.json", entry({ appId: "alpha", version: "1.0.0" }))
    const out = join(root, "apps.json")
    const gen = "--generated-at"

    // First materialize the catalog.
    expect((await runBuild([e, "--out", out, gen, "2026-05-05T00:00:00.000Z"])).code).toBe(0)

    // In sync (a different generatedAt must be ignored by --check).
    const ok = await runBuild([e, "--out", out, "--check", gen, "2026-06-06T00:00:00.000Z"])
    expect(ok.code).toBe(0)

    // Out of sync: build a newer version elsewhere and check against it.
    const e2 = await writeEntry(root, "alpha2.entry.json", entry({ appId: "alpha", version: "1.1.0" }))
    const before = await readFile(out, "utf8")
    const bad = await runBuild([e2, "--out", out, "--check"])
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain("--check failed")
    expect(await readFile(out, "utf8")).toBe(before)

    // --check on a missing --out fails too.
    expect((await runBuild([e, "--out", join(root, "missing.json"), "--check"])).code).toBe(1)
  })

  it("--emit-ts writes a file whose FIRST_PARTY_CATALOG_ENTRIES equals the entries", async () => {
    const root = await mktmp()
    const alpha = entry({ appId: "alpha", version: "1.0.0", name: "Alpha" })
    const beta = entry({ appId: "beta", version: "0.1.0" })
    const e1 = await writeEntry(root, "alpha.entry.json", alpha)
    const e2 = await writeEntry(root, "beta.entry.json", beta)
    const tsFile = join(root, "first-party-catalog.ts")

    const res = await runBuild([e1, e2, "--out", join(root, "apps.json"), "--emit-ts", tsFile, "--generated-at", "2026-07-07T00:00:00.000Z"])
    expect(res.code).toBe(0)
    expect(existsSync(tsFile)).toBe(true)

    // Make the emitted module importable where we stand: point its relative
    // type import at the installed runtime package, place it inside the
    // package (vitest's transform root), then import it.
    const emitted = await readFile(tsFile, "utf8")
    expect(emitted).toContain('import type { AppCatalogEntry } from "./app-catalog.js"')
    expect(emitted).toContain("export const FIRST_PARTY_CATALOG_ENTRIES")
    expect(emitted.indexOf('"alpha"')).toBeLessThan(emitted.indexOf('"beta"')) // sorted

    const importable = join(dirname(fileURLToPath(import.meta.url)), `.emit-fpc-${Date.now()}.ts`)
    emitFiles.push(importable)
    await writeFile(
      importable,
      emitted.replace('from "./app-catalog.js"', 'from "@agentproto/runtime/app-catalog"'),
      "utf8",
    )
    const mod = (await import(pathToFileURL(importable).href)) as {
      FIRST_PARTY_CATALOG_ENTRIES: readonly AppCatalogEntry[]
    }
    expect(mod.FIRST_PARTY_CATALOG_ENTRIES).toEqual([alpha, beta])
    expect(AppCatalogEntrySchema.safeParse(mod.FIRST_PARTY_CATALOG_ENTRIES[0]).success).toBe(true)
  })
})

// ── end to end ───────────────────────────────────────────────────────────

describe("publish pipeline end to end", () => {
  it("pack --release --entry -> catalog build -> schema-valid entry whose sha256 unpack verifies", async () => {
    const root = await mktmp()
    // Fixture app
    const appDir = join(root, "e2e-app")
    await mkdir(join(appDir, ".agentproto", "ui"), { recursive: true })
    await writeFile(
      join(appDir, ".agentproto", "APP.md"),
      "---\nid: e2e-app\nname: E2E App\nversion: 1.4.0\ndescription: End to end\ncategory: demo\nui:\n  path: .agentproto/ui/index.html\n---\n# E2E\n",
      "utf8",
    )
    await writeFile(join(appDir, ".agentproto", "ui", "index.html"), "<html>e2e</html>\n", "utf8")

    // 1. pack --release --entry (bundle + catalog entry in a dist dir)
    const outDir = join(root, "dist")
    const packOut: string[] = []
    const packErr: string[] = []
    const so = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      packOut.push(String(c))
      return true
    })
    const se = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      packErr.push(String(c))
      return true
    })
    const packCode = await runAppPack([appDir, "--release", "--entry", "--out", outDir])
    so.mockRestore()
    se.mockRestore()
    expect(packCode).toBe(0)

    const bundle = join(outDir, "e2e-app-1.4.0.agentapp")
    const entryFile = join(outDir, "e2e-app-1.4.0.entry.json")
    const rawEntry = JSON.parse(await readFile(entryFile, "utf8"))

    // 2. the entry passes AppCatalogEntrySchema
    const parsed = AppCatalogEntrySchema.parse(rawEntry)

    // 3. catalog build accepts it
    const out = join(root, "apps.json")
    const build = await runBuild([entryFile, "--out", out, "--generated-at", "2026-08-08T00:00:00.000Z"])
    expect(build.code).toBe(0)
    const doc = JSON.parse(await readFile(out, "utf8"))
    expect(doc.entries[0].appId).toBe("e2e-app")

    // 4. the entry's sha256 is what unpack/stageAgentApp verifies
    const { unpackApp } = await import("@agentproto/app-kit")
    const { manifest } = await unpackApp({ file: bundle, dest: join(root, "restored") })
    expect(parsed.source.kind).toBe("agentapp")
    if (parsed.source.kind === "agentapp") {
      expect(parsed.source.sha256).toBe(manifest.sha256)
      expect(parsed.source.size).toBe(rawEntry.source.size)
      expect(parsed.source.url).toBe(
        "https://github.com/agentproto/apps/releases/download/e2e-app%401.4.0/e2e-app-1.4.0.agentapp",
      )
    }
  })
})

