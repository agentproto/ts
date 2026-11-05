/**
 * `claude-socket` wake adapter: the opt-in path that wakes an idle external
 * Claude Code session over its per-session unix socket.
 *
 * Every case uses a REAL unix socket server under `os.tmpdir()`, a fake
 * registration directory and a fake key file. `net` is never mocked.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "node:net"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  findClaudeSessionRegistration,
  wakeClaudeSocket,
  type ClaudeSocketWakeConfig,
} from "../claude-socket-wake.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"
import { createSessionMessage } from "../session-message.js"

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

interface Harness {
  root: string
  claudeSessionsDir: string
  socketDir: string
  pid: number
  socketPath: string
  frames: Array<Record<string, unknown>>
  connections: number
  server: Server
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for the socket frames")
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function startHarness(opts: { permissionMode?: string } = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "claude-socket-wake-"))
  const claudeSessionsDir = join(root, "claude-sessions")
  const socketDir = join(root, "socks")
  mkdirSync(claudeSessionsDir, { recursive: true })
  mkdirSync(socketDir, { recursive: true })
  const pid = 20_000 + Math.floor(process.pid % 10_000)
  const socketPath = join(socketDir, `${pid}.sock`)

  writeFileSync(
    join(claudeSessionsDir, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: "chat-1",
      permissionMode: opts.permissionMode ?? "auto",
      status: "idle",
    }),
  )
  writeFileSync(join(claudeSessionsDir, `${pid}.deadbeef.key`), "super-secret-key\n")

  const frames: Array<Record<string, unknown>> = []
  let connections = 0
  const server = createServer(socket => {
    connections += 1
    let buffered = ""
    socket.on("data", chunk => {
      buffered += chunk.toString("utf8")
      let newline = buffered.indexOf("\n")
      while (newline !== -1) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        if (line.length > 0) frames.push(JSON.parse(line) as Record<string, unknown>)
        newline = buffered.indexOf("\n")
      }
    })
    socket.on("error", () => undefined)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, resolve)
  })

  return { root, claudeSessionsDir, socketDir, pid, socketPath, frames, connections, server }
}

async function stopHarness(h: Harness): Promise<void> {
  await new Promise<void>(resolve => h.server.close(() => resolve()))
  rmSync(h.root, { recursive: true, force: true })
}

function config(h: Harness, overrides: Partial<ClaudeSocketWakeConfig> = {}): ClaudeSocketWakeConfig {
  return {
    enabled: true,
    claudeSessionsDir: h.claudeSessionsDir,
    socketDir: h.socketDir,
    ...overrides,
  }
}

describe("claude-socket wake adapter", () => {
  let h: Harness

  afterEach(async () => {
    await stopHarness(h)
  })

  describe("with an auto-permission registration", () => {
    beforeEach(async () => {
      h = await startHarness()
    })

    it("writes exactly one auth frame then one user frame for a level-2 envelope", async () => {
      const result = await wakeClaudeSocket({
        sessionId: "cc:chat-1",
        text: "please wake up",
        urgency: "next-turn",
        config: config(h),
      })

      expect(result).toMatchObject({ written: true, reason: "written", sessionId: "cc:chat-1", pid: h.pid })
      expect(JSON.stringify(result)).not.toContain("super-secret-key")

      await waitFor(() => h.frames.length >= 2)
      expect(h.frames).toHaveLength(2)
      expect(h.frames[0]).toEqual({ type: "auth", token: "super-secret-key" })
      expect(h.frames[1]).toMatchObject({
        type: "user",
        priority: "next",
        message: { role: "user", content: "please wake up" },
      })
      expect(h.frames[1]!.msg_id).toMatch(UUID_V4)
      expect(h.frames[1]!.uuid).toMatch(UUID_V4)
    })

    it("writes nothing for a level-1 (fyi) envelope", async () => {
      const result = await wakeClaudeSocket({
        sessionId: "cc:chat-1",
        text: "for your information",
        urgency: "fyi",
        config: config(h),
      })
      expect(result).toMatchObject({ written: false, reason: "urgency" })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(h.frames).toHaveLength(0)
      expect(h.connections).toBe(0)
    })

    it("writes nothing when the flag is off", async () => {
      const result = await wakeClaudeSocket({
        sessionId: "cc:chat-1",
        text: "wake",
        urgency: "steer",
        config: config(h, { enabled: false }),
      })
      expect(result).toMatchObject({ written: false, reason: "disabled" })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(h.frames).toHaveLength(0)
      expect(h.connections).toBe(0)
    })

    it("refuses a socket path that is not a socket owned by this user", async () => {
      await new Promise<void>(resolve => h.server.close(() => resolve()))
      writeFileSync(h.socketPath, "not a socket")
      const result = await wakeClaudeSocket({
        sessionId: "cc:chat-1",
        text: "wake",
        urgency: "next-turn",
        config: config(h),
      })
      expect(result).toMatchObject({ written: false, reason: "unsafe-socket", pid: h.pid })
      expect(h.frames).toHaveLength(0)
    })

    it("falls back when the socket is missing", async () => {
      await new Promise<void>(resolve => h.server.close(() => resolve()))
      const result = await wakeClaudeSocket({
        sessionId: "cc:chat-1",
        text: "wake",
        urgency: "next-turn",
        config: config(h),
      })
      expect(result).toMatchObject({ written: false, reason: "no-socket", pid: h.pid })
      expect(h.frames).toHaveLength(0)
    })
  })

  describe("with a bypassPermissions registration", () => {
    beforeEach(async () => {
      h = await startHarness({ permissionMode: "bypassPermissions" })
    })

    it("does not write the socket and reports the inbox fallback", async () => {
      const result = await wakeClaudeSocket({
        sessionId: "cc:chat-1",
        text: "wake",
        urgency: "next-turn",
        config: config(h),
      })
      expect(result).toMatchObject({ written: false, reason: "bypass-permissions", pid: h.pid })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(h.frames).toHaveLength(0)
      expect(h.connections).toBe(0)
    })
  })
})

describe("claude-socket wake through the sessions registry", () => {
  let h: Harness
  let registry: SessionsRegistry
  let transcriptDir: string

  beforeEach(async () => {
    h = await startHarness()
    transcriptDir = join(h.root, "transcripts")
    mkdirSync(transcriptDir, { recursive: true })
    registry = createSessionsRegistry({
      persist: false,
      transcriptDir,
      claudeSocketWake: config(h),
    })
    registry.touchExternal({ id: "cc:chat-1", host: "claude-desktop" })
  })

  afterEach(async () => {
    registry.shutdown()
    await stopHarness(h)
  })

  it("wakes an idle level-2 message and consumes it instead of parking it", async () => {
    const res = await registry.sendMessage(
      createSessionMessage({
        to: "cc:chat-1",
        from: { relation: "system" },
        kind: "notice",
        urgency: "next-turn",
        text: "ping",
      }),
    )
    expect(res.delivered).toEqual({ via: "socket" })
    expect(res.wake).toMatchObject({ written: true, reason: "written", pid: h.pid })
    // No inbox copy: a later Stop/UserPromptSubmit hook must not re-inject it.
    expect(registry.listInbox("cc:chat-1")).toEqual([])

    await waitFor(() => h.frames.length >= 2)
    expect(h.frames[0]).toEqual({ type: "auth", token: "super-secret-key" })
    expect(h.frames[1]).toMatchObject({ type: "user", priority: "next", message: { content: "ping" } })
  })

  it("does not wake a fyi message", async () => {
    const res = await registry.sendMessage(
      createSessionMessage({
        to: "cc:chat-1",
        from: { relation: "system" },
        kind: "notice",
        urgency: "fyi",
        text: "quiet",
      }),
    )
    expect(res.wake).toMatchObject({ written: false, reason: "urgency" })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(h.frames).toHaveLength(0)
  })

  it("records the fallback for a bypassPermissions target and still delivers to the inbox", async () => {
    writeFileSync(
      join(h.claudeSessionsDir, `${h.pid}.json`),
      JSON.stringify({ pid: h.pid, sessionId: "chat-1", permissionMode: "bypassPermissions", status: "idle" }),
    )
    const res = await registry.sendMessage(
      createSessionMessage({
        to: "cc:chat-1",
        from: { relation: "system" },
        kind: "notice",
        urgency: "next-turn",
        text: "fallback",
      }),
    )
    expect(res.wake).toMatchObject({ written: false, reason: "bypass-permissions" })
    expect(registry.listInbox("cc:chat-1")!.map(m => m.text)).toEqual(["fallback"])
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(h.frames).toHaveLength(0)
  })

  it("does not wake when the daemon flag is off", async () => {
    registry.shutdown()
    registry = createSessionsRegistry({ persist: false, transcriptDir })
    registry.touchExternal({ id: "cc:chat-1", host: "claude-desktop" })
    const res = await registry.sendMessage(
      createSessionMessage({
        to: "cc:chat-1",
        from: { relation: "system" },
        kind: "notice",
        urgency: "steer",
        text: "off",
      }),
    )
    expect(res.wake).toBeUndefined()
    expect(res.delivered).toEqual({ via: "inbox" })
    expect(registry.listInbox("cc:chat-1")!.map(m => m.text)).toEqual(["off"])
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(h.frames).toHaveLength(0)
  })
})

describe("claude session registration lookup", () => {
  let h: Harness
  beforeEach(async () => {
    h = await startHarness()
  })
  afterEach(async () => {
    await stopHarness(h)
  })

  it("finds the registration by sessionId and never returns the key", async () => {
    const found = await findClaudeSessionRegistration("chat-1", h.claudeSessionsDir)
    expect(found).toMatchObject({ pid: h.pid, sessionId: "chat-1", permissionMode: "auto" })
    expect(JSON.stringify(found)).not.toContain("super-secret-key")
  })
})
