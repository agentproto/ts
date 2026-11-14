import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  GateLockTimeout,
  acquireGateLock,
  buildDocsCommand,
  buildGateCommand,
  critBlockReason,
  loadBlockReason,
  pidAlive,
  slotPaths,
} from "./gate.mjs"

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), "gate-test-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A pid that is guaranteed dead: a child that already exited. */
function deadPid() {
  return spawnSync(process.execPath, ["-e", "0"]).pid
}

function plantLock(dir, info) {
  mkdirSync(dir, { recursive: true })
  if (info) writeFileSync(join(dir, "info.json"), JSON.stringify(info))
}

test("acquire writes pid/startedAt/cwd and release removes the lock", async (t) => {
  const path = join(tmp(t), "gate.lock")
  const lock = await acquireGateLock({ path, timeoutMs: 100, pollMs: 10 })
  const info = JSON.parse(readFileSync(join(path, "info.json"), "utf8"))
  assert.equal(info.pid, process.pid)
  assert.equal(info.cwd, process.cwd())
  assert.ok(Number.isFinite(Date.parse(info.startedAt)))
  lock.release()
  assert.equal(existsSync(path), false)
  lock.release() // idempotent
})

test("a live holder blocks: times out with GateLockTimeout naming the holder", async (t) => {
  const path = join(tmp(t), "gate.lock")
  const held = await acquireGateLock({ path })
  const waits = []
  await assert.rejects(
    acquireGateLock({ path, timeoutMs: 60, pollMs: 10, onWait: (m) => waits.push(m) }),
    (err) => {
      assert.ok(err instanceof GateLockTimeout)
      assert.match(err.message, new RegExp(`pid ${process.pid}`))
      assert.match(err.message, new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      return true
    },
  )
  assert.equal(waits.length >= 1, true)
  assert.equal(existsSync(path), true, "the live holder's lock is untouched")
  held.release()
})

test("a waiter proceeds as soon as the holder releases", async (t) => {
  const path = join(tmp(t), "gate.lock")
  const held = await acquireGateLock({ path })
  setTimeout(() => held.release(), 40)
  const next = await acquireGateLock({ path, timeoutMs: 2000, pollMs: 10 })
  assert.equal(next.path, path)
  next.release()
})

test("a lock whose pid is dead is taken over", async (t) => {
  const path = join(tmp(t), "gate.lock")
  plantLock(path, { pid: deadPid(), startedAt: new Date().toISOString(), cwd: "/elsewhere" })
  const lock = await acquireGateLock({ path, timeoutMs: 100, pollMs: 10 })
  assert.equal(JSON.parse(readFileSync(join(path, "info.json"), "utf8")).pid, process.pid)
  lock.release()
})

test("a lock dir without info is left alone while fresh, reclaimed once old", async (t) => {
  const path = join(tmp(t), "gate.lock")
  plantLock(path, null)
  await assert.rejects(acquireGateLock({ path, timeoutMs: 40, pollMs: 10 }), GateLockTimeout)
  const old = new Date(Date.now() - 60_000)
  utimesSync(path, old, old)
  const lock = await acquireGateLock({ path, timeoutMs: 100, pollMs: 10 })
  lock.release()
})

test("release never removes a lock that is no longer ours", async (t) => {
  const path = join(tmp(t), "gate.lock")
  const lock = await acquireGateLock({ path })
  writeFileSync(join(path, "info.json"), JSON.stringify({ pid: process.pid, token: "someone-else" }))
  lock.release()
  assert.equal(existsSync(path), true)
})

test("slots: N holders fit, the N+1th waits and the slot freed is reused", async (t) => {
  const path = join(tmp(t), "gate.lock")
  assert.deepEqual(slotPaths(path, 2), [path, `${path}.1`])
  const a = await acquireGateLock({ path, slots: 2 })
  const b = await acquireGateLock({ path, slots: 2 })
  assert.notEqual(a.path, b.path)
  await assert.rejects(acquireGateLock({ path, slots: 2, timeoutMs: 40, pollMs: 10 }), GateLockTimeout)
  a.release()
  const c = await acquireGateLock({ path, slots: 2, timeoutMs: 100, pollMs: 10 })
  assert.equal(c.path, a.path)
  b.release()
  c.release()
})

test("only one of many concurrent waiters wins a stale lock", async (t) => {
  const path = join(tmp(t), "gate.lock")
  plantLock(path, { pid: deadPid(), startedAt: new Date().toISOString(), cwd: "/elsewhere" })
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => acquireGateLock({ path, timeoutMs: 80, pollMs: 10 })),
  )
  const won = results.filter((r) => r.status === "fulfilled")
  assert.equal(won.length, 1)
  won[0].value.release()
})

test("pidAlive", () => {
  assert.equal(pidAlive(process.pid), true)
  assert.equal(pidAlive(deadPid()), false)
  assert.equal(pidAlive(undefined), false)
})

test("critBlockReason: armed, expired, wrong verdict, missing or garbage marker", (t) => {
  const file = join(tmp(t), "state.json")
  const now = Date.parse("2026-11-07T12:00:00Z")
  assert.equal(critBlockReason(file, now), null, "missing marker")
  writeFileSync(file, "{not json")
  assert.equal(critBlockReason(file, now), null, "garbage marker")
  writeFileSync(file, JSON.stringify({ verdict: "WARN", expiresAt: "2026-11-07T13:00:00Z" }))
  assert.equal(critBlockReason(file, now), null, "not CRIT")
  writeFileSync(file, JSON.stringify({ verdict: "CRIT", expiresAt: "2026-11-07T11:00:00Z" }))
  assert.equal(critBlockReason(file, now), null, "expired")
  writeFileSync(file, JSON.stringify({ verdict: "CRIT", expiresAt: "2026-11-07T13:00:00Z", reasons: ["swap 79%"] }))
  assert.match(critBlockReason(file, now), /CRIT.*2026-11-07T13:00:00Z.*swap 79%/)
})

test("loadBlockReason: refuses above 1.5x cores only", () => {
  assert.equal(loadBlockReason(18, 12), null)
  assert.match(loadBlockReason(18.1, 12), /exceeds 18\.0/)
})

test("buildGateCommand: affected by default, --full drops it, shared cache + base ref", () => {
  const affected = buildGateCommand({ env: { HOME: "/h" } })
  assert.equal(affected.cmd, "nice")
  assert.deepEqual(affected.args.slice(0, 2), ["-n", "10"])
  assert.ok(affected.args.includes("--affected"))
  assert.ok(affected.args.includes("--concurrency=2"))
  assert.equal(affected.env.TURBO_SCM_BASE, "origin/main")
  assert.equal(affected.env.TURBO_CACHE_DIR, "/h/.agentproto/turbo-cache")
  const full = buildGateCommand({ full: true, env: { TURBO_CACHE_DIR: "/c" } })
  assert.equal(full.args.includes("--affected"), false)
  assert.equal(full.env.TURBO_CACHE_DIR, "/c")
})

test("buildDocsCommand runs CI's pretest docs coverage check", () => {
  const docs = buildDocsCommand()
  assert.equal(docs.cmd, process.execPath)
  assert.deepEqual(docs.args, ["scripts/agentflow/docs.mjs", "--check"])
})
