/**
 * `POST /host/processes/:pid/stop`: the daemon stops ONE process of a
 * session, and nothing else. The decision is tested as a pure function, the
 * runner with fake effects, and the route end to end with real processes:
 * a session's child is stopped, a process outside every session is refused.
 */

import { afterEach, describe, expect, it } from "vitest"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { startHttpServer, type RuntimeHttpServerOptions } from "../http-server.js"
import {
  authorizeStopProcess,
  stopSessionProcess,
  type StopProcessDeps,
} from "../host-stop-process.js"
import type { ProcRow } from "../process-stats.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import { createRuntimeEvents } from "../events.js"

const row = (pid: number, ppid: number, args: string, uid = 501): ProcRow => ({
  pid,
  ppid,
  uid,
  rssKib: 1000,
  cpuPercent: 0,
  elapsedSec: 60,
  args,
})

// launchd(1) -> shell(100) -> daemon(200) -> session adapter(300) -> bash(400) -> bfs(500)
//                          -> editor(150)                         -> other session(310)
const TABLE: ProcRow[] = [
  row(100, 1, "-zsh"),
  row(150, 100, "vim notes.md"),
  row(200, 100, "node agentproto serve"),
  row(300, 200, "claude-agent-acp"),
  row(400, 300, "bash -c bfs -S dfs / -name x"),
  row(500, 400, "bfs -S dfs / -name x"),
  row(310, 200, "codex app-server"),
  row(600, 1, "bfs / -name y", 0),
  row(700, 200, "node worktree-provision"),
]
const SESSIONS = [
  { id: "sess_aaaa", pid: 300, live: true, label: "fig-step" },
  { id: "sess_bbbb", pid: 310, live: true },
  { id: "sess_dead", pid: 150, live: false },
]
const decide = (pid: number) =>
  authorizeStopProcess({ pid, table: TABLE, sessions: SESSIONS, daemonPid: 200, uid: 501 })

describe("authorizeStopProcess", () => {
  it("allows a descendant of a live session, naming its owner", () => {
    const d = decide(500)
    expect(d).toMatchObject({ ok: true, owner: { sessionId: "sess_aaaa", label: "fig-step", sessionPid: 300 } })
    expect(decide(400)).toMatchObject({ ok: true, owner: { sessionId: "sess_aaaa" } })
  })

  it("refuses everything else, each with its reason", () => {
    expect(decide(200)).toMatchObject({ ok: false, code: "daemon" })
    expect(decide(100)).toMatchObject({ ok: false, code: "daemon-ancestor" })
    expect(decide(300)).toMatchObject({ ok: false, code: "session-root" })
    expect(decide(310)).toMatchObject({ ok: false, code: "session-root" })
    // The operator's editor: outside every session (its "session" is dead).
    expect(decide(150)).toMatchObject({ ok: false, code: "not-in-session" })
    // A daemon-side process that is not under a session.
    expect(decide(700)).toMatchObject({ ok: false, code: "not-in-session" })
    expect(decide(600)).toMatchObject({ ok: false, code: "foreign-user" })
    expect(decide(999)).toMatchObject({ ok: false, code: "not-found" })
    expect(decide(1)).toMatchObject({ ok: false, code: "invalid-pid" })
  })
})

describe("stopSessionProcess", () => {
  function deps(over: Partial<StopProcessDeps> & { aliveAfter?: number; table?: () => Promise<ProcRow[]> } = {}) {
    const signals: string[] = []
    const logs: Record<string, unknown>[] = []
    const notes: { to: string; text: string }[] = []
    let calls = 0
    const d: StopProcessDeps = {
      table: async () => TABLE,
      sessions: () => SESSIONS,
      daemonPid: 200,
      uid: 501,
      kill: (pid, sig) => {
        signals.push(`${sig}:${pid}`)
      },
      alive: () => ++calls <= (over.aliveAfter ?? 1),
      sleep: async () => {},
      log: async r => {
        logs.push(r)
      },
      notify: async (owner, text) => {
        notes.push({ to: owner.sessionId, text })
        return true
      },
      ...over,
    }
    return { d, signals, logs, notes }
  }

  it("SIGTERMs, logs who and why, and tells the owning session", async () => {
    const { d, signals, logs, notes } = deps()
    const r = await stopSessionProcess({ pid: 500, reason: "whole-disk scan", by: "sess_esc1" }, d)
    expect(r).toMatchObject({ ok: true, signal: "SIGTERM", exited: true, notified: true })
    expect(signals).toEqual(["SIGTERM:500"])
    expect(logs[0]).toMatchObject({ by: "sess_esc1", reason: "whole-disk scan", pid: 500, ok: true, ownerSessionId: "sess_aaaa" })
    expect(notes[0]?.to).toBe("sess_aaaa")
    expect(notes[0]?.text).toContain("whole-disk scan")
  })

  it("SIGKILLs a process that outlives the grace delay", async () => {
    const { d, signals } = deps({ aliveAfter: 1000 })
    const r = await stopSessionProcess({ pid: 500, reason: "scan", by: "operator", graceMs: 300 }, d)
    expect(signals).toEqual(["SIGTERM:500", "SIGKILL:500"])
    expect(r.signal).toBe("SIGKILL")
  })

  it("never SIGKILLs a pid that now runs another command", async () => {
    let n = 0
    const { d, signals } = deps({
      aliveAfter: 1000,
      table: async () => (n++ === 0 ? TABLE : TABLE.map(r => (r.pid === 500 ? { ...r, args: "something else" } : r))),
    })
    await stopSessionProcess({ pid: 500, reason: "scan", by: "operator", graceMs: 200 }, d)
    expect(signals).toEqual(["SIGTERM:500"])
  })

  it("logs a refusal and sends no signal", async () => {
    const { d, signals, logs, notes } = deps()
    const r = await stopSessionProcess({ pid: 150, reason: "scan", by: "sess_esc1" }, d)
    expect(r).toMatchObject({ ok: false, code: "not-in-session" })
    expect(signals).toEqual([])
    expect(notes).toEqual([])
    expect(logs[0]).toMatchObject({ ok: false, code: "not-in-session", by: "sess_esc1" })
  })

  it("requires a reason", async () => {
    const { d, signals } = deps()
    expect(await stopSessionProcess({ pid: 500, reason: "  ", by: "operator" }, d)).toMatchObject({
      ok: false,
      code: "invalid-reason",
    })
    expect(signals).toEqual([])
  })
})

// ── end to end: real processes through the route ────────────────────

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

const noopConversations = (): ConversationStore => ({
  async open() {},
  async appendTurn() {},
  async read() {
    return { meta: {} as never, turns: [] }
  },
  async list() {
    return []
  },
  pathFor: (id: string) => id,
})
const noopHeartbeat = (): HeartbeatRunner => ({ start() {}, stop() {}, async fireNow() {} })

const children: ChildProcess[] = []
afterEach(() => {
  for (const c of children.splice(0)) {
    try {
      // Each test process leads its own group: take the whole group down,
      // so no grandchild outlives the test.
      if (c.pid !== undefined) process.kill(-c.pid, "SIGKILL")
    } catch {
      // gone
    }
  }
})

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 50))
  }
}

describe.skipIf(process.platform === "win32")("POST /host/processes/:pid/stop (real processes)", () => {
  it("stops a session's child process and refuses a process outside every session", async () => {
    // A "session adapter": a shell whose child is the process to stop.
    const adapter = spawn("sh", ["-c", "sleep 300 & echo $!; sleep 300"], {
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    })
    children.push(adapter)
    const childPid = await new Promise<number>(resolve => {
      adapter.stdout!.once("data", (b: Buffer) => resolve(Number(b.toString().trim())))
    })
    // Outside every session: a child of the test process (the "daemon").
    const outsider = spawn("sleep", ["300"], { stdio: "ignore", detached: true })
    children.push(outsider)

    const notices: { to: string; text: string }[] = []
    const registry = {
      list: () => [{ id: "sess_test1", pid: adapter.pid, status: "running", label: "scan-step" }],
      sendMessage: async (msg: { to: string; text: string }) => {
        notices.push({ to: msg.to, text: msg.text })
        return { delivered: true }
      },
    }
    const dir = await mkdtemp(join(tmpdir(), "stop-process-"))
    const logPath = join(dir, "stop.log")
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () => {
        const { createMcpServer } = await import("@agentproto/mcp-server")
        return (await createMcpServer({ specs: [], name: "main", version: "0" })).server
      },
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      sessions: registry,
      meta: { workspace: process.cwd(), registered: [] },
      hostStopProcessLogPath: logPath,
    } as unknown as RuntimeHttpServerOptions)
    try {
      const post = (pid: number, caller?: string) =>
        fetch(`http://127.0.0.1:${port}/host/processes/${pid}/stop${caller ? `?callerSessionId=${caller}` : ""}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "test: whole-disk scan", graceMs: 2000 }),
        })

      const ok = await post(childPid, "sess_escalation")
      expect(ok.status).toBe(200)
      expect(await ok.json()).toMatchObject({ ok: true, pid: childPid, owner: { sessionId: "sess_test1" }, notified: true })
      await waitFor(() => !isAlive(childPid), "the session's child to exit")
      expect(isAlive(adapter.pid!)).toBe(true) // only the target, not the session

      const refused = await post(outsider.pid!, "sess_escalation")
      expect(refused.status).toBe(403)
      expect(await refused.json()).toMatchObject({ ok: false, code: "not-in-session" })
      expect(isAlive(outsider.pid!)).toBe(true)

      const daemon = await post(process.pid)
      expect(daemon.status).toBe(403)
      expect(await daemon.json()).toMatchObject({ ok: false, code: "daemon" })

      expect(notices).toHaveLength(1)
      expect(notices[0]!.to).toBe("sess_test1")
      const log = (await readFile(logPath, "utf8")).trim().split("\n").map(l => JSON.parse(l) as Record<string, unknown>)
      expect(log.map(l => [l.ok, l.by, l.code ?? null])).toEqual([
        [true, "sess_escalation", null],
        [false, "sess_escalation", "not-in-session"],
        [false, "operator", "daemon"],
      ])
    } finally {
      await http.stop()
      await rm(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
