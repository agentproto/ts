/**
 * The adapter's conversation store riding along on a box checkpoint: the
 * in-box pack command, the host-side save with its 20 MiB cap, the
 * never-fail-the-checkpoint rule, and the fresh-box upload/extract. Fake
 * `exec`/`readFile`/`writeFile` and a temp host dir — no box, no tar, no
 * network.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { execFile, execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { SandboxExecOpts, SandboxExecResult } from "@agentproto/sandbox"

import {
  ADAPTER_STORE_FILE,
  ADAPTER_STORE_TIMEOUT_MS,
  BOX_ADAPTER_STORE_ARCHIVE_PATH,
  BOX_ADAPTER_STORE_RESTORE_PATH,
  BOX_ADAPTER_STORE_TAR_PATH,
  DEFAULT_ADAPTER_STORE_MAX_BYTES,
  adapterStoreArchivePath,
  adapterStoreRelativeDir,
  archiveAdapterStore,
  buildAdapterStoreArchiveCommand,
  parseAdapterStoreArchive,
  restoreAdapterStore,
  savedAdapterStoreArchive,
} from "../sandbox-adapter-store.js"
import { CHECKPOINT_RECORD_FILE, runSandboxDelivery } from "../sandbox-delivery.js"

const target = {
  checkoutDir: "/home/user/agentproto",
  branch: "wt/store",
  baseSha: "b".repeat(40),
}

function ok(stdout = "", stderr = ""): SandboxExecResult {
  return { exitCode: 0, stdout, stderr, durationMs: 1 }
}

/** Real `tar`/`gzip`/`bash` — the pack/extract commands are shell, so the
 *  round trip below runs them for real; skipped where the tools are absent. */
const hasRealTar = (() => {
  try {
    execFileSync("tar", ["--version"], { stdio: "ignore" })
    execFileSync("gzip", ["--version"], { stdio: "ignore" })
    execFileSync("bash", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

async function sh(
  command: string,
  home: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await promisify(execFile)("bash", ["-c", command], {
      env: { ...process.env, HOME: home },
    })
    return { stdout, stderr, exitCode: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number }
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: typeof e.code === "number" ? e.code : 1,
    }
  }
}

describe("the in-box pack command", () => {
  it("tars ONLY this session's isolated config dir, home-relative, and prints its byte size", () => {
    const command = buildAdapterStoreArchiveCommand("sbx_dead_1")
    // Home-relative prefix: the restore re-extracts under $HOME on any box.
    expect(command).toContain(adapterStoreRelativeDir("sbx_dead_1"))
    expect(command).toContain('.agentproto/adapter-config/sbx_dead_1')
    expect(command).toContain('-C "$HOME"')
    // Deterministic-ish, like the workspace tar; tolerates the adapter
    // writing while the tar reads (rc 1) but never a hard tar failure.
    expect(command).toContain('--sort=name')
    expect(command).toContain("echo \"store=missing\"")
    expect(command).toContain("bytes=$(wc -c <")
    expect(command).toContain(BOX_ADAPTER_STORE_ARCHIVE_PATH)
    // No PIPE: `tar | gzip` reports gzip's status, never tar's, so a
    // truncated archive could ship as long as gzip was happy. tar writes a
    // file whose own exit code and size are checked before gzip runs.
    expect(command).not.toMatch(/\|\s*gzip/)
    expect(command).toContain(`-cf '${BOX_ADAPTER_STORE_TAR_PATH}'`)
    expect(command).toContain("rc=$?")
    expect(command).toContain("gzip -n -c")
    // A different (quoted) output path is honoured, raw tar alongside it.
    expect(buildAdapterStoreArchiveCommand("sbx_1", "/tmp/other.tar.gz")).toContain("/tmp/other.tar.gz")
    expect(buildAdapterStoreArchiveCommand("sbx_1", "/tmp/other.tar.gz")).toContain("-cf '/tmp/other.tar'")
  })

  it("parses the byte count and rejects output with no archive (store=missing)", () => {
    expect(parseAdapterStoreArchive("bytes=12345\n")).toEqual({ bytes: 12345 })
    expect(parseAdapterStoreArchive("anything\nbytes=7\n")).toEqual({ bytes: 7 })
    expect(parseAdapterStoreArchive("store=missing\n")).toBeUndefined()
    expect(parseAdapterStoreArchive("")).toBeUndefined()
  })

  it("names the host archive next to the checkpoint record and finds it only when it exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentproto-store-path-"))
    try {
      const path = adapterStoreArchivePath(dir)
      expect(path.endsWith(ADAPTER_STORE_FILE)).toBe(true)
      expect(savedAdapterStoreArchive(dir)).toBeUndefined()
      await writeFile(path, "bytes")
      expect(savedAdapterStoreArchive(dir)).toBe(path)
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    }
  })
})

describe("archiveAdapterStore", () => {
  let outDir: string
  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "agentproto-store-archive-"))
  })
  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  it("packs in the box and saves the archive next to the checkpoint record", async () => {
    const commands: SandboxExecOpts[] = []
    const payload = new Uint8Array(64).fill(7)
    const record = await archiveAdapterStore({
      exec: async o => {
        commands.push(o)
        return ok(`bytes=${payload.byteLength}\n`)
      },
      readFile: async path => {
        expect(path).toBe(BOX_ADAPTER_STORE_ARCHIVE_PATH)
        return payload
      },
      adapterSessionId: "sbx_dead_1",
      adapter: "claude-code",
      outDir,
    })

    expect(record).toEqual({
      status: "saved",
      path: join(outDir, ADAPTER_STORE_FILE),
      adapter: "claude-code",
      adapterSessionId: "sbx_dead_1",
      bytes: payload.byteLength,
    })
    expect(await readFile(join(outDir, ADAPTER_STORE_FILE))).toEqual(Buffer.from(payload))
    expect(commands).toHaveLength(1)
    expect(commands[0]?.command).toContain("adapter-config/sbx_dead_1")
    expect(commands[0]?.timeoutMs).toBeLessThanOrEqual(ADAPTER_STORE_TIMEOUT_MS)
  })

  it("skips an over-cap store: reported, left in the box, never downloaded", async () => {
    const downloads: string[] = []
    const record = await archiveAdapterStore({
      exec: async () => ok("bytes=1001\n"),
      readFile: async path => {
        downloads.push(path)
        return new Uint8Array(1001)
      },
      adapterSessionId: "sbx_dead_1",
      outDir,
      maxBytes: 1_000,
    })

    expect(record.status).toBe("skipped")
    expect(record.bytes).toBe(1001)
    expect(record.detail).toContain("over the 1000 byte limit")
    expect(downloads).toEqual([])
    expect(savedAdapterStoreArchive(outDir)).toBeUndefined()
  })

  it("skips when the provider cannot download files from the box", async () => {
    const record = await archiveAdapterStore({
      exec: async () => ok("bytes=8\n"),
      adapterSessionId: "sbx_dead_1",
      outDir,
    })
    expect(record.status).toBe("skipped")
    expect(record.detail).toContain("cannot download")
    expect(savedAdapterStoreArchive(outDir)).toBeUndefined()
  })

  it("records a pack failure instead of throwing", async () => {
    const failed = await archiveAdapterStore({
      exec: async () => ({ exitCode: 2, stdout: "", stderr: "tar failed (exit 2)", durationMs: 1 }),
      readFile: async () => new Uint8Array(4),
      adapterSessionId: "sbx_dead_1",
      outDir,
    })
    expect(failed.status).toBe("failed")
    expect(failed.detail).toContain("packing the adapter store failed")

    // A store that was never written exits 0 with `store=missing` — an
    // unparseable (no bytes=) success, also recorded, never thrown.
    const missing = await archiveAdapterStore({
      exec: async () => ok("store=missing\n"),
      readFile: async () => new Uint8Array(4),
      adapterSessionId: "sbx_dead_1",
      outDir,
    })
    expect(missing.status).toBe("failed")
    expect(missing.detail).toContain("unparseable output")

    const threw = await archiveAdapterStore({
      exec: async () => {
        throw new Error("box exploded")
      },
      adapterSessionId: "sbx_dead_1",
      outDir,
    })
    expect(threw.status).toBe("failed")
    expect(threw.detail).toContain("box exploded")
    expect(savedAdapterStoreArchive(outDir)).toBeUndefined()
  })
})

describe("restoreAdapterStore", () => {
  let dir: string
  let archivePath: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agentproto-store-restore-"))
    archivePath = adapterStoreArchivePath(dir)
    await writeFile(archivePath, "fake-store-archive")
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  it("uploads the archive into the box and extracts it home-relative", async () => {
    const uploads: Array<{ path: string; bytes: number }> = []
    const commands: string[] = []
    const result = await restoreAdapterStore({
      writeFile: async (path, data) => {
        uploads.push({ path, bytes: data.byteLength })
      },
      exec: async o => {
        commands.push(o.command)
        return ok("restored\n")
      },
      archivePath,
    })

    expect(result).toEqual({ ok: true, bytes: Buffer.byteLength("fake-store-archive") })
    expect(uploads).toEqual([
      { path: BOX_ADAPTER_STORE_RESTORE_PATH, bytes: Buffer.byteLength("fake-store-archive") },
    ])
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain("tar --no-same-owner -xzf")
    expect(commands[0]).toContain(`-C "$HOME"`)
    expect(commands[0]).toContain("restored")
    // The members are listed and vetted BEFORE anything is extracted: a path
    // outside the session's store dir (absolute, or a `..` segment) is refused.
    expect(commands[0]).toContain("tar -tzf")
    expect(commands[0]).toContain("unsafe member path")
    expect(commands[0]).toContain(".agentproto/adapter-config/")
  })

  it("never throws: every failure resolves to a message the caller notices", async () => {
    const noUpload = await restoreAdapterStore({ exec: async () => ok("restored\n"), archivePath })
    expect(noUpload).toEqual({ ok: false, message: "the sandbox provider cannot upload files into the box" })

    const noExec = await restoreAdapterStore({ writeFile: async () => undefined, archivePath })
    expect(noExec).toEqual({ ok: false, message: "the sandbox provider cannot run commands in the box" })

    const unreadable = await restoreAdapterStore({
      writeFile: async () => undefined,
      exec: async () => ok("restored\n"),
      archivePath: join(dir, "nope.tar.gz"),
    })
    expect(unreadable.ok).toBe(false)
    if (!unreadable.ok) expect(unreadable.message).toContain("reading the saved adapter store failed")

    const overCap = await restoreAdapterStore({
      writeFile: async () => undefined,
      exec: async () => ok("restored\n"),
      archivePath,
      maxBytes: 4,
    })
    expect(overCap.ok).toBe(false)
    if (!overCap.ok) expect(overCap.message).toContain("over the 4 byte limit")

    const uploadThrows = await restoreAdapterStore({
      writeFile: async () => {
        throw new Error("upload refused")
      },
      exec: async () => ok("restored\n"),
      archivePath,
    })
    expect(uploadThrows.ok).toBe(false)
    if (!uploadThrows.ok) expect(uploadThrows.message).toContain("upload refused")

    const extractFails = await restoreAdapterStore({
      writeFile: async () => undefined,
      exec: async () => ({ exitCode: 2, stdout: "", stderr: "tar: boom", durationMs: 1 }),
      archivePath,
    })
    expect(extractFails.ok).toBe(false)
    if (!extractFails.ok) expect(extractFails.message).toContain("extracting the adapter store failed")

    const noRestoredMarker = await restoreAdapterStore({
      writeFile: async () => undefined,
      exec: async () => ok("something else\n"),
      archivePath,
    })
    expect(noRestoredMarker.ok).toBe(false)
  })
})

describe("runSandboxDelivery carries the store on the checkpoint", () => {
  let outDir: string
  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "agentproto-store-delivery-"))
  })
  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  function box(opts: { storeBytes?: number; packExit?: number } = {}) {
    const commands: SandboxExecOpts[] = []
    const downloads: string[] = []
    const exec = async (o: SandboxExecOpts): Promise<SandboxExecResult> => {
      commands.push(o)
      if (o.command.includes(BOX_ADAPTER_STORE_ARCHIVE_PATH)) {
        return opts.packExit
          ? { exitCode: opts.packExit, stdout: "", stderr: "tar failed", durationMs: 1 }
          : ok(`bytes=${opts.storeBytes ?? 64}\n`)
      }
      if (o.command.includes("rev-list")) return ok("ahead=1\nuncommitted=0\n")
      if (o.command.includes(" push ")) return ok()
      return ok()
    }
    const readFile = async (path: string): Promise<Uint8Array> => {
      downloads.push(path)
      return new Uint8Array(opts.storeBytes ?? 64).fill(3)
    }
    return { exec, readFile, commands, downloads }
  }

  it("archives the store on a checkpoint and records it next to checkpoint.json", async () => {
    const b = box()
    const record = await runSandboxDelivery({
      exec: b.exec,
      readFile: b.readFile,
      target,
      outDir,
      mode: "checkpoint",
      adapterStore: { adapterSessionId: "sbx_dead_1", adapter: "opencode" },
    })

    expect(record.adapterStore).toEqual({
      status: "saved",
      path: join(outDir, ADAPTER_STORE_FILE),
      adapter: "opencode",
      adapterSessionId: "sbx_dead_1",
      bytes: 64,
    })
    expect((await stat(join(outDir, ADAPTER_STORE_FILE))).size).toBe(64)
    // The checkpoint itself is unaffected by the passenger.
    expect(record.push.status).toBe("pushed")
    const persisted = JSON.parse(await readFile(join(outDir, CHECKPOINT_RECORD_FILE), "utf8"))
    expect(persisted.adapterStore).toMatchObject({ status: "saved", adapterSessionId: "sbx_dead_1" })
    // Packed BEFORE the git probe.
    expect(b.commands[0]?.command).toContain(BOX_ADAPTER_STORE_ARCHIVE_PATH)
    expect(b.commands.some(c => c.command.includes("rev-list"))).toBe(true)
  })

  it("reports an over-cap store as skipped while the checkpoint still lands", async () => {
    const b = box({ storeBytes: DEFAULT_ADAPTER_STORE_MAX_BYTES + 1 })
    const record = await runSandboxDelivery({
      exec: b.exec,
      readFile: b.readFile,
      target,
      outDir,
      mode: "checkpoint",
      adapterStore: { adapterSessionId: "sbx_dead_1" },
    })

    expect(record.adapterStore?.status).toBe("skipped")
    expect(record.adapterStore?.bytes).toBe(DEFAULT_ADAPTER_STORE_MAX_BYTES + 1)
    expect(b.downloads).toEqual([])
    expect(savedAdapterStoreArchive(outDir)).toBeUndefined()
    expect(record.push.status).toBe("pushed")
  })

  it("an archive failure never fails the checkpoint", async () => {
    const b = box({ packExit: 2 })
    const record = await runSandboxDelivery({
      exec: b.exec,
      readFile: b.readFile,
      target,
      outDir,
      mode: "checkpoint",
      adapterStore: { adapterSessionId: "sbx_dead_1" },
    })

    expect(record.adapterStore?.status).toBe("failed")
    expect(record.adapterStore?.detail).toContain("packing the adapter store failed")
    expect(record.push.status).toBe("pushed")
    const persisted = JSON.parse(await readFile(join(outDir, CHECKPOINT_RECORD_FILE), "utf8"))
    expect(persisted.push.status).toBe("pushed")
  })

  it("a teardown delivery is untouched by the store passenger", async () => {
    const b = box()
    const record = await runSandboxDelivery({
      exec: b.exec,
      readFile: b.readFile,
      target,
      outDir,
      adapterStore: { adapterSessionId: "sbx_dead_1" },
    })

    expect(record.adapterStore).toBeUndefined()
    expect(b.commands.some(c => c.command.includes(BOX_ADAPTER_STORE_ARCHIVE_PATH))).toBe(false)
    expect(b.downloads).toEqual([])
  })
})

/** The pack/extract commands are SHELL — run them for real (skip without
 *  tar/gzip/bash) so a syntax or status-code mistake can't hide behind a
 *  fake `exec`. */
describe("the real shell round trip", () => {
  let deadHome: string
  let hostDir: string
  beforeEach(async () => {
    deadHome = await mkdtemp(join(tmpdir(), "agentproto-store-dead-"))
    hostDir = await mkdtemp(join(tmpdir(), "agentproto-store-host-"))
  })
  afterEach(async () => {
    await rm(deadHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    await rm(hostDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  async function seedStore(home: string, id: string, body = "hello\n") {
    const dir = join(home, ".agentproto", "adapter-config", id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "conversation.jsonl"), body)
    return dir
  }

  it.skipIf(!hasRealTar)("packs the session's store and reports the real byte count", async () => {
    await seedStore(deadHome, "sbx_dead_1")
    const boxPath = join(hostDir, "store.tar.gz")
    const result = await sh(buildAdapterStoreArchiveCommand("sbx_dead_1", boxPath), deadHome)
    expect(result.exitCode).toBe(0)
    const parsed = parseAdapterStoreArchive(result.stdout)
    expect(parsed?.bytes).toBeGreaterThan(0)
    expect((await stat(boxPath)).size).toBe(parsed?.bytes)
    // ONLY this session's dir travelled with it.
    const listing = await sh(`tar -tzf '${boxPath}'`, deadHome)
    expect(listing.stdout).toContain(adapterStoreRelativeDir("sbx_dead_1"))
    expect(listing.stdout).not.toContain(adapterStoreRelativeDir("sbx_other_2"))
  })

  it.skipIf(!hasRealTar)("a tar failure is reported from tar itself, not swallowed", async () => {
    await seedStore(deadHome, "sbx_dead_1")
    // The archive cannot be created (its directory does not exist) — tar's
    // own non-zero status must surface, which a `tar | gzip` pipe could hide.
    const boxPath = join(deadHome, "no-such-dir", "store.tar.gz")
    const result = await sh(buildAdapterStoreArchiveCommand("sbx_dead_1", boxPath), deadHome)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("tar failed")
  })

  it.skipIf(!hasRealTar)("a missing store exits 0 with store=missing", async () => {
    const boxPath = join(hostDir, "store.tar.gz")
    const result = await sh(buildAdapterStoreArchiveCommand("sbx_absent", boxPath), deadHome)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("store=missing")
    expect(existsSync(boxPath)).toBe(false)
  })

  it.skipIf(!hasRealTar)("restores the archive into a DIFFERENT home at the same relative path", async () => {
    await seedStore(deadHome, "sbx_dead_1")
    const boxPath = join(deadHome, "store.tar.gz")
    const packed = await sh(buildAdapterStoreArchiveCommand("sbx_dead_1", boxPath), deadHome)
    expect(packed.exitCode).toBe(0)
    const archivePath = adapterStoreArchivePath(hostDir)
    const bytes = await readFile(boxPath)
    await writeFile(archivePath, bytes)

    const freshHome = await mkdtemp(join(tmpdir(), "agentproto-store-fresh-"))
    try {
      const uploads: string[] = []
      const result = await restoreAdapterStore({
        writeFile: async (path, data) => {
          uploads.push(path)
          await writeFile(path, data)
        },
        exec: async o => {
          const r = await sh(o.command, freshHome)
          return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, durationMs: 1 }
        },
        archivePath,
        boxPath: join(freshHome, "restore.tar.gz"),
      })
      expect(result).toEqual({ ok: true, bytes: bytes.byteLength })
      expect(uploads).toHaveLength(1)
      const restored = join(freshHome, ".agentproto", "adapter-config", "sbx_dead_1", "conversation.jsonl")
      expect(await readFile(restored, "utf8")).toBe("hello\n")
      // The upload and the listing are cleaned up after a successful restore.
      expect(existsSync(join(freshHome, "restore.tar.gz"))).toBe(false)
      expect(existsSync(`${join(freshHome, "restore.tar.gz")}.list`)).toBe(false)
    } finally {
      await rm(freshHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    }
  })

  it.skipIf(!hasRealTar)("refuses an archive whose members escape the store dir", async () => {
    const stage = join(deadHome, "stage")
    await mkdir(stage, { recursive: true })
    await writeFile(join(stage, "escape.txt"), "pwned\n")
    // `-P` keeps the `../` member — a store built by an older/looser tar could
    // carry one; nothing may be extracted outside the session's dir.
    const hostile = join(hostDir, "hostile.tar.gz")
    const built = await sh(
      `tar -P --sort=name -czf '${hostile}' -C '${stage}' ../stage/escape.txt`,
      deadHome,
    )
    expect(built.exitCode).toBe(0)

    const freshHome = await mkdtemp(join(tmpdir(), "agentproto-store-hostile-"))
    try {
      const archivePath = adapterStoreArchivePath(hostDir)
      await writeFile(archivePath, await readFile(hostile))
      const result = await restoreAdapterStore({
        writeFile: async (path, data) => {
          await writeFile(path, data)
        },
        exec: async o => {
          const r = await sh(o.command, freshHome)
          return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, durationMs: 1 }
        },
        archivePath,
        boxPath: join(freshHome, "restore.tar.gz"),
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toContain("unsafe member path")
      expect(existsSync(join(freshHome, "..", "stage", "escape.txt"))).toBe(false)
      expect(existsSync(join(freshHome, "stage", "escape.txt"))).toBe(false)
    } finally {
      await rm(freshHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    }
  })
})
