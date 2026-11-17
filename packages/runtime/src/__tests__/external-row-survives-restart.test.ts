/**
 * A daemon restart must not turn a live `external` row (Claude Code / Desktop,
 * `cc:<session_id>`) into a dead one. The row owns no process here, so the
 * graceful shutdown sweep used to stamp it `killed`/`daemon-restart`, and every
 * sentinel/follow delivery then bounced with `SessionNotAliveError` until the
 * idle session happened to make an MCP call on its own (observed 2026-11-17).
 *
 * Every case goes through the real persistence path: registry A writes
 * `sessions.json` on `shutdown()`, registry B boots from the same file.
 */

import "../sentinel-platform.js"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer, type Server } from "node:net"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ClaudeSocketWakeConfig } from "../claude-socket-wake.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createSessionMessage } from "../session-message.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"
import { createFakeSentinelProvider, createSentinelRuntime, createSentinelStore, makeFakeEvent, singleMatch } from "@agentproto/sentinel"

const ROW = "cc:chat-1"

interface Harness {
  root: string
  persistPath: string
  transcriptDir: string
  wake: ClaudeSocketWakeConfig
  frames: Array<Record<string, unknown>>
  server: Server
  pid: number
}

async function startHarness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "ext-restart-"))
  const claudeSessionsDir = join(root, "claude-sessions")
  const socketDir = join(root, "socks")
  const transcriptDir = join(root, "transcripts")
  for (const d of [claudeSessionsDir, socketDir, transcriptDir]) mkdirSync(d, { recursive: true })
  const pid = 30_000 + Math.floor(process.pid % 10_000)
  writeFileSync(
    join(claudeSessionsDir, `${pid}.json`),
    JSON.stringify({ pid, sessionId: "chat-1", permissionMode: "auto", status: "idle" }),
  )
  writeFileSync(join(claudeSessionsDir, `${pid}.deadbeef.key`), "k\n")
  const frames: Array<Record<string, unknown>> = []
  const server = createServer(socket => {
    let buf = ""
    socket.on("data", chunk => {
      buf += chunk.toString("utf8")
      let nl = buf.indexOf("\n")
      while (nl !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line) frames.push(JSON.parse(line) as Record<string, unknown>)
        nl = buf.indexOf("\n")
      }
    })
    socket.on("error", () => undefined)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(join(socketDir, `${pid}.sock`), resolve)
  })
  return {
    root,
    persistPath: join(root, "sessions.json"),
    transcriptDir,
    wake: {
      enabled: true,
      claudeSessionsDir,
      socketDir,
      claudeSettingsFile: join(root, "claude-settings.json"),
    },
    frames,
    server,
    pid,
  }
}

function boot(h: Harness): SessionsRegistry {
  return createSessionsRegistry({
    persistPath: h.persistPath,
    transcriptDir: h.transcriptDir,
    sessionEvents: createSessionEventBus(),
    claudeSocketWake: h.wake,
  })
}

function ping(text = "ping") {
  return createSessionMessage({ to: ROW, from: { relation: "system" }, kind: "notice", urgency: "next-turn", text })
}

describe("external row across a daemon restart", () => {
  let h: Harness
  let registry: SessionsRegistry | undefined

  beforeEach(async () => {
    h = await startHarness()
  })

  afterEach(async () => {
    registry?.shutdown()
    registry = undefined
    await new Promise<void>(resolve => h.server.close(() => resolve()))
    rmSync(h.root, { recursive: true, force: true })
  })

  it("stays deliverable after a graceful restart and is woken over the socket", async () => {
    const before = boot(h)
    before.touchExternal({ id: ROW, host: "claude-desktop" })
    expect(before.get(ROW)?.status).toBe("running")
    before.shutdown()
    await before.settlePendingWrites?.()

    registry = boot(h)
    const desc = registry.get(ROW)
    expect(desc?.status).toBe("exited")
    expect(desc?.endedReason).toBeUndefined()

    const res = await registry.sendMessage(ping())
    expect(res.delivered).toEqual({ via: "socket" })
    expect(res.wake).toMatchObject({ written: true, reason: "written", pid: h.pid })
  })

  it("heals a row an older daemon persisted as killed/daemon-restart", async () => {
    const before = boot(h)
    before.touchExternal({ id: ROW, host: "claude-desktop" })
    before.shutdown()
    await before.settlePendingWrites?.()
    // Rewrite the snapshot the way the pre-fix shutdown sweep left it.
    const snap = JSON.parse(readFileSync(h.persistPath, "utf8")) as { sessions: Array<Record<string, unknown>> }
    for (const row of snap.sessions) {
      if (row.id === ROW) Object.assign(row, { status: "killed", endedReason: "daemon-restart", killedMidTurn: false })
    }
    writeFileSync(h.persistPath, JSON.stringify(snap))

    registry = boot(h)
    expect(registry.get(ROW)?.status).toBe("exited")
    const res = await registry.sendMessage(ping())
    expect(res.delivered).toEqual({ via: "socket" })
    expect(res.wake).toMatchObject({ written: true })
  })

  it("an operator-killed external row still refuses after a restart", async () => {
    const before = boot(h)
    before.touchExternal({ id: ROW, host: "claude-desktop" })
    expect(before.kill(ROW)).toBe(true)
    before.shutdown()
    await before.settlePendingWrites?.()

    registry = boot(h)
    expect(registry.get(ROW)?.status).toBe("killed")
    await expect(registry.sendMessage(ping())).rejects.toThrow(/not alive|retired/)
    expect(h.frames).toEqual([])
  })

  it("a sentinel targeting the row delivers right after the restart (no parked replay loop)", async () => {
    const before = boot(h)
    before.touchExternal({ id: ROW, host: "claude-desktop" })
    before.shutdown()
    await before.settlePendingWrites?.()
    registry = boot(h)
    const reg = registry

    const store = createSentinelStore({ persist: false })
    const provider = createFakeSentinelProvider()
    const sentinel = store.create({
      provider: "fake",
      handle: { provider: "fake", remoteId: "fake:widget-1", cursor: "0" },
      spec: {
        match: singleMatch("fake:widget-1"),
        until: { kind: "never" },
        target: { kind: "session", sessionId: ROW, urgency: "next-turn" },
      },
    })
    provider.emit(makeFakeEvent({ id: "evt_1", type: "fake.widget.created", subject: "fake:widget-1", summary: "Widget created" }))
    const restartSession = vi.fn(async (id: string) => {
      throw new Error(`session "${id}" is an external session (no process the daemon can restart)`)
    })
    const parkedPath = join(h.root, "parked.jsonl")
    const runtime = createSentinelRuntime({
      store,
      registry: reg,
      resolveProvider: async slug => (slug === "fake" ? provider : null),
      isSessionAlive: id => {
        const d = reg.get(id)
        return !!d && (d.status === "running" || d.status === "starting")
      },
      restartSession,
      sessionInfo: id => {
        const d = reg.get(id)
        return d ? { endedReason: d.endedReason, archived: d.archived, retiredAt: d.retiredAt } : undefined
      },
      parkedPath,
      ledgerPath: join(h.root, "delivery-ledger.jsonl"),
      log: () => undefined,
    })

    await runtime.pollOnce()

    const deadline = Date.now() + 2_000
    while (!h.frames.some(f => f.type === "user") && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(h.frames.some(f => f.type === "user")).toBe(true)
    expect(store.get(sentinel.id)?.status).not.toBe("orphaned")
    expect(restartSession).not.toHaveBeenCalled()
    expect(existsSync(parkedPath) ? readFileSync(parkedPath, "utf8").trim() : "").toBe("")
  })
})
