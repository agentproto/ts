import { afterEach, describe, expect, it, vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createEventsChannel, type EventsChannel, type EventsDaemon } from "../channel.js"
import { generateSecret, signWebhook } from "../webhook.js"

const HOOK = "/hook/secret-path"
const BASE = "https://example.trycloudflare.com"
const NOW_MS = 1_800_000_000_000
const ARGS = { repo: "o/r", number: 1 }

interface Rig {
  channel: EventsChannel
  client: Client
  daemon: { request: ReturnType<typeof vi.fn> }
  secret: string
  timers: Array<{ fn: () => void; ms: number; cleared: boolean }>
  pushed: Array<Record<string, unknown>>
}

const open: Rig[] = []

async function rig(daemonImpl?: EventsDaemon["request"]): Promise<Rig> {
  const secret = generateSecret()
  const timers: Rig["timers"] = []
  const daemon = {
    request: vi.fn(
      daemonImpl ??
        (async (method: string) =>
          method === "events/subscribe"
            ? { id: "sub_1", refreshBefore: new Date(NOW_MS + 1_800_000).toISOString(), cursor: null }
            : method === "events/list"
              ? { events: [{ name: "github.pull_request.closed" }] }
              : {}),
    ),
  }
  const channel = createEventsChannel({
    daemon: daemon as unknown as EventsDaemon,
    publicBase: async () => BASE,
    hookPath: HOOK,
    secret,
    now: () => NOW_MS,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: handle => {
      ;(handle as { cleared: boolean }).cleared = true
    },
  })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "fake-claude-code", version: "0" })
  const pushed: Array<Record<string, unknown>> = []
  client.fallbackNotificationHandler = async notification => {
    if (notification.method === "notifications/claude/channel") pushed.push(notification.params as Record<string, unknown>)
  }
  await channel.server.connect(serverSide)
  await client.connect(clientSide)
  const r = { channel, client, daemon, secret, timers, pushed }
  open.push(r)
  return r
}

afterEach(async () => {
  for (const r of open.splice(0)) await r.client.close()
})

function delivery(r: Rig, envelope: Record<string, unknown>, subscription = "sub_1") {
  const body = JSON.stringify(envelope)
  const id = String(envelope.eventId ?? "evt")
  const ts = String(Math.floor(Date.now() / 1000))
  return r.channel.handleDelivery({
    headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": signWebhook(r.secret, id, ts, body), "x-mcp-subscription-id": subscription },
    body,
  })
}

const callTool = (r: Rig, name: string, args: Record<string, unknown> = {}) =>
  r.client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }>

describe("events channel", () => {
  it("declares the claude/channel capability, instructions and the three tools", async () => {
    const r = await rig()
    expect(r.client.getServerCapabilities()?.experimental).toHaveProperty("claude/channel")
    expect(r.client.getInstructions()).toContain("<channel source=\"agentproto-events\"")
    expect((await r.client.listTools()).tools.map(t => t.name).sort()).toEqual(["events_list", "events_subscribe", "events_unsubscribe"])
  })

  it("events_list proxies to the daemon", async () => {
    const r = await rig()
    const result = await callTool(r, "events_list")
    expect(JSON.parse(result.content[0]?.text ?? "{}").events[0].name).toBe("github.pull_request.closed")
    expect(r.daemon.request).toHaveBeenCalledWith("events/list", {})
  })

  it("events_subscribe sends the callback url and secret to the daemon", async () => {
    const r = await rig()
    const result = await callTool(r, "events_subscribe", { name: "github.pull_request.closed", arguments: ARGS, ttlMs: 60_000 })
    expect(result.isError).toBeFalsy()
    expect(r.daemon.request).toHaveBeenCalledWith("events/subscribe", {
      name: "github.pull_request.closed",
      arguments: ARGS,
      delivery: { mode: "webhook", url: `${BASE}${HOOK}`, secret: r.secret },
      ttlMs: 60_000,
    })
  })

  it("surfaces a daemon error as a tool error instead of throwing", async () => {
    const r = await rig(async () => {
      throw new Error("callback endpoint rejected the challenge")
    })
    const result = await callTool(r, "events_subscribe", { name: "github.pull_request.closed", arguments: ARGS })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain("challenge")
  })

  it("pushes a verified delivery into the session as a channel notification", async () => {
    const r = await rig()
    const result = await delivery(r, { eventId: "evt_1", name: "github.pull_request.closed", timestamp: "2026-10-08T14:00:00Z", data: { summary: "PR o/r#1 closed", merged: false } }, "sub_7")
    expect(result.status).toBe(200)
    await vi.waitFor(() => expect(r.pushed).toHaveLength(1))
    const [params] = r.pushed
    expect(String(params?.content)).toContain("PR o/r#1 closed")
    expect(String(params?.content)).toContain("evt_1")
    expect(params?.meta).toEqual({ event: "github.pull_request.closed", event_id: "evt_1", subscription_id: "sub_7" })
  })

  it("does not push a redelivered event twice", async () => {
    const r = await rig()
    const envelope = { eventId: "evt_1", name: "github.pull_request.closed", data: {} }
    await delivery(r, envelope)
    await delivery(r, envelope)
    await vi.waitFor(() => expect(r.pushed).toHaveLength(1))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(r.pushed).toHaveLength(1)
  })

  it("schedules a refresh at 80% of the granted lifetime and re-subscribes when it fires", async () => {
    const r = await rig()
    await callTool(r, "events_subscribe", { name: "github.pull_request.closed", arguments: ARGS })
    expect(r.timers).toHaveLength(1)
    expect(r.timers[0]?.ms).toBe(1_800_000 * 0.8)
    r.timers[0]?.fn()
    await vi.waitFor(() => expect(r.daemon.request.mock.calls.filter(([m]) => m === "events/subscribe")).toHaveLength(2))
    expect(r.timers[0]?.cleared).toBe(true)
    expect(r.timers).toHaveLength(2)
  })

  it("events_unsubscribe cancels the refresh timer and tells the daemon", async () => {
    const r = await rig()
    await callTool(r, "events_subscribe", { name: "github.pull_request.closed", arguments: ARGS })
    await callTool(r, "events_unsubscribe", { name: "github.pull_request.closed", arguments: ARGS })
    expect(r.timers[0]?.cleared).toBe(true)
    expect(r.daemon.request).toHaveBeenCalledWith("events/unsubscribe", {
      name: "github.pull_request.closed",
      arguments: ARGS,
      delivery: { mode: "webhook", url: `${BASE}${HOOK}` },
    })
  })

  it("close() unsubscribes everything still active", async () => {
    const r = await rig()
    await callTool(r, "events_subscribe", { name: "github.pull_request.closed", arguments: ARGS })
    await r.channel.close()
    expect(r.daemon.request.mock.calls.filter(([m]) => m === "events/unsubscribe")).toHaveLength(1)
  })
})

describe("events channel: robustness", () => {
  it("rejects invalid tool arguments without calling the daemon", async () => {
    const r = await rig()
    const calls = () => r.daemon.request.mock.calls.length
    const before = calls()
    for (const bad of [{ arguments: ARGS }, { name: "x" }, { name: "x", arguments: ARGS, ttlMs: "soon" }, { name: "x", arguments: ARGS, extra: 1 }]) {
      const result = await callTool(r, "events_subscribe", bad)
      expect(result.isError).toBe(true)
      expect(result.content[0]?.text).toContain("invalid arguments")
    }
    expect(calls()).toBe(before)
  })

  it("retries a failed refresh with backoff, then resumes the normal refresh schedule", async () => {
    let subscribes = 0
    const r = await rig(async method => {
      if (method !== "events/subscribe") return {}
      subscribes += 1
      if (subscribes === 2) throw new Error("tunnel down")
      return { id: "sub_1", refreshBefore: new Date(NOW_MS + 1_800_000).toISOString(), cursor: null }
    })
    await callTool(r, "events_subscribe", { name: "github.pull_request.closed", arguments: ARGS })
    r.timers[0]?.fn() // refresh fires and fails
    await vi.waitFor(() => expect(r.timers).toHaveLength(2))
    expect(r.timers[1]?.ms).toBe(15_000) // first retry
    r.timers[1]?.fn() // retry succeeds
    await vi.waitFor(() => expect(r.timers).toHaveLength(3))
    expect(r.timers[2]?.ms).toBe(1_800_000 * 0.8) // back on the normal schedule
    expect(subscribes).toBe(3)
  })

  it("doubles the retry delay and gives up once the granted lifetime would be exceeded", async () => {
    let subscribes = 0
    const r = await rig(async method => {
      if (method !== "events/subscribe") return {}
      subscribes += 1
      if (subscribes > 1) throw new Error("tunnel down")
      return { id: "sub_1", refreshBefore: new Date(NOW_MS + 100_000).toISOString(), cursor: null }
    })
    await callTool(r, "events_subscribe", { name: "github.pull_request.closed", arguments: ARGS })
    const delays: number[] = []
    for (let i = 0; i < 6; i++) {
      const timer = r.timers[i]
      if (!timer) break
      timer.fn()
      await new Promise(resolve => setTimeout(resolve, 10))
      delays.push(r.timers[i + 1]?.ms ?? -1)
    }
    expect(delays.slice(0, 3)).toEqual([15_000, 30_000, 60_000])
    expect(r.timers).toHaveLength(4) // 120s no longer fits before the 100s deadline: no fifth timer
  })

  it("keeps one entry per name+arguments even when the daemon returns a new id on refresh", async () => {
    let subscribes = 0
    const r = await rig(async method => {
      if (method !== "events/subscribe") return {}
      subscribes += 1
      return { id: `sub_${subscribes}`, refreshBefore: new Date(NOW_MS + 1_800_000).toISOString(), cursor: null }
    })
    await callTool(r, "events_subscribe", { name: "github.pull_request.closed", arguments: { number: 1, repo: "o/r" } })
    r.timers[0]?.fn()
    await vi.waitFor(() => expect(r.timers).toHaveLength(2))
    expect(r.timers[0]?.cleared).toBe(true) // the replaced entry's timer is dead
    // Argument key order does not matter for identity.
    await callTool(r, "events_subscribe", { name: "github.pull_request.closed", arguments: { repo: "o/r", number: 1 } })
    expect(r.timers[1]?.cleared).toBe(true)
    await r.channel.close()
    expect(r.daemon.request.mock.calls.filter(([m]) => m === "events/unsubscribe")).toHaveLength(1)
  })
})
