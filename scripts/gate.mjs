#!/usr/bin/env node
/**
 * gate — the machine-wide local gate runner (`pnpm gate`).
 *
 * Nothing used to stop N worktrees from running N full `pnpm test` gates at
 * once, which saturates the host. This script serialises gates machine-wide
 * and narrows each one to what the branch changed:
 *
 *   1. Refuses to start while the host-guard CRIT marker is armed, or when
 *      the 1-minute load average is above 1.5x the core count.
 *   2. Takes a slot in `~/.agentproto/gate.lock` (`mkdir` is atomic on every
 *      platform; `flock(1)` does not exist on macOS). `AGENTPROTO_GATE_SLOTS`
 *      (default 1) allows more than one concurrent gate. A lock whose pid is
 *      dead is stale and is taken over.
 *   3. Waits in the FOREGROUND (poll 5 s, give up after 8 min) — never
 *      background-and-yield, see AGENTS.md.
 *   4. Runs CI's docs coverage check, then `nice -n 10 turbo run build
 *      check-types test --affected` with the shared turbo cache. `--full` drops
 *      `--affected` (turbo.json, root package.json, vitest.shared.ts,
 *      pnpm-lock.yaml changes, or a human ask).
 *   5. Always releases the lock and prints `GATE_EXIT=<n>` as the last line.
 *
 * Exit codes: the gate command's own code, or 75 lock wait timed out
 * (retryable), 69 host-guard CRIT marker armed, 73 host load too high,
 * 64 bad usage.
 *
 * Flags: `--full`, `--dry-run` (do every check and take the lock, print the
 * command, run nothing).
 */

import { spawn } from "node:child_process"
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, cpus, loadavg } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"

export const EXIT_USAGE = 64
export const EXIT_CRIT = 69
export const EXIT_LOAD = 73
export const EXIT_LOCK_TIMEOUT = 75

export const DEFAULT_LOCK_PATH = join(homedir(), ".agentproto", "gate.lock")
export const DEFAULT_GUARD_STATE_PATH = join(homedir(), ".agentproto", "host-guard", "state.json")
export const DEFAULT_WAIT_TIMEOUT_MS = 8 * 60_000
export const DEFAULT_POLL_MS = 5_000
const LOCK_INFO = "info.json"
// A lock dir is created before its info file is written; within this window
// an unreadable info file means "being written", not "stale".
const INFO_GRACE_MS = 10_000

export class GateLockTimeout extends Error {
  constructor(holders, waitedMs) {
    super(
      `gate busy: waited ${Math.round(waitedMs / 1000)}s for a slot; held by ${describeHolders(holders)}. Retry.`,
    )
    this.name = "GateLockTimeout"
    this.holders = holders
  }
}

function describeHolders(holders) {
  if (holders.length === 0) return "an unknown holder"
  return holders
    .map((h) => `pid ${h.pid ?? "?"} in ${h.cwd ?? "?"} since ${h.startedAt ?? "?"}`)
    .join("; ")
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = exists but owned by someone else: alive.
    return err?.code === "EPERM"
  }
}

/** Slot 0 is `<base>`, slot i is `<base>.<i>`. */
export function slotPaths(base, slots) {
  return Array.from({ length: Math.max(1, slots) }, (_, i) => (i === 0 ? base : `${base}.${i}`))
}

function readInfo(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, LOCK_INFO), "utf8"))
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

/** True when the lock at `dir` has no live holder. */
function isStale(dir, info, now) {
  if (info) return !pidAlive(info.pid)
  try {
    return now - statSync(dir).mtimeMs > INFO_GRACE_MS
  } catch {
    return false
  }
}

/** Remove a stale lock without clobbering a live one that replaced it: rename
 *  is atomic, so only one waiter wins; we then re-check what we moved. */
function reclaim(dir, seenPid) {
  const graveyard = `${dir}.stale-${process.pid}-${Date.now()}`
  try {
    renameSync(dir, graveyard)
  } catch {
    return false
  }
  const moved = readInfo(graveyard)
  if (moved && moved.pid !== seenPid && pidAlive(moved.pid)) {
    try {
      renameSync(graveyard, dir)
    } catch {
      /* lost the race again; the holder will re-create on next poll */
    }
    return false
  }
  rmSync(graveyard, { recursive: true, force: true })
  return true
}

function tryAcquireSlot(dir, token, now) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dir)
    } catch (err) {
      if (err?.code !== "EEXIST") throw err
      const info = readInfo(dir)
      if (!isStale(dir, info, now)) return { held: true, info }
      if (!reclaim(dir, info?.pid)) return { held: true, info: readInfo(dir) }
      continue
    }
    const info = { pid: process.pid, startedAt: new Date(now).toISOString(), cwd: process.cwd(), token }
    writeFileSync(join(dir, LOCK_INFO), JSON.stringify(info) + "\n")
    return { held: false, info }
  }
  return { held: true, info: readInfo(dir) }
}

/**
 * Acquire one of `slots` machine-wide gate slots, waiting in the foreground.
 * Resolves `{ release, path }`; rejects with {@link GateLockTimeout}.
 */
export async function acquireGateLock({
  path = DEFAULT_LOCK_PATH,
  slots = 1,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  onWait = () => {},
} = {}) {
  mkdirSync(join(path, ".."), { recursive: true })
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const paths = slotPaths(path, slots)
  const start = Date.now()
  for (let first = true; ; first = false) {
    const holders = []
    for (const dir of paths) {
      const res = tryAcquireSlot(dir, token, Date.now())
      if (!res.held) {
        let released = false
        return {
          path: dir,
          release() {
            if (released) return
            released = true
            // Only remove a lock that is still ours.
            if (readInfo(dir)?.token === token) rmSync(dir, { recursive: true, force: true })
          },
        }
      }
      if (res.info) holders.push(res.info)
    }
    const waited = Date.now() - start
    if (waited >= timeoutMs) throw new GateLockTimeout(holders, waited)
    if (first || Math.floor(waited / 30_000) !== Math.floor((waited - pollMs) / 30_000)) {
      onWait(`gate: waiting for a slot, held by ${describeHolders(holders)} (${Math.round(waited / 1000)}s)`)
    }
    await sleep(Math.min(pollMs, Math.max(1, timeoutMs - waited)))
  }
}

/** Reason to refuse because the host-guard CRIT marker is armed, else null.
 *  Defensive twin of `readGuardState`/`heavyWorkflowBlockReason`
 *  (packages/cli/src/commands/host-guard.ts): that module is TypeScript, and
 *  an unreadable marker means "not armed". */
export function critBlockReason(statePath = DEFAULT_GUARD_STATE_PATH, nowMs = Date.now()) {
  let state
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"))
  } catch {
    return null
  }
  if (!state || state.verdict !== "CRIT") return null
  const expires = Date.parse(state.expiresAt)
  if (!Number.isFinite(expires) || expires <= nowMs) return null
  const reasons = Array.isArray(state.reasons) ? state.reasons.join("; ") : ""
  return `host-guard CRIT marker is armed until ${state.expiresAt} (${reasons || "no reasons recorded"}); free the host and re-run \`agentproto host health\``
}

/** Reason to refuse because the host is already overloaded, else null. */
export function loadBlockReason(load1 = loadavg()[0], cores = cpus().length) {
  const limit = cores * 1.5
  if (load1 > limit) {
    return `host load ${load1.toFixed(1)} exceeds ${limit.toFixed(1)} (1.5 x ${cores} cores); wait for it to drop and retry`
  }
  return null
}

export function resolveTurboCacheDir(env = process.env) {
  if (env.AGENTPROTO_WORKTREES_TURBO_CACHE_DIR) return resolve(env.AGENTPROTO_WORKTREES_TURBO_CACHE_DIR)
  if (env.TURBO_CACHE_DIR) return env.TURBO_CACHE_DIR
  // Honour env.HOME so an overridden HOME (tests, sandboxes) picks its own cache.
  return join(env.HOME || homedir(), ".agentproto", "turbo-cache")
}

/** CI's unconditional pretest doc-coverage check, mirrored here because the
 *  gate calls turbo directly and bypasses npm's `pretest` lifecycle hook. */
export function buildDocsCommand() {
  return { cmd: process.execPath, args: ["scripts/agentflow/docs.mjs", "--check"] }
}

export function buildGateCommand({ full = false, env = process.env } = {}) {
  const args = [
    "-n",
    "10",
    "pnpm",
    "exec",
    "turbo",
    "run",
    "build",
    "check-types",
    "test",
    ...(full ? [] : ["--affected"]),
    "--concurrency=2",
    "--filter=./packages/**",
    "--filter=./adapters/**",
  ]
  return {
    cmd: "nice",
    args,
    env: {
      ...env,
      TURBO_SCM_BASE: env.TURBO_SCM_BASE || "origin/main",
      TURBO_CACHE_DIR: resolveTurboCacheDir(env),
    },
  }
}

function runForeground({ cmd, args, env }) {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, { stdio: "inherit", env })
    const forward = (sig) => () => child.kill(sig)
    const handlers = ["SIGINT", "SIGTERM"].map((sig) => [sig, forward(sig)])
    for (const [sig, h] of handlers) process.on(sig, h)
    const done = (code) => {
      for (const [sig, h] of handlers) process.off(sig, h)
      resolveRun(code)
    }
    child.on("error", (err) => {
      console.error(`gate: failed to start ${cmd}: ${err.message}`)
      done(127)
    })
    child.on("close", (code, signal) => done(code ?? (signal ? 128 + (signalNumber(signal) ?? 0) : 1)))
  })
}

function signalNumber(signal) {
  return { SIGINT: 2, SIGTERM: 15, SIGKILL: 9, SIGHUP: 1 }[signal]
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const flags = new Set(argv)
  const unknown = argv.filter((a) => a !== "--full" && a !== "--dry-run")
  if (unknown.length > 0) {
    console.error(`gate: unknown argument(s): ${unknown.join(" ")} (usage: pnpm gate [--full] [--dry-run])`)
    return EXIT_USAGE
  }

  const crit = critBlockReason()
  if (crit) {
    console.error(`gate: refusing to start: ${crit}`)
    return EXIT_CRIT
  }
  const load = loadBlockReason()
  if (load) {
    console.error(`gate: refusing to start: ${load}`)
    return EXIT_LOAD
  }

  const slots = Number.parseInt(env.AGENTPROTO_GATE_SLOTS ?? "", 10)
  let lock
  try {
    lock = await acquireGateLock({
      slots: Number.isInteger(slots) && slots > 0 ? slots : 1,
      onWait: (msg) => console.error(msg),
    })
  } catch (err) {
    if (err instanceof GateLockTimeout) {
      console.error(`gate: ${err.message}`)
      return EXIT_LOCK_TIMEOUT
    }
    throw err
  }

  // A hard-killed gate leaves a lock whose dead pid the next waiter reclaims.
  const onSignal = () => lock.release()
  process.on("exit", onSignal)
  try {
    const plan = buildGateCommand({ full: flags.has("--full"), env })
    const docs = buildDocsCommand()
    console.error(
      `gate: lock ${lock.path} held; running ${docs.cmd} ${docs.args.join(" ")} && ${plan.cmd} ${plan.args.join(" ")}`,
    )
    if (flags.has("--dry-run")) return 0
    const docsCode = await runForeground({ ...docs, env })
    if (docsCode !== 0) {
      console.error(`gate: docs coverage check failed (exit ${docsCode})`)
      return docsCode
    }
    return await runForeground(plan)
  } finally {
    lock.release()
    process.off("exit", onSignal)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await main().catch((err) => {
    console.error(`gate: ${err?.stack ?? err}`)
    return 1
  })
  console.log(`GATE_EXIT=${code}`)
  process.exit(code)
}
