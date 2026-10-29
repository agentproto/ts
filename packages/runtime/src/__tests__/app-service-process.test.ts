/**
 * Unit tests for the deterministic app-service process runner
 * (app-service-process.ts): registry adoption (no PTY, no LLM adapter), the
 * structured-vs-legacy command resolution, backoff-capped restarts, durable
 * log draining, and the process-group cleanup (uninstall / boot re-ensure).
 * The group-kill + log tests spawn REAL processes; everything else uses an
 * injectable child/clock seam and carries no OS processes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import EventEmitter from "node:events"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import {
  startAppServiceProcess,
  resolveServiceCommand,
  killServiceProcess,
  appServiceLogPath,
  DEFAULT_APP_SERVICE_RESTART_POLICY,
  readProcessStartTicks,
  parsePsLstart,
  assessRecordedServicePid,
  cleanupLegacyServicePidFile,
} from "../app-service-process.js"
import { SESSION_ID_ENV, APP_ID_ENV, createSessionsRegistry } from "../sessions.js"
import type { SessionsRegistry } from "../sessions.js"
import type { AppService } from "@agentproto/app"

const APP_ID = "@test/proc-app"

/** Minimal fake ChildProcess: enough for registry.register (event emitter +
 *  pid) and for the runner's exit/error wiring — NO OS process. */
function fakeChild(pid: number): ChildProcess & { emitExit: (code?: number) => void } {
  const child = new EventEmitter() as unknown as ChildProcess & { emitExit: (code?: number) => void }
  ;(child as { pid: number }).pid = pid
  ;(child as { killed: boolean }).killed = false
  child.emitExit = (code = 0) => {
    child.emit("exit", code, null)
  }
  return child
}

interface Fixture {
  registry: SessionsRegistry
  spawned: Array<{ pid: number; child: ChildProcess & { emitExit: (code?: number) => void } }>
  exit: (n: number, code?: number) => void
  restarts: number[]
  queue: Array<{ delayMs: number; fire: () => void }>
  respawns: Array<{ attempt: number; sessionId: string; pid: number | undefined }>
  errors: string[]
  spawnEnvs: Array<Record<string, string>>
}

function startFixture(opts?: {
  service?: AppService
  policy?: Partial<typeof DEFAULT_APP_SERVICE_RESTART_POLICY>
  logFile?: string
  dir?: string
}): { fx: Fixture; start: () => ReturnType<typeof startAppServiceProcess> } {
  const registry = createSessionsRegistry({ persist: false })
  const fx: Fixture = {
    registry,
    spawned: [],
    exit: (n, code) => fx.spawned[n]?.child.emitExit(code),
    restarts: [],
    queue: [],
    respawns: [],
    errors: [],
    spawnEnvs: [],
  }
  const start = () =>
    startAppServiceProcess({
      registry,
      appId: APP_ID,
      dir: opts?.dir ?? "/apps/proc-app",
      service: opts?.service ?? { name: "web", command: "node", args: ["server.js"] },
      ...(opts?.policy ? { restart: opts.policy } : {}),
      ...(opts?.logFile !== undefined ? { logFile: opts.logFile } : {}),
      spawnChild: (_spec, o) => {
        void _spec
        const pid = 10_000 + fx.spawned.length
        const child = fakeChild(pid)
        fx.spawned.push({ pid, child })
        fx.spawnEnvs.push(o.env)
        return child
      },
      schedule: (fn, delayMs) => {
        fx.restarts.push(delayMs)
        let canceled = false
        const entry = {
          delayMs,
          fire: () => {
            if (!canceled) fn()
          },
        }
        fx.queue.push(entry)
        return () => {
          canceled = true
        }
      },
      now: () => 10_000_000_000 + fx.restarts.length * 1000,
      onRespawn: (attempt, info) =>
        fx.respawns.push({ attempt, sessionId: info.sessionId, pid: info.pid }),
      onError: message => fx.errors.push(message),
    })
  return { fx, start }
}

describe("resolveServiceCommand", () => {
  it("prefers the structured form and passes argv verbatim (no shell)", () => {
    const res = resolveServiceCommand(
      { name: "web", command: "node", args: ["server.js", "--port", "4321"], cwd: "server" },
      "/apps/a",
    )
    expect(res).toMatchObject({
      ok: true,
      shell: false,
      spec: { argv: ["node", "server.js", "--port", "4321"], cwd: "/apps/a/server" },
    })
  })

  it("routes a legacy entry through sh -c (same group, still deterministic)", () => {
    const res = resolveServiceCommand({ name: "web", entry: "node server.js" }, "/apps/a")
    expect(res).toMatchObject({
      ok: true,
      shell: true,
      spec: { argv: ["sh", "-c", "node server.js"], cwd: "/apps/a" },
    })
  })

  it("absolute cwd passes through; both/neither of entry+command is an error", () => {
    expect(resolveServiceCommand({ name: "w", command: "x", cwd: "/abs" }, "/apps/a").ok).toBe(true)
    const both = resolveServiceCommand(
      { name: "w", command: "x", entry: "y" } as unknown as AppService,
      "/apps/a",
    )
    expect(both.ok).toBe(false)
    const neither = resolveServiceCommand({ name: "w" } as unknown as AppService, "/apps/a")
    expect(neither.ok).toBe(false)
  })
})

describe("startAppServiceProcess — deterministic managed process in the registry", () => {
  it("spawns the command, registers a kind:'command' row with label/origin/argv/cwd/pid, and no agent session exists", () => {
    const { fx, start } = startFixture()
    const res = start()
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const { handle } = res
    expect(fx.spawned).toHaveLength(1)
    // Env injection: the session/app identity vars are set (assign-last).
    expect(fx.spawnEnvs[0]?.[SESSION_ID_ENV]).toBe(handle.sessionId)
    expect(fx.spawnEnvs[0]?.[APP_ID_ENV]).toBe(APP_ID)
    expect(handle.pid).toBe(10_000)
    const desc = fx.registry.get(handle.sessionId)!
    expect(desc).toBeDefined()
    expect(desc.kind).toBe("command")
    expect(desc.pty).toBeUndefined()
    expect(desc.status).toBe("running")
    expect(desc.pid).toBe(10_000)
    expect(desc.label).toBe(`app:${APP_ID}:service:web`)
    expect(desc.origin).toBe(`app-service:${APP_ID}`)
    expect(desc.argv).toEqual(["node", "server.js"])
    expect(desc.cwd).toBe("/apps/proc-app")
    // No LLM adapter session anywhere in the registry.
    expect(fx.registry.list().filter(d => d.kind === "agent-cli")).toHaveLength(0)
  })

  it("flips the row to exited with the child's exit code (non-restart-capable spawn)", () => {
    const { fx, start } = startFixture({ policy: { maxAttempts: 0 } })
    const res = start()
    if (!res.ok) throw new Error(res.error)
    fx.exit(0, 7)
    const desc = fx.registry.get(res.handle.sessionId)
    expect(desc?.status).toBe("exited")
    expect(desc?.exitCode).toBe(7)
  })
})

describe("restart with backoff and cap", () => {
  it("respawns with exponential backoff, then gives up after maxAttempts in the window", () => {
    const { fx, start } = startFixture({
      policy: { baseDelayMs: 100, factor: 2, maxDelayMs: 10_000, maxAttempts: 3, windowMs: 60_000 },
    })
    const res = start()
    if (!res.ok) throw new Error(res.error)
    // Attempt 1 dies → restart scheduled at 100ms.
    fx.exit(0, 1)
    expect(fx.restarts).toEqual([100])
    fx.queue[0]?.fire()
    expect(fx.spawned).toHaveLength(2)
    // Attempt 2 dies → 200ms backoff.
    fx.exit(1, 2)
    expect(fx.restarts).toEqual([100, 200])
    fx.queue[1]?.fire()
    expect(fx.spawned).toHaveLength(3)
    // Attempt 3 dies → the cap (3) is reached: no further schedule, no spawn.
    fx.exit(2, 3)
    expect(fx.restarts).toEqual([100, 200])
    expect(fx.spawned).toHaveLength(3)
    expect(fx.errors).toHaveLength(1)
    expect(fx.errors[0]).toContain("gave up after 3 exits")
    // Every attempt landed in the registry (each shows up in the session list).
    const rows = fx.registry.list().filter(d => d.origin === `app-service:${APP_ID}`)
    expect(rows).toHaveLength(3)
    // onRespawn tracked every live attempt (the store stays pointed at the last).
    expect(fx.respawns.map(r => r.attempt)).toEqual([0, 1, 2])
  })

  it("stop() cancels the pending restart after an exit (row keeps its exit state)", () => {
    const { fx, start } = startFixture()
    const res = start()
    if (!res.ok) throw new Error(res.error)
    fx.exit(0, 5)
    expect(fx.queue).toHaveLength(1)
    return res.handle.stop().then(() => {
      // Firing the canceled timer must be a no-op.
      fx.queue.map(q => q.fire())
      expect(fx.spawned).toHaveLength(1)
      expect(res.handle.disposed).toBe(true)
      const desc = fx.registry.get(res.handle.sessionId)
      expect(desc?.status).toBe("exited")
    })
  })

  it("stop() on a live service kills the registry row", () => {
    const { fx, start } = startFixture()
    const res = start()
    if (!res.ok) throw new Error(res.error)
    return res.handle.stop().then(() => {
      const desc = fx.registry.get(res.handle.sessionId)
      expect(desc?.status).toBe("killed")
      expect(fx.spawned).toHaveLength(1)
    })
  })

  it("maxDelayMs caps the backoff", async () => {
    const { fx, start } = startFixture({
      policy: { baseDelayMs: 1000, factor: 2, maxDelayMs: 2000, maxAttempts: 5, windowMs: 60_000 },
    })
    const res = start()
    if (!res.ok) throw new Error(res.error)
    fx.exit(0, 1)
    fx.queue[0]?.fire()
    fx.exit(1, 2)
    fx.queue[1]?.fire()
    fx.exit(2, 3)
    // 1000 → 2000 → capped at 2000 (not 4000).
    expect(fx.restarts).toEqual([1000, 2000, 2000])
  })
})

describe("durable log file", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "app-service-log-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("appends child stdout/stderr to the log file", async () => {
    const logFile = appServiceLogPath(dir, "web")
    const registry = createSessionsRegistry({ persist: false })
    const res = startAppServiceProcess({
      registry,
      appId: APP_ID,
      dir,
      service: {
        name: "web",
        command: "node",
        args: ["-e", "console.log('hello-log'); console.error('err-log')"],
      },
      logFile,
      restart: { maxAttempts: 0 },
    })
    if (!res.ok) throw new Error(res.error)
    let done = false
    for (let i = 0; i < 150 && !done; i++) {
      await new Promise(r => setTimeout(r, 20))
      if (!existsSync(logFile)) continue
      const txt = await readFile(logFile, "utf8")
      done = txt.includes("hello-log") && txt.includes("err-log")
    }
    const text = await readFile(logFile, "utf8")
    expect(text).toContain("hello-log")
    expect(text).toContain("err-log")
    await res.handle.stop()
  }, 15_000)
})

describe("cleanup kills the process group", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "app-service-kill-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("stop() reaps the service and its grandchildren (detached group leader)", async () => {
    // The (legacy-form) service forks its own grandchild and writes its pid to
    // a file — the exact tree shape an owner/pipe-only cleanup leaks.
    const registry = createSessionsRegistry({ persist: false })
    const res = startAppServiceProcess({
      registry,
      appId: APP_ID,
      dir,
      service: {
        name: "web",
        entry:
          `node -e "const cp=require('node:child_process');const fs=require('node:fs');` +
          `const c=cp.spawn('sleep',['300']);fs.writeFileSync(process.env.GRAND_PID_FILE,String(c.pid));` +
          `setInterval(()=>{},60000)"`,
      },
      env: { GRAND_PID_FILE: join(dir, "grand.pid") },
      restart: { maxAttempts: 0 },
    })
    if (!res.ok) throw new Error(res.error)
    const pidFile = join(dir, "grand.pid")
    let grand: number | undefined
    for (let i = 0; i < 100 && grand === undefined; i++) {
      await new Promise(r => setTimeout(r, 50))
      try {
        grand = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10)
      } catch {
        // not written yet
      }
    }
    expect(grand).toBeGreaterThan(0)
    expect(() => process.kill(grand!, 0)).not.toThrow()
    await res.handle.stop()
    await new Promise(r => setTimeout(r, 100))
    // The whole group is dead — not just the node leader.
    expect(() => process.kill(grand!, 0)).toThrow()
  }, 30_000)

  it("killServiceProcess is a no-op for a stale/invalid pid", async () => {
    await expect(killServiceProcess(undefined)).resolves.toBeUndefined()
    await expect(killServiceProcess(1_999_999_999)).resolves.toBeUndefined()
  })
})

describe("parsePsLstart (macOS start-time identity)", () => {
  it("parses a C-locale lstart line to epoch seconds, ignoring padding", () => {
    const expected = Math.floor(new Date("Thu Oct 29 02:07:01 2026").getTime() / 1000)
    expect(parsePsLstart("Thu Oct 29 02:07:01 2026")).toBe(expected)
    expect(parsePsLstart("  Thu Oct 29 02:07:01 2026  \n")).toBe(expected)
    expect(parsePsLstart("Thu Oct  9 02:07:01 2026")).toBe(
      Math.floor(new Date("Thu Oct 9 02:07:01 2026").getTime() / 1000),
    )
  })

  it("returns undefined for empty or unparsable output", () => {
    expect(parsePsLstart("")).toBeUndefined()
    expect(parsePsLstart("   \n")).toBeUndefined()
    expect(parsePsLstart("not a date")).toBeUndefined()
  })

  it.skipIf(process.platform !== "darwin")("reads this process' own start second via ps", () => {
    const ticks = readProcessStartTicks(process.pid)
    const startedAt = Math.floor(Date.now() / 1000 - process.uptime())
    expect(ticks).toBeDefined()
    expect(Math.abs(ticks! - startedAt)).toBeLessThanOrEqual(2)
  })
})

describe("recorded-pid identity assessment (audit F-4)", () => {
  it("assessRecordedServicePid verdicts", async () => {
    // invalid pid → never signal
    expect(assessRecordedServicePid(undefined, 123)).toEqual({ kill: false, reason: expect.any(String) })
    expect(assessRecordedServicePid(-5, 123)).toEqual({ kill: false, reason: expect.any(String) })
    // a LIVE pid of a process we just spawned: match kill, mismatch skip
    const child = spawn("sleep", ["10"], { stdio: "ignore" })
    try {
      const ticks = readProcessStartTicks(child.pid!)
      expect(ticks).toBeGreaterThan(0)
      expect(assessRecordedServicePid(child.pid!, ticks)).toMatchObject({ kill: true })
      expect(assessRecordedServicePid(child.pid!, ticks! + 1)).toMatchObject({ kill: false })
      // stamped record, pid gone (dead): cannot verify → skip
      expect(assessRecordedServicePid(1_999_999_999, 42)).toMatchObject({ kill: false })
    } finally {
      child.kill("SIGKILL")
    }
  })

  it("startAppServiceProcess records start ticks (onLinux /proc available)", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const result = startAppServiceProcess({
      registry,
      appId: "@x/y",
      dir: "/tmp",
      service: { name: "web", entry: "sleep 10" },
    })
    expect(result.ok).toBe(true)
    const handle = (result as { handle: { pid: number; startTicks?: number; stop(): Promise<void> } }).handle
    const ticks = readProcessStartTicks(handle.pid)
    try {
      if (ticks !== undefined) {
        expect(handle.startTicks).toBe(ticks)
      } else {
        // non-/proc platform: skip
      }
    } finally {
      await handle.stop()
    }
  })
})

describe("deliberate kill cancels supervision", () => {
  it("registry.kill of the live attempt row never respawns", () => {
    const { fx, start } = startFixture()
    const res = start()
    if (!res.ok) throw new Error(res.error)
    const id = res.handle.sessionId
    expect(fx.registry.kill(id, "SIGTERM", "operator-stopped")).toBe(true)
    fx.exit(0, 143)
    expect(fx.restarts).toEqual([])
    expect(fx.spawned).toHaveLength(1)
    expect(res.handle.disposed).toBe(true)
  })

  it("registry.kill during the restart-backoff gap never respawns", () => {
    const { fx, start } = startFixture({
      policy: { baseDelayMs: 100, factor: 2, maxAttempts: 5, windowMs: 60_000 },
    })
    const res = start()
    if (!res.ok) throw new Error(res.error)
    const id = res.handle.sessionId
    // The child dies, scheduling a restart; the row is already terminal.
    fx.exit(0, 1)
    expect(fx.restarts).toEqual([100])
    expect(fx.registry.get(id)?.status).toBe("exited")
    // An operator kill lands inside the backoff window — the row is retired,
    // not resurrected by the timer.
    expect(fx.registry.kill(id, "SIGTERM", "operator-stopped")).toBe(true)
    fx.queue[0]?.fire()
    expect(fx.spawned).toHaveLength(1)
    expect(res.handle.disposed).toBe(true)
    expect(fx.respawns.map(r => r.attempt)).toEqual([0])
  })
})

describe("cleanupLegacyServicePidFile (pre-managed-process upgrade)", () => {
  let dir: string
  let child: ReturnType<typeof spawn> | undefined
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "app-service-legacy-"))
    await mkdir(join(dir, "services"), { recursive: true })
  })
  afterEach(async () => {
    child?.kill("SIGKILL")
    child = undefined
    await rm(dir, { recursive: true, force: true })
  })

  it.skipIf(process.platform !== "linux")("kills a verified matching legacy pid and removes the file", async () => {
    child = spawn("sleep", ["30"], { stdio: "ignore" })
    const file = join(dir, "services", "web.pid")
    await writeFile(file, String(child.pid))
    const result = await cleanupLegacyServicePidFile(dir, "web", "sleep")
    expect(result).toMatchObject({ killed: true })
    expect(existsSync(file)).toBe(false)
    // Poll for the signal to land — don't race the child's own `exit` event.
    let alive = true
    for (let i = 0; i < 100 && alive; i++) {
      try {
        process.kill(child!.pid!, 0)
        await new Promise(r => setTimeout(r, 20))
      } catch {
        alive = false
      }
    }
    expect(alive).toBe(false)
  })

  it.skipIf(process.platform !== "linux")("keeps the file when a live pid does not match the entry", async () => {
    child = spawn("sleep", ["30"], { stdio: "ignore" })
    const file = join(dir, "services", "web.pid")
    await writeFile(file, String(child.pid))
    const result = await cleanupLegacyServicePidFile(dir, "web", "not-this-command-xyz")
    expect(result).toMatchObject({ killed: false })
    expect(result.reason).toContain("does not match")
    expect(existsSync(file)).toBe(true)
    expect(() => process.kill(child!.pid!, 0)).not.toThrow()
  })
})
