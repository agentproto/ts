/**
 * Tests for the agentproto app bundler (`commands/app.ts`): `app pack`
 * produces a `.agentapp` tar.gz, and `app unpack` restores it while
 * verifying the aggregate SHA-256.
 *
 * Every case is hermetic: it builds a throwaway app fixture in a temp dir,
 * packs and unpacks with system `tar` (real on the host), and cleans up.
 * No daemon, no network.
 */

import { describe, it, expect, afterEach, vi } from "vitest"
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  readdir,
} from "node:fs/promises"
import { existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"

import {
  runAppPack,
  runAppUnpack,
  runApp,
} from "../commands/app.js"

const tmpRoots: string[] = []

afterEach(async () => {
  for (const p of tmpRoots) await rm(p, { recursive: true, force: true })
  tmpRoots.length = 0
  vi.restoreAllMocks()
})

/** Allocate a temp dir tracked for cleanup. */
async function mktmp(prefix = "agentapp-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tmpRoots.push(dir)
  return dir
}

// ── fixture ──────────────────────────────────────────────────────────────

/**
 * Build a realistic agentproto app fixture and return its dir.
 * Layout:\n *   .agentproto/APP.md
 *   .agentproto/agents/scout/AGENT.md
 *   .agentproto/workflows/hunt/WORKFLOW.md
 *   .agentproto/ui/index.html
 *   base-cv.json
 *   ranked-jobs.json
 *   dossiers/note.md
 */
async function buildFixture(root: string): Promise<string> {
  const appDir = join(root, "job-hunter-app")
  await mkdir(join(appDir, ".agentproto", "agents", "scout"), { recursive: true })
  await mkdir(join(appDir, ".agentproto", "workflows", "hunt"), {
    recursive: true,
  })
  await mkdir(join(appDir, ".agentproto", "ui"), { recursive: true })
  await mkdir(join(appDir, "dossiers"), { recursive: true })

  await writeFile(
    join(appDir, ".agentproto", "APP.md"),
    `---\n` +
      `schema: agent-app/v1\n` +
      `id: job-hunter-app\n` +
      `name: Job Hunter App\n` +
      `version: 0.4.2\n` +
      `description: A demo job-hunting agent app\n` +
      `agents:\n` +
      `  - id: scout\n` +
      `    path: .agentproto/agents/scout/AGENT.md\n` +
      `  - id: tailor\n` +
      `    path: .agentproto/agents/tailor/AGENT.md\n` +
      `workflows:\n` +
      `  - id: hunt\n` +
      `    path: .agentproto/workflows/hunt/WORKFLOW.md\n` +
      `ui:\n` +
      `  path: .agentproto/ui/index.html\n` +
      `---\n` +
      `# Job Hunter App\n` +
      `A demo app bundled for .agentapp round-tripping.\n`,
    "utf8",
  )
  await writeFile(
    join(appDir, ".agentproto", "agents", "scout", "AGENT.md"),
    "# Scout\nAgent that scouts jobs.\n",
    "utf8",
  )
  await writeFile(
    join(appDir, ".agentproto", "workflows", "hunt", "WORKFLOW.md"),
    "# Hunt workflow\nSteps to hunt jobs.\n",
    "utf8",
  )
  await writeFile(
    join(appDir, ".agentproto", "ui", "index.html"),
    "<!doctype html><html><body>hi</body></html>\n",
    "utf8",
  )
  await writeFile(join(appDir, "base-cv.json"), '{"name":"Ada","skills":[]}\n', "utf8")
  await writeFile(
    join(appDir, "ranked-jobs.json"),
    '[{"title":"PM"},{"title":"Dev"}]\n',
    "utf8",
  )
  await writeFile(join(appDir, "dossiers", "note.md"), "# Dossier\nNote content.\n", "utf8")
  return appDir
}

/** Tar a directory's top-level entries into a bundle (used to build a corrupt one). */
async function tarDirTo(root: string, dest: string): Promise<void> {
  const names = (await readdir(root)).sort()
  const res = spawnSync(
    "tar",
    ["-czf", dest, "-C", root, ...names],
    { encoding: "utf8" },
  )
  if (res.status !== 0) {
    throw new Error(`tar failed: ${res.stderr}`)
  }
}


// ── pack ─────────────────────────────────────────────────────────────────

describe("app pack", () => {
  it("produces a <id>-<version>.agentapp tar.gz with a valid manifest", async () => {
    const root = await mktmp()
    const appDir = await buildFixture(root)
    const outs = join(root, "outs")
    const out = join(outs, "job-hunter-app-0.4.2.agentapp")

    const code = await runAppPack([appDir, "--out", out, "--json"])
    expect(code).toBe(0)
    expect(existsSync(out)).toBe(true)

    // Extract with system tar and inspect manifest
    const extractTo = await mktmp("agentapp-extract-")
    const res = spawnSync("tar", ["-xzf", out, "-C", extractTo], {
      encoding: "utf8",
    })
    expect(res.status).toBe(0)
    expect(existsSync(join(extractTo, "manifest.json"))).toBe(true)
    expect(existsSync(join(extractTo, ".agentproto", "APP.md"))).toBe(true)
    expect(existsSync(join(extractTo, "dossiers", "note.md"))).toBe(true)

    const manifest = JSON.parse(
      await readFile(join(extractTo, "manifest.json"), "utf8"),
    )
    expect(manifest.format).toBe("agentapp/v1")
    expect(manifest.id).toBe("job-hunter-app")
    expect(manifest.name).toBe("Job Hunter App")
    expect(manifest.version).toBe("0.4.2")
    expect(manifest.agents).toEqual(["scout", "tailor"])
    expect(manifest.workflows).toEqual(["hunt"])
    expect(manifest.ui).toEqual(["index.html"])
    expect(manifest.fileCount).toBeGreaterThan(0)
    expect(manifest.totalSize).toBeGreaterThan(0)
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/)
    // files are relative + sorted
    expect(manifest.files).toEqual([...manifest.files].sort())
    expect(manifest.files).toContain(".agentproto/APP.md")
    expect(manifest.files).toContain("base-cv.json")
    expect(manifest.files).toContain("dossiers/note.md")
  })

  it("--json emits a parseable manifest on stdout", async () => {
    const root = await mktmp()
    const appDir = await buildFixture(root)
    const out = join(root, "bundle.agentapp")

    const writes: string[] = []
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        writes.push(String(chunk))
        return true
      })
    const code = await runAppPack([appDir, "--out", out, "--json"])
    spy.mockRestore()

    expect(code).toBe(0)
    const stdout = writes.join("")
    const parsed = JSON.parse(stdout)
    expect(parsed.format).toBe("agentapp/v1")
    expect(parsed.id).toBe("job-hunter-app")
    expect(parsed.files).toContain("ranked-jobs.json")
  })

  it("defaults the output filename to <safeId>-<version>.agentapp in cwd", async () => {
    const root = await mktmp()
    const appDir = await buildFixture(root)
    // run from a scratch cwd so the derived file lands somewhere assertable
    const cwd = await mktmp("agentapp-cwd-")
    const originalCwd = process.cwd()
    process.chdir(cwd)
    try {
      const code = await runAppPack([appDir])
      expect(code).toBe(0)
    } finally {
      process.chdir(originalCwd)
    }
    expect(existsSync(join(cwd, "job-hunter-app-0.4.2.agentapp"))).toBe(true)
  })

  it("returns 2 when the app dir has no .agentproto/APP.md", async () => {
    const root = await mktmp()
    const notAnApp = join(root, "plain")
    await mkdir(notAnApp, { recursive: true })
    const writes: string[] = []
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        writes.push(String(chunk))
        return true
      })
    const code = await runAppPack([notAnApp])
    spy.mockRestore()
    expect(code).toBe(2)
    expect(writes.join("")).toContain("not an agentproto app")
  })
})

// ── unpack ───────────────────────────────────────────────────────────────

describe("app unpack", () => {
  it("restores the app folder without manifest.json", async () => {
    const root = await mktmp()
    const appDir = await buildFixture(root)
    const out = join(root, "job-hunter-app-0.4.2.agentapp")
    expect(await runAppPack([appDir, "--out", out])).toBe(0)

    const dest = join(root, "restored")
    const code = await runAppUnpack([out, "--dir", dest])
    expect(code).toBe(0)

    expect(existsSync(join(dest, ".agentproto", "APP.md"))).toBe(true)
    expect(existsSync(join(dest, ".agentproto", "agents", "scout", "AGENT.md"))).toBe(true)
    expect(existsSync(join(dest, "base-cv.json"))).toBe(true)
    expect(existsSync(join(dest, "dossiers", "note.md"))).toBe(true)
    expect(existsSync(join(dest, "manifest.json"))).toBe(false)
  })

  it("recomputed sha over restored files matches manifest.sha256", async () => {
    const root = await mktmp()
    const appDir = await buildFixture(root)
    const out = join(root, "bundle.agentapp")
    await runAppPack([appDir, "--out", out])

    // read manifest directly from the bundle
    const readout = await mktmp("agentapp-rd-")
    spawnSync("tar", ["-xzf", out, "-C", readout], { encoding: "utf8" })
    const manifest = JSON.parse(
      await readFile(join(readout, "manifest.json"), "utf8"),
    )

    const dest = join(root, "restored")
    await runAppUnpack([out, "--dir", dest])

    // aggregate over restored files, in manifest.files order
    const hash = createHash("sha256")
    for (const f of manifest.files) {
      hash.update(await readFile(join(dest, f)))
    }
    expect(hash.digest("hex")).toBe(manifest.sha256)
  })

  it("returns 1 with a SHA-mismatch on a tampered bundle", async () => {
    const root = await mktmp()
    const appDir = await buildFixture(root)
    const good = join(root, "good.agentapp")
    await runAppPack([appDir, "--out", good])

    // Expand, tamper one file, keep the original manifest, re-tar.
    const corrupted = await mktmp("agentapp-corrupt-")
    spawnSync("tar", ["-xzf", good, "-C", corrupted], { encoding: "utf8" })
    await writeFile(
      join(corrupted, "dossiers", "note.md"),
      "# Dossier\nTAMPERED content\n",
      "utf8",
    )
    const badBundle = join(root, "bad.agentapp")
    await tarDirTo(corrupted, badBundle)

    const stderr: string[] = []
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderr.push(String(chunk))
        return true
      })
    const dest = join(root, "should-not-restore")
    const code = await runAppUnpack([badBundle, "--dir", dest])
    spy.mockRestore()

    expect(code).toBe(1)
    expect(stderr.join("")).toContain("SHA-256 mismatch")
    expect(existsSync(dest)).toBe(false)
  })

  it("returns 1 when the bundle has no manifest.json", async () => {
    const root = await mktmp()
    const notABundle = join(root, "empty")
    await mkdir(notABundle, { recursive: true })
    // bundle without manifest.json: a real file so tar has something to pack
    await writeFile(join(notABundle, "README.md"), "not a bundle\n", "utf8")
    const empty = join(root, "empty.agentapp")
    await tarDirTo(notABundle, empty)

    const code = await runAppUnpack([empty, "--dir", join(root, "out")])
    expect(code).toBe(1)
  })
})

// ── dispatcher ───────────────────────────────────────────────────────────

describe("app dispatcher", () => {
  it("routes pack and unpack sub-verbs", async () => {
    const root = await mktmp()
    const appDir = await buildFixture(root)
    const out = join(root, "d.agentapp")
    expect(await runApp(["pack", "--out", out, appDir])).toBe(0)
    expect(existsSync(out)).toBe(true)

    const show = await mktmp("agentapp-show-")
    const res = spawnSync("tar", ["-xzf", out, "-C", show], { encoding: "utf8" })
    expect(res.status).toBe(0)
    expect(existsSync(join(show, "manifest.json"))).toBe(true)
  })

  it("returns 2 for an unknown sub-verb", async () => {
    const stderr: string[] = []
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderr.push(String(chunk))
        return true
      })
    const code = await runApp(["frobnicate"])
    spy.mockRestore()
    expect(code).toBe(2)
    expect(stderr.join("")).toContain("unknown sub-command")
  })
})
