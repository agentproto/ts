import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  adoptTarCheckpoint,
  buildTarPackCommand,
  parseTarPack,
  readTarTarget,
  restoreTarCheckpoint,
  runTarCheckpoint,
  savedTarArchive,
  setupTarWorkspace,
  tarArchivePath,
  tarCheckpointProxyOpts,
  tarRecordPath,
  writePendingTarRecord,
  type TarCheckpointRecord,
} from "../sandbox-tar-checkpoint.js"
import { resolveSandboxCheckpointConfig } from "../sandbox-delivery.js"
import type { SandboxExec } from "../sandbox-workspace-remote.js"

// The "box" is a directory on this machine: `exec` runs the shell command
// locally, and the box's /tmp paths are this machine's /tmp.
const localExec: SandboxExec = opts =>
  new Promise(resolve => {
    const started = Date.now()
    execFile("bash", ["-c", opts.command], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0
      resolve({ exitCode: code, stdout: String(stdout), stderr: String(stderr), durationMs: Date.now() - started })
    })
  })

const boxReadFile = (path: string) => readFile(path)
const boxWriteFile = (path: string, data: Uint8Array) => writeFile(path, data)

describe("tar workspace checkpoint", () => {
  let root: string
  let boxDir: string
  let sessionDir: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agp-tar-ckpt-"))
    boxDir = join(root, "box", "work")
    sessionDir = join(root, "session")
    await mkdir(boxDir, { recursive: true })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  async function seedBox(): Promise<void> {
    await mkdir(join(boxDir, "src"), { recursive: true })
    await mkdir(join(boxDir, "node_modules", "dep"), { recursive: true })
    await mkdir(join(boxDir, ".git"), { recursive: true })
    await mkdir(join(boxDir, "build-out"), { recursive: true })
    await writeFile(join(boxDir, "src", "index.ts"), "export const answer = 42\n")
    await writeFile(join(boxDir, "README.md"), "hello\n")
    await writeFile(join(boxDir, "node_modules", "dep", "index.js"), "module.exports = 1\n")
    await writeFile(join(boxDir, ".git", "HEAD"), "ref: refs/heads/main\n")
    await writeFile(join(boxDir, "build-out", "bundle.js"), "generated\n")
    await writeFile(join(boxDir, ".gitignore"), "# comment\nbuild-out/\n!keep\n*\n")
  }

  it("parses the pack command's output", () => {
    expect(parseTarPack(`bytes=123\nsha=${"a".repeat(64)}\n`)).toEqual({ bytes: 123, sha: "a".repeat(64) })
    expect(parseTarPack("nope")).toBeUndefined()
  })

  it("quotes the working dir in the pack command", () => {
    expect(buildTarPackCommand("/home/user/my work")).toContain("cd '/home/user/my work' ||")
  })

  it("packs the box dir to the host honouring excludes and .gitignore, then restores it on a fresh box", async () => {
    await seedBox()
    const record = await runTarCheckpoint({
      exec: localExec,
      readFile: boxReadFile,
      target: { dir: boxDir },
      outDir: sessionDir,
      mode: "teardown",
    })
    expect(record).toMatchObject({ status: "saved", dir: boxDir, mode: "teardown" })
    expect(record.bytes).toBeGreaterThan(0)
    expect(existsSync(tarArchivePath(sessionDir))).toBe(true)
    expect(JSON.parse(await readFile(tarRecordPath(sessionDir), "utf8"))).toMatchObject({ status: "saved" })

    // Restore into a different (fresh) dir.
    const freshDir = join(root, "fresh-box", "work")
    const restored = await restoreTarCheckpoint({
      exec: localExec,
      writeFile: boxWriteFile,
      target: { dir: freshDir },
      archivePath: tarArchivePath(sessionDir),
    })
    expect(restored.ok).toBe(true)
    expect(await readFile(join(freshDir, "src", "index.ts"), "utf8")).toBe("export const answer = 42\n")
    expect(await readFile(join(freshDir, "README.md"), "utf8")).toBe("hello\n")
    expect(await readFile(join(freshDir, ".gitignore"), "utf8")).toContain("build-out/")
    expect(existsSync(join(freshDir, "node_modules"))).toBe(false)
    expect(existsSync(join(freshDir, ".git"))).toBe(false)
    expect(existsSync(join(freshDir, "build-out"))).toBe(false)
  })

  it("skips (and leaves the archive in the box) when over the size cap", async () => {
    await seedBox()
    const record = await runTarCheckpoint({
      exec: localExec,
      readFile: boxReadFile,
      target: { dir: boxDir },
      outDir: sessionDir,
      maxBytes: 10,
    })
    expect(record.status).toBe("skipped")
    expect(record.detail).toMatch(/over the 10 byte limit/)
    expect(savedTarArchive(sessionDir)).toBeUndefined()
  })

  it("skips an unchanged tree on the next periodic run", async () => {
    await seedBox()
    const first = await runTarCheckpoint({ exec: localExec, readFile: boxReadFile, target: { dir: boxDir }, outDir: sessionDir })
    expect(first.status).toBe("saved")
    const again = await runTarCheckpoint({
      exec: localExec,
      readFile: boxReadFile,
      target: { dir: boxDir },
      outDir: sessionDir,
      previousKey: first.key,
    })
    expect(again).toMatchObject({ status: "skipped", unchanged: true })
    expect(savedTarArchive(sessionDir)).toBeDefined()
  })

  it("reports a failure (never throws) when the working dir is missing, the provider cannot download, or exec throws", async () => {
    const missing = await runTarCheckpoint({
      exec: localExec,
      readFile: boxReadFile,
      target: { dir: join(root, "nope") },
      outDir: sessionDir,
    })
    expect(missing.status).toBe("failed")
    expect(missing.detail).toMatch(/does not exist/)

    const noDownload = await runTarCheckpoint({ exec: localExec, target: { dir: boxDir }, outDir: sessionDir })
    expect(noDownload).toMatchObject({ status: "failed" })
    expect(noDownload.detail).toMatch(/cannot download files/)

    const boom = await runTarCheckpoint({
      exec: async () => {
        throw new Error("box unreachable")
      },
      readFile: boxReadFile,
      target: { dir: boxDir },
      outDir: sessionDir,
    })
    expect(boom.status).toBe("failed")
    expect(boom.detail).toMatch(/box unreachable/)
  })

  it("restore refuses an archive over the cap and a provider that cannot upload", async () => {
    await seedBox()
    await runTarCheckpoint({ exec: localExec, readFile: boxReadFile, target: { dir: boxDir }, outDir: sessionDir })
    const archivePath = tarArchivePath(sessionDir)
    expect((await stat(archivePath)).size).toBeGreaterThan(10)
    const tooBig = await restoreTarCheckpoint({
      exec: localExec,
      writeFile: boxWriteFile,
      target: { dir: join(root, "x") },
      archivePath,
      maxBytes: 10,
    })
    expect(tooBig).toMatchObject({ ok: false })
    const noUpload = await restoreTarCheckpoint({ exec: localExec, target: { dir: join(root, "x") }, archivePath })
    expect(noUpload).toMatchObject({ ok: false, message: expect.stringMatching(/cannot upload/) })
  })

  describe("tar-mode marker", () => {
    it("is written pending at setup and read back; adoption carries the archive forward", async () => {
      await seedBox()
      expect(await readTarTarget(sessionDir)).toBeUndefined()
      await writePendingTarRecord(sessionDir, { dir: boxDir })
      expect(await readTarTarget(sessionDir)).toEqual({ dir: boxDir })
      await runTarCheckpoint({ exec: localExec, readFile: boxReadFile, target: { dir: boxDir }, outDir: sessionDir })

      const nextDir = join(root, "next-session")
      expect(await adoptTarCheckpoint(sessionDir, nextDir)).toEqual({ dir: boxDir })
      expect(await readTarTarget(nextDir)).toEqual({ dir: boxDir })
      expect(savedTarArchive(nextDir)).toBeDefined()

      expect(await adoptTarCheckpoint(join(root, "never-tar"), join(root, "other"))).toBeUndefined()
    })
  })

  describe("setupTarWorkspace", () => {
    it("fresh spawn: creates <home>/<slug>, marks the session, explains tar mode", async () => {
      const home = join(root, "home")
      const setup = await setupTarWorkspace({
        exec: localExec,
        readFile: boxReadFile,
        writeFile: boxWriteFile,
        homeDir: home,
        slug: "scratch",
        sessionDir,
      })
      expect(setup.ok).toBe(true)
      if (!setup.ok) return
      expect(setup.target).toEqual({ dir: join(home, "scratch") })
      expect(existsSync(join(home, "scratch"))).toBe(true)
      expect(setup.notices.join("\n")).toMatch(/no git remote/)
      expect(await readTarTarget(sessionDir)).toEqual({ dir: join(home, "scratch") })
    })

    it("restart on a fresh box: extracts the saved archive and keeps a copy in the new session dir", async () => {
      await seedBox()
      const prevDir = join(root, "prev-session")
      await runTarCheckpoint({ exec: localExec, readFile: boxReadFile, target: { dir: boxDir }, outDir: prevDir })
      const home = join(root, "fresh-home")
      const setup = await setupTarWorkspace({
        exec: localExec,
        readFile: boxReadFile,
        writeFile: boxWriteFile,
        homeDir: home,
        slug: "scratch",
        sessionDir,
        restoreFrom: tarArchivePath(prevDir),
      })
      expect(setup.ok).toBe(true)
      expect(await readFile(join(home, "scratch", "src", "index.ts"), "utf8")).toContain("answer")
      expect(savedTarArchive(sessionDir)).toBeDefined()
      if (setup.ok) expect(setup.notices.join("\n")).toMatch(/restored the last workspace checkpoint/)
    })

    it("fails loud on restore when the provider cannot upload; only warns on a fresh spawn", async () => {
      const home = join(root, "h")
      const restore = await setupTarWorkspace({
        exec: localExec,
        readFile: boxReadFile,
        homeDir: home,
        slug: "scratch",
        sessionDir,
        restoreFrom: join(root, "whatever.tar.gz"),
      })
      expect(restore).toMatchObject({ ok: false })

      const fresh = await setupTarWorkspace({ homeDir: home, slug: "scratch", sessionDir })
      expect(fresh.ok).toBe(true)
      if (fresh.ok) {
        expect(fresh.target).toBeUndefined()
        expect(fresh.notices.join("\n")).toMatch(/cannot run commands in the box/)
        expect(fresh.notices.join("\n")).toMatch(/workspace remote set scratch/)
      }
    })

    it("rejects a slug that is not a safe directory name", async () => {
      const bad = await setupTarWorkspace({
        exec: localExec,
        readFile: boxReadFile,
        homeDir: join(root, "h"),
        slug: "../escape",
        sessionDir,
      })
      expect(bad.ok && bad.target).toBeFalsy()
    })
  })

  describe("tarCheckpointProxyOpts", () => {
    const exec = vi.fn<SandboxExec>()

    it("wires nothing without a target or exec", () => {
      const config = resolveSandboxCheckpointConfig(undefined, undefined)
      expect(tarCheckpointProxyOpts({ exec: undefined, target: { dir: boxDir }, outDir: sessionDir, config })).toEqual({})
      expect(tarCheckpointProxyOpts({ exec, target: undefined, outDir: sessionDir, config })).toEqual({})
    })

    it("follows the resolved checkpoint config: turn-end → periodic, teardown → hook", () => {
      const both = tarCheckpointProxyOpts({
        exec,
        target: { dir: boxDir },
        outDir: sessionDir,
        config: resolveSandboxCheckpointConfig(undefined, undefined),
      })
      expect(both.onBeforeTeardown).toBeTypeOf("function")
      expect(both.checkpoint?.run).toBeTypeOf("function")

      const off = tarCheckpointProxyOpts({
        exec,
        target: { dir: boxDir },
        outDir: sessionDir,
        config: resolveSandboxCheckpointConfig(undefined, false),
      })
      expect(off).toEqual({})

      const teardownOnly = tarCheckpointProxyOpts({
        exec,
        target: { dir: boxDir },
        outDir: sessionDir,
        config: resolveSandboxCheckpointConfig(undefined, { on: ["teardown"] }),
      })
      expect(teardownOnly.onBeforeTeardown).toBeTypeOf("function")
      expect(teardownOnly.checkpoint).toBeUndefined()
    })

    it("the periodic hook saves, notifies once, and stays quiet while the tree is unchanged", async () => {
      await seedBox()
      const notices: string[] = []
      const opts = tarCheckpointProxyOpts({
        exec: localExec,
        readFile: boxReadFile,
        target: { dir: boxDir },
        outDir: sessionDir,
        config: resolveSandboxCheckpointConfig(undefined, undefined),
        notify: text => notices.push(text),
      })
      const first: TarCheckpointRecord = await opts.checkpoint!.run(1)
      expect(first.status).toBe("saved")
      const second = await opts.checkpoint!.run(2)
      expect(second.unchanged).toBe(true)
      expect(notices).toHaveLength(1)
      expect(notices[0]).toMatch(/saved/)

      await writeFile(join(boxDir, "README.md"), "changed\n")
      const third = await opts.checkpoint!.run(3)
      expect(third.status).toBe("saved")
    })

    it("the teardown hook saves a final archive", async () => {
      await seedBox()
      const opts = tarCheckpointProxyOpts({
        exec: localExec,
        readFile: boxReadFile,
        target: { dir: boxDir },
        outDir: sessionDir,
        config: resolveSandboxCheckpointConfig(undefined, undefined),
      })
      await opts.onBeforeTeardown!()
      expect(savedTarArchive(sessionDir)).toBeDefined()
    })
  })
})
