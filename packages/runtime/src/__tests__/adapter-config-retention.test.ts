/**
 * Adapter-config cache retention (`adapter-config-retention.ts`): a dead
 * lineage's `~/.agentproto/adapter-config/<id>/` dir loses its cache content
 * (pnpm store, opencode snapshot/tool-output/log) and keeps what a resume
 * reads. Before this pass nothing removed any of it (1764 dirs, 124 GB on
 * one host, 2026-10-27).
 *
 * Hermetic: every test works in its own temp base dir.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { SESSION_CACHE_MANIFEST } from "@agentproto/harness"
import { runAdapterCacheRetentionPass } from "../adapter-config-retention.js"
import { createSessionsRegistry } from "../sessions.js"
import type { SessionDescriptor } from "../sessions.js"

const DAY = 86_400_000
const NOW = Date.parse("2026-10-27T12:00:00.000Z")

let root: string
let base: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "agp-adapter-cache-")))
  base = join(root, "adapter-config")
  mkdirSync(base, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function write(p: string, content = "x"): void {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

/** Set every mtime under `p` (links not followed) to `ageDays` before NOW. */
function age(p: string, ageDays: number): void {
  const ts = new Date(NOW - ageDays * DAY)
  const st = lstatSync(p)
  if (st.isSymbolicLink()) return
  if (st.isDirectory()) for (const n of readdirSync(p)) age(join(p, n), ageDays)
  utimesSync(p, ts, ts)
}

/** An opencode credential-spawn dir as the driver leaves it. */
function opencodeDir(id: string, opts: { manifest?: boolean; ageDays?: number } = {}): string {
  const dir = join(base, id)
  write(join(dir, "auth-data", "opencode", "opencode.db"), "conversation")
  write(join(dir, "auth-data", "opencode", "opencode.db-wal"))
  write(join(dir, "auth-data", "opencode", "snapshot", "06230f65", "objects", "ab", "cdef"))
  write(join(dir, "auth-data", "opencode", "tool-output", "tool_1"))
  write(join(dir, "auth-data", "opencode", "log", "opencode.log"))
  write(join(dir, "auth-data", "pnpm", "store", "v11", "files", "00", "blob"))
  if (opts.manifest !== false) {
    write(
      join(dir, SESSION_CACHE_MANIFEST),
      JSON.stringify({
        version: 1,
        disposable: [
          "auth-data/opencode/log",
          "auth-data/opencode/snapshot",
          "auth-data/opencode/tool-output",
          "auth-data/pnpm/store",
        ],
      }),
    )
  }
  age(dir, opts.ageDays ?? 5)
  return dir
}

function registry(descs: Partial<SessionDescriptor>[] = []) {
  return { list: () => descs as SessionDescriptor[] }
}

function desc(id: string, ageDays: number, extra: Partial<SessionDescriptor> = {}): Partial<SessionDescriptor> {
  const ts = new Date(NOW - ageDays * DAY).toISOString()
  return {
    id,
    kind: "agent-cli",
    status: "killed",
    startedAt: ts,
    lastActivityAt: ts,
    adapterConfigDir: join(base, id),
    ...extra,
  }
}

const run = (reg: ReturnType<typeof registry>, extra: Record<string, unknown> = {}) =>
  runAdapterCacheRetentionPass({ baseDir: base, registry: reg, now: () => NOW, ...extra })

describe("runAdapterCacheRetentionPass", () => {
  it("prunes a dead session's caches and keeps its resume store", async () => {
    const dir = opencodeDir("sess_dead")
    const res = await run(registry([desc("sess_dead", 5)]))
    expect(res).toMatchObject({ enabled: true, count: 1, paths: 4, ids: ["sess_dead"], errors: 0 })
    expect(existsSync(join(dir, "auth-data", "opencode", "snapshot"))).toBe(false)
    expect(existsSync(join(dir, "auth-data", "opencode", "tool-output"))).toBe(false)
    expect(existsSync(join(dir, "auth-data", "opencode", "log"))).toBe(false)
    expect(existsSync(join(dir, "auth-data", "pnpm", "store"))).toBe(false)
    // What `session/load` reads stays.
    expect(existsSync(join(dir, "auth-data", "opencode", "opencode.db"))).toBe(true)
    expect(existsSync(join(dir, "auth-data", "opencode", "opencode.db-wal"))).toBe(true)
    expect(existsSync(join(dir, SESSION_CACHE_MANIFEST))).toBe(true)

    // A second sweep finds nothing left to do.
    const again = await run(registry([desc("sess_dead", 5)]))
    expect(again).toMatchObject({ count: 0, kept: { nothingToPrune: 1 } })
  })

  it("removes a store linked to the operator's own, never the store itself", async () => {
    const operatorStore = join(root, "operator", "pnpm", "store")
    write(join(operatorStore, "v11", "files", "00", "shared-blob"))
    const dir = opencodeDir("sess_linked")
    rmSync(join(dir, "auth-data", "pnpm", "store"), { recursive: true })
    symlinkSync(operatorStore, join(dir, "auth-data", "pnpm", "store"))
    age(dir, 5)

    const res = await run(registry([desc("sess_linked", 5)]))
    expect(res.count).toBe(1)
    expect(() => lstatSync(join(dir, "auth-data", "pnpm", "store"))).toThrow()
    expect(existsSync(join(operatorStore, "v11", "files", "00", "shared-blob"))).toBe(true)
  })

  it("prunes a dir written before the manifest existed, and one no descriptor points at any more", async () => {
    const legacy = opencodeDir("sess_legacy", { manifest: false })
    const res = await run(registry([]))
    expect(res).toMatchObject({ count: 1, paths: 4, ids: ["sess_legacy"] })
    expect(existsSync(join(legacy, "auth-data", "opencode", "snapshot"))).toBe(false)
    expect(existsSync(join(legacy, "auth-data", "opencode", "opencode.db"))).toBe(true)
  })

  it("never touches a live, pinned or keepAlive lineage, nor the ancestor of a live session", async () => {
    for (const id of ["sess_run", "sess_pin", "sess_keep", "sess_parent"]) opencodeDir(id)
    const res = await run(
      registry([
        desc("sess_run", 5, { status: "running" }),
        desc("sess_pin", 5, { pinned: true }),
        desc("sess_keep", 5, { keepAlive: true }),
        desc("sess_parent", 5),
        desc("sess_child", 0, { status: "running", parentSessionId: "sess_parent", adapterConfigDir: join(base, "sess_child") }),
      ]),
    )
    expect(res.count).toBe(0)
    expect(res.kept.protected).toBe(4)
    for (const id of ["sess_run", "sess_pin", "sess_keep", "sess_parent"]) {
      expect(existsSync(join(base, id, "auth-data", "opencode", "snapshot"))).toBe(true)
    }
  })

  it("keeps a dir a live restart of the lineage still uses (the dir is named after the first id)", async () => {
    opencodeDir("sess_first")
    const res = await run(
      registry([
        desc("sess_first", 5),
        desc("sess_restarted", 0, { status: "running", adapterConfigDir: join(base, "sess_first") }),
      ]),
    )
    expect(res.count).toBe(0)
    expect(res.kept.protected).toBe(1)
  })

  it("waits for the quiet time: recent activity, or a file written recently in a dir nothing owns", async () => {
    opencodeDir("sess_recent", { ageDays: 0.2 })
    const quietDesc = opencodeDir("sess_db_touched")
    utimesSync(join(quietDesc, "auth-data", "opencode", "opencode.db-wal"), new Date(NOW), new Date(NOW))
    const res = await run(registry([desc("sess_recent", 0.2)]))
    expect(res.count).toBe(0)
    expect(res.kept.tooRecent).toBe(2)
  })

  it("never deletes through a symlinked parent that leaves the dir", async () => {
    const outside = join(root, "real-data")
    write(join(outside, "opencode", "snapshot", "precious"))
    const dir = join(base, "sess_escape")
    mkdirSync(dir, { recursive: true })
    symlinkSync(outside, join(dir, "auth-data"))
    age(dir, 5)
    age(outside, 5)
    const res = await run(registry([desc("sess_escape", 5)]))
    expect(res.count).toBe(0)
    expect(existsSync(join(outside, "opencode", "snapshot", "precious"))).toBe(true)
  })

  it("ignores manifest entries that escape the dir", async () => {
    const victim = join(root, "victim")
    write(join(victim, "file"))
    const dir = join(base, "sess_evil")
    write(join(dir, SESSION_CACHE_MANIFEST), JSON.stringify({ version: 1, disposable: ["../../victim", victim] }))
    age(dir, 5)
    await run(registry([desc("sess_evil", 5)]))
    expect(existsSync(join(victim, "file"))).toBe(true)
  })

  it("dryRun reports without deleting; a non-positive age disables the pass", async () => {
    const dir = opencodeDir("sess_dry")
    const dry = await run(registry([desc("sess_dry", 5)]), { dryRun: true })
    expect(dry).toMatchObject({ dryRun: true, count: 1, paths: 4 })
    expect(existsSync(join(dir, "auth-data", "opencode", "snapshot"))).toBe(true)

    const off = await run(registry([desc("sess_dry", 5)]), { maxAgeDays: 0 })
    expect(off).toMatchObject({ enabled: false, scanned: 0, count: 0 })
  })

  it("onlyIds limits a scoped caller to dirs its subtree owns", async () => {
    opencodeDir("sess_mine")
    opencodeDir("sess_theirs")
    const res = await run(registry([desc("sess_mine", 5), desc("sess_theirs", 5)]), {
      onlyIds: new Set(["sess_mine"]),
    })
    expect(res.ids).toEqual(["sess_mine"])
    expect(existsSync(join(base, "sess_theirs", "auth-data", "opencode", "snapshot"))).toBe(true)
  })
})

describe("SessionsRegistry.pruneAdapterConfigCaches", () => {
  it("sweeps the configured base dir with the configured default age", async () => {
    opencodeDir("sess_orphan")
    const reg = createSessionsRegistry({
      persistPath: join(root, "sessions.json"),
      adapterCacheRetention: { baseDir: base },
    })
    const dry = await reg.pruneAdapterConfigCaches({ dryRun: true })
    expect(dry).toMatchObject({ maxAgeDays: 1, count: 1 })
    const disabled = createSessionsRegistry({
      persistPath: join(root, "sessions2.json"),
      adapterCacheRetention: { baseDir: base, maxAgeDays: 0 },
    })
    expect((await disabled.pruneAdapterConfigCaches()).enabled).toBe(false)
  })
})
