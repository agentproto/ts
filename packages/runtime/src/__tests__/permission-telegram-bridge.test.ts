/**
 * Telegram bridge for the pending-permissions inbox: each parked permission on
 * a configured tool (default `send_message`) becomes a Telegram message with
 * tap buttons; a tap routes `allow_once` / `reject_once` back to the pending
 * permission. Everything outside the configured tools, chat and users is
 * ignored, and an unconfigured bridge does not exist.
 *
 * The last block drives the whole chain with the real registry: gated
 * `send_message` -> pending permission -> Telegram message -> tap -> upstream.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"
import { createSessionEventBus, type SessionEventBus } from "../session-event-bus.js"
import { McpProxyRegistry } from "../mcp-proxy.js"
import { createImportedCallGuard } from "../imported-call-gate.js"
import { createPermissionTelegramBridge } from "../permission-telegram-bridge.js"

const CHAT = "4242"
const JEREMY = "1001"

interface TgCall {
  method: string
  body: Record<string, unknown>
}

function fakeTelegram(): { fetchImpl: typeof fetch; calls: TgCall[] } {
  const calls: TgCall[] = []
  let nextMessageId = 500
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split("/").pop()!
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    calls.push({ method, body })
    return new Response(JSON.stringify({ ok: true, result: { message_id: nextMessageId++ } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
  return { fetchImpl, calls }
}

const creds = { read: async () => ({ token: "TOKEN" }), write: async () => {}, exists: async () => true }

function tap(data: string, opts: { userId?: string; chatId?: string; messageId?: number } = {}) {
  return {
    update_id: 9,
    callback_query: {
      id: "cb-1",
      from: { id: Number(opts.userId ?? JEREMY) },
      message: { message_id: opts.messageId ?? 500, chat: { id: Number(opts.chatId ?? CHAT) } },
      data,
    },
  }
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error("condition never became true")
}

describe("createPermissionTelegramBridge", () => {
  let tmp: string
  let bus: SessionEventBus
  let registry: SessionsRegistry
  let tg: ReturnType<typeof fakeTelegram>

  const makeBridge = (over: Partial<Parameters<typeof createPermissionTelegramBridge>[0]> = {}) =>
    createPermissionTelegramBridge({
      events: bus,
      registry,
      telegramCreds: creds,
      alias: "default",
      chatId: CHAT,
      allowedUserIds: [JEREMY],
      fetchImpl: tg.fetchImpl,
      ...over,
    })

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "perm-tg-"))
    bus = createSessionEventBus()
    registry = createSessionsRegistry({ persist: false, transcriptDir: join(tmp, "s"), sessionEvents: bus })
    tg = fakeTelegram()
  })
  afterEach(() => {
    registry.shutdown()
    rmSync(tmp, { recursive: true, force: true })
  })

  it("sends a plain-text message with Allow/Reject buttons for a parked send_message", async () => {
    const bridge = makeBridge()
    bridge.start()
    void registry.requestToolPermission({
      toolName: "send_message",
      text: 'Allow "send_message" on agentpush?',
      rawInput: { alias: "agentpush", toolName: "send_message", args: { to: "marie", text: "Bonjour Marie" } },
    })
    await until(() => tg.calls.length > 0)

    const send = tg.calls[0]!
    expect(send.method).toBe("sendMessage")
    expect(send.body.chat_id).toBe(CHAT)
    expect(send.body.parse_mode).toBeUndefined()
    expect(String(send.body.text)).toContain("send_message")
    expect(String(send.body.text)).toContain("Bonjour Marie")
    const keyboard = (send.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> })
      .inline_keyboard.flat()
    expect(keyboard).toHaveLength(2)
    for (const b of keyboard) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64)
    bridge.stop()
  })

  it("does not message for tools outside the configured list", async () => {
    const bridge = makeBridge()
    bridge.start()
    void registry.requestToolPermission({ toolName: "upload_media", text: "?" })
    await new Promise(r => setTimeout(r, 40))
    expect(tg.calls).toHaveLength(0)
    bridge.stop()
  })

  it("routes an Allow tap from the allowed user to approve, then closes the buttons", async () => {
    const bridge = makeBridge()
    bridge.start()
    const outcome = registry.requestToolPermission({ toolName: "send_message", text: "?" })
    await until(() => tg.calls.length > 0)
    const allow = (tg.calls[0]!.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> })
      .inline_keyboard.flat()[0]!

    const res = await bridge.handleUpdate(tap(allow.callback_data))
    expect(res).toEqual({ handled: true })
    await expect(outcome).resolves.toMatchObject({ decision: "approve", optionId: "allow_once" })
    expect(tg.calls.map(c => c.method)).toContain("answerCallbackQuery")
    const edit = tg.calls.find(c => c.method === "editMessageText")
    expect(edit?.body.message_id).toBe(500)
    expect(edit?.body.reply_markup).toEqual({ inline_keyboard: [] })
    bridge.stop()
  })

  it("routes a Reject tap to deny", async () => {
    const bridge = makeBridge()
    bridge.start()
    const outcome = registry.requestToolPermission({ toolName: "send_message", text: "?" })
    await until(() => tg.calls.length > 0)
    const reject = (tg.calls[0]!.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> })
      .inline_keyboard.flat()[1]!
    await bridge.handleUpdate(tap(reject.callback_data))
    await expect(outcome).resolves.toMatchObject({ decision: "deny", optionId: "reject_once" })
    bridge.stop()
  })

  it("refuses a tap from a user outside allowedUserIds and leaves the permission pending", async () => {
    const bridge = makeBridge()
    bridge.start()
    void registry.requestToolPermission({ toolName: "send_message", text: "?" })
    await until(() => tg.calls.length > 0)
    const allow = (tg.calls[0]!.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> })
      .inline_keyboard.flat()[0]!

    const res = await bridge.handleUpdate(tap(allow.callback_data, { userId: "666" }))
    expect(res).toEqual({ handled: true })
    expect(registry.listPendingPermissions()).toHaveLength(1)
    bridge.stop()
  })

  it("refuses a tap that comes from another chat", async () => {
    const bridge = makeBridge()
    bridge.start()
    void registry.requestToolPermission({ toolName: "send_message", text: "?" })
    await until(() => tg.calls.length > 0)
    const allow = (tg.calls[0]!.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> })
      .inline_keyboard.flat()[0]!
    await bridge.handleUpdate(tap(allow.callback_data, { chatId: "999" }))
    expect(registry.listPendingPermissions()).toHaveLength(1)
    bridge.stop()
  })

  it("survives a double tap and an unknown token without throwing", async () => {
    const bridge = makeBridge()
    bridge.start()
    const outcome = registry.requestToolPermission({ toolName: "send_message", text: "?" })
    await until(() => tg.calls.length > 0)
    const allow = (tg.calls[0]!.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> })
      .inline_keyboard.flat()[0]!
    await bridge.handleUpdate(tap(allow.callback_data))
    await outcome
    await expect(bridge.handleUpdate(tap(allow.callback_data))).resolves.toEqual({ handled: true })
    await expect(bridge.handleUpdate(tap("perm:deadbeef:a"))).resolves.toEqual({ handled: true })
    bridge.stop()
  })

  it("leaves non-permission updates alone", async () => {
    const bridge = makeBridge()
    expect(await bridge.handleUpdate({ message: { text: "hello", chat: { id: 1 } } })).toEqual({ handled: false })
    expect(await bridge.handleUpdate(tap("something-else"))).toEqual({ handled: false })
  })

  it("strips the buttons when the permission is resolved elsewhere (CLI / permissions_respond)", async () => {
    const bridge = makeBridge()
    bridge.start()
    void registry.requestToolPermission({ toolName: "send_message", text: "?" })
    await until(() => tg.calls.length > 0)
    const [pending] = registry.listPendingPermissions()
    await registry.respondPermission(pending!.id, { decision: "deny" })
    await until(() => tg.calls.some(c => c.method === "editMessageText"))
    expect(tg.calls.find(c => c.method === "editMessageText")?.body.reply_markup).toEqual({ inline_keyboard: [] })
    bridge.stop()
  })

  it("does not throw and keeps the permission pending when Telegram is unreachable", async () => {
    const bridge = makeBridge({ fetchImpl: (async () => { throw new Error("network down") }) as typeof fetch })
    bridge.start()
    const outcome = registry.requestToolPermission({ toolName: "send_message", text: "?", timeoutMs: 60 })
    await expect(outcome).resolves.toMatchObject({ decision: "cancelled", reason: "timeout" })
    bridge.stop()
  })

  it("refuses to exist without an allowlist of user ids", () => {
    expect(() => makeBridge({ allowedUserIds: [] })).toThrow(/allowedUserIds/)
  })
})

describe("send_message -> Telegram tap -> upstream (end to end)", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "perm-e2e-"))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  async function setup() {
    const workspace = join(tmp, "ws")
    mkdirSync(join(workspace, ".agentproto"), { recursive: true })
    writeFileSync(
      join(workspace, ".agentproto", "hooks.json"),
      JSON.stringify({ version: 1, rules: [{ id: "hold-send", plane: "semantic", match: { tool: "send_message" }, action: "hold" }] }),
    )
    const bus = createSessionEventBus()
    const registry = createSessionsRegistry({ persist: false, transcriptDir: join(tmp, "s"), sessionEvents: bus })
    const upstream = vi.fn(async () => ({ content: [{ type: "text", text: "sent" }] }))
    const proxy = new McpProxyRegistry()
    vi.spyOn(proxy as never, "connectIfNeeded" as never).mockImplementation((async () => ({
      entry: {},
      client: { callTool: upstream },
      tools: [],
      lastError: null,
    })) as never)
    proxy.setCallGuard(createImportedCallGuard({ registry, workspace, timeoutMs: 5_000 }))
    const tg = fakeTelegram()
    const bridge = createPermissionTelegramBridge({
      events: bus,
      registry,
      telegramCreds: creds,
      alias: "default",
      chatId: CHAT,
      allowedUserIds: [JEREMY],
      fetchImpl: tg.fetchImpl,
    })
    bridge.start()
    return { registry, proxy, upstream, tg, bridge }
  }

  it("sends only after the Allow tap", async () => {
    const { registry, proxy, upstream, tg, bridge } = await setup()
    const call = proxy.callTool("agentpush", "send_message", { to: "marie", text: "Bonjour" })
    await until(() => tg.calls.length > 0)
    expect(upstream).not.toHaveBeenCalled()

    const buttons = (tg.calls[0]!.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard.flat()
    await bridge.handleUpdate(tap(buttons[0]!.callback_data))
    await expect(call).resolves.toMatchObject({ ok: true })
    expect(upstream).toHaveBeenCalledTimes(1)
    expect(upstream).toHaveBeenCalledWith({ name: "send_message", arguments: { to: "marie", text: "Bonjour" } })
    bridge.stop()
    registry.shutdown()
  })

  it("never sends after the Reject tap", async () => {
    const { registry, proxy, upstream, tg, bridge } = await setup()
    const call = proxy.callTool("agentpush", "send_message", { to: "marie", text: "Bonjour" })
    await until(() => tg.calls.length > 0)
    const buttons = (tg.calls[0]!.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard.flat()
    await bridge.handleUpdate(tap(buttons[1]!.callback_data))
    const out = await call
    expect(out.ok).toBe(false)
    expect(upstream).not.toHaveBeenCalled()
    bridge.stop()
    registry.shutdown()
  })
})
