import { chmodSync, mkdtempSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:net"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createSessionMessage } from "../session-message.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"

const a = "00000000-0000-4000-8000-000000000001"
const b = "00000000-0000-4000-8000-000000000002"
const unlisted = "00000000-0000-4000-8000-000000000003"

describe.skipIf(process.platform === "win32")("Codex Desktop wake through the message registry", () => {
  let dir: string
  let server: Server
  let registry: SessionsRegistry
  let requests: Record<string, unknown>[]
  let startResponse: Record<string, unknown> | undefined
  let ownerSupportsAppInput: boolean
  const accepted = { resultType: "success", result: { result: { turn: { id: "turn-1", status: "inProgress" } } } }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ap-cdx-"))
    requests = []
    ownerSupportsAppInput = true
    startResponse = accepted
    server = createServer(socket => {
      let buffer: Buffer = Buffer.alloc(0)
      socket.on("data", chunk => {
        buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk])
        if (buffer.length < 4 || buffer.length < buffer.readUInt32LE() + 4) return
        const size = buffer.readUInt32LE()
        const request = JSON.parse(buffer.subarray(4, size + 4).toString())
        buffer = buffer.subarray(size + 4)
        requests.push(request)
        const response = request.method === "initialize"
          ? { resultType: "success", result: { clientId: "agentproto-client" } }
          : request.method === "thread-owner-discovery"
            ? { resultType: "success", handledByClientId: "desktop-owner", result: { supportsUntrustedAppInput: ownerSupportsAppInput } }
            : startResponse
        if (!response) return
        const body = Buffer.from(JSON.stringify({ type: "response", requestId: request.requestId, ...response }))
        const prefix = Buffer.alloc(4)
        prefix.writeUInt32LE(body.length)
        socket.write(prefix.subarray(0, 2))
        socket.write(Buffer.concat([prefix.subarray(2), body]))
      })
    })
    await new Promise<void>(resolve => { server.listen(join(dir, "ipc.sock"), resolve) })
    chmodSync(join(dir, "ipc.sock"), 0o600)
    registry = createSessionsRegistry({
      persist: false,
      transcriptDir: join(dir, "transcripts"),
      codexDesktopWake: { threadIds: [a, b], ipcDir: dir, timeoutMs: 250, retryMs: 50 },
    })
    registry.touchExternal({ id: `codex:${a}`, host: "codex" })
    registry.touchExternal({ id: `codex:${b}`, host: "codex" })
    registry.touchExternal({ id: `codex:${unlisted}`, host: "codex" })
  })

  afterEach(async () => {
    registry?.shutdown()
    if (server?.listening) await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })
    if (dir) rmSync(dir, { force: true, recursive: true })
  })

  function message(threadId = a, urgency: "next-turn" | "fyi" = "next-turn") {
    return createSessionMessage({
      to: `codex:${threadId}`, from: { relation: "system" }, kind: "notice", urgency, text: "Untrusted PR title",
    })
  }

  it("wakes the allowlisted thread and keeps message text in its MCP inbox", async () => {
    const msg = message()
    await expect(registry.sendMessage(msg)).resolves.toMatchObject({
      delivered: { via: "inbox" }, desktopWake: "accepted",
    })
    expect(requests.map(r => r.method)).toEqual(["initialize", "thread-owner-discovery", "thread-follower-start-turn"])
    expect(requests[2]).toMatchObject({
      version: 2,
      targetClientId: "desktop-owner",
      sourceClientId: "agentproto-client",
      params: {
        conversationId: a,
        hostId: "local",
        turnStart: {
          request: { threadId: a, input: [{ type: "text", text: expect.stringContaining("inbox_list"), text_elements: [] }] },
          context: { inheritThreadSettings: true, responseItems: expect.any(Array) },
        },
      },
    })
    expect(JSON.stringify(requests)).not.toContain(msg.text)
    expect(registry.listInbox(msg.to)).toMatchObject([{ id: msg.id, text: msg.text }])
    await registry.sendMessage(msg)
    expect(requests).toHaveLength(3)
  })

  it("leaves fyi and other chats in the inbox without opening IPC", async () => {
    for (const msg of [message(a, "fyi"), message(unlisted)]) {
      await expect(registry.sendMessage(msg)).resolves.toMatchObject({ delivered: { via: "inbox" } })
      expect(registry.listInbox(msg.to)).toMatchObject([{ id: msg.id }])
    }
    expect(requests).toEqual([])
  })

  it("shares an accepted wake between concurrent messages for the same chat", async () => {
    const messages = [message(), message()]
    const results = await Promise.all(messages.map(msg => registry.sendMessage(msg)))
    expect(results.map(r => r.desktopWake)).toEqual(["accepted", "accepted"])
    expect(registry.listInbox(messages[0]!.to)?.map(msg => msg.id)).toEqual(messages.map(msg => msg.id))
    await new Promise(resolve => setTimeout(resolve, 125))
    expect(requests).toHaveLength(3)
  })

  it("routes wakes to each allowlisted chat by its own identifier", async () => {
    await Promise.all([a, b].map(threadId => registry.sendMessage(message(threadId))))
    expect(requests.filter(r => r.method === "thread-follower-start-turn")).toEqual(
      expect.arrayContaining([a, b].map(threadId => expect.objectContaining({
        params: expect.objectContaining({ conversationId: threadId }),
      }))),
    )
  })

  it("restores the external inbox on restart without replaying an ambiguous wake", async () => {
    registry.shutdown()
    const options = {
      persistPath: join(dir, "sessions.json"),
      transcriptDir: join(dir, "transcripts"),
      codexDesktopWake: { threadIds: [a], ipcDir: dir, timeoutMs: 200 },
    }
    registry = createSessionsRegistry(options)
    const msg = message()
    registry.touchExternal({ id: msg.to, host: "codex" })
    startResponse = undefined
    await expect(registry.sendMessage(msg)).resolves.toMatchObject({ desktopWake: "uncertain" })
    registry.shutdown()
    registry = createSessionsRegistry(options)
    registry.touchExternal({ id: msg.to, host: "codex" })
    expect(registry.listInbox(msg.to)).toMatchObject([{ id: msg.id, text: msg.text }])
    await registry.sendMessage(msg)
    expect(requests).toHaveLength(3)
  })

  it("parks a message when the owner lacks idle-only app input support", async () => {
    ownerSupportsAppInput = false
    const msg = message()
    await expect(registry.sendMessage(msg)).resolves.toMatchObject({ desktopWake: "unavailable" })
    expect(registry.listInbox(msg.to)).toMatchObject([{ id: msg.id }])
    expect(requests.map(r => r.method)).toEqual(["initialize", "thread-owner-discovery"])
  })

  it("parks a message when Desktop rejects overlapping turns", async () => {
    startResponse = { resultType: "error", error: "App context must wait until the current turn finishes" }
    const msg = message()
    await expect(registry.sendMessage(msg)).resolves.toMatchObject({ desktopWake: "busy" })
    expect(registry.listInbox(msg.to)).toMatchObject([{ id: msg.id }])
  })

  it("coalesces busy notifications and wakes after the active turn finishes", async () => {
    startResponse = { resultType: "error", error: "App context must wait until the current turn finishes" }
    const messages = [message(), message()]
    const results = await Promise.all(messages.map(msg => registry.sendMessage(msg)))
    expect(results.map(r => r.desktopWake)).toEqual(["busy", "busy"])
    expect(requests.filter(r => r.method === "thread-follower-start-turn")).toHaveLength(1)
    startResponse = accepted
    await vi.waitFor(() => {
      expect(requests.filter(r => r.method === "thread-follower-start-turn")).toHaveLength(2)
    })
    expect(registry.listInbox(messages[0]!.to)?.map(msg => msg.id)).toEqual(messages.map(msg => msg.id))
    await new Promise(resolve => setTimeout(resolve, 125))
    expect(requests.filter(r => r.method === "thread-follower-start-turn")).toHaveLength(2)
  })

  it("cancels a busy retry when the chat already consumed the message", async () => {
    startResponse = { resultType: "error", error: "App context must wait until the current turn finishes" }
    const msg = message()
    await registry.sendMessage(msg)
    registry.ackInbox(msg.to, [msg.id])
    startResponse = accepted
    await new Promise(resolve => setTimeout(resolve, 125))
    expect(requests.filter(r => r.method === "thread-follower-start-turn")).toHaveLength(1)
  })

  it("retains the message and avoids a second request after an ambiguous timeout", async () => {
    startResponse = undefined
    const messages = [message(), message()]
    const results = await Promise.all(messages.map(msg => registry.sendMessage(msg)))
    expect(results.map(r => r.desktopWake)).toEqual(["uncertain", "uncertain"])
    await registry.sendMessage(messages[0]!)
    expect(registry.listInbox(messages[0]!.to)?.map(msg => msg.id)).toEqual(messages.map(msg => msg.id))
    await new Promise(resolve => setTimeout(resolve, 125))
    expect(requests).toHaveLength(3)
  })

  it("does not connect to a socket accessible by other users", async () => {
    chmodSync(join(dir, "ipc.sock"), 0o666)
    await expect(registry.sendMessage(message())).resolves.toMatchObject({ desktopWake: "unavailable" })
    expect(requests).toEqual([])
  })
})
