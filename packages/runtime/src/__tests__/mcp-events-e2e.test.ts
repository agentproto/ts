/**
 * W-E end-to-end probe (plan §4 W-E) — the MCP Events user story over the
 * REAL in-process path: `createMcpServer` + `registerEventsMethods` (the same
 * construction `runtime/index.ts`'s `mcpServerFactory` performs for the
 * events surface) + the real adapter + real `verifyCallback`/`signWebhook`/
 * `deliverEventEnvelope`/`ssrfFetch` + real `SentinelStore` + real
 * `SentinelRuntime` outbox. The ONLY mocked boundary is the wire itself:
 * `setEgressDispatcherForTests` routes the outbound POST to an in-test fake
 * ChatGPT HTTP server (the same seam every `webhook-egress/*` suite uses).
 *
 * The fake ChatGPT is a real `node:http` server on 127.0.0.1 that
 *   (a) records challenges and answers 2xx `{"challenge":"<same>"}` — but
 *       only when the Standard Webhooks signature verifies (a wrong secret
 *       gets a 2xx with NO echo → `challenge_failed`);
 *   (b) records deliveries and verifies the Standard Webhooks signature
 *       ITSELF (`webhook-id|timestamp|body` HMAC-SHA256, standard base64,
 *       key = base64 payload after `whsec_`) before answering 2xx.
 *
 * Covered: full story (subscribe → signed delivery → 2xx → unsubscribe →
 * delivery stops), wrong secret, non-2xx challenge, private callback URL
 * (ssrf_blocked), 410 subscriber (terminal, no retry), restart persistence
 * (re-`attach()` over the same store files → delivery resumes, signed with
 * the persisted secret), TTL expiry (no delivery after `until.at`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createHmac, timingSafeEqual } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { z } from "zod"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createMcpServer, registerEventsMethods } from "@agentproto/mcp-server"

import {
  DEFAULT_TTL_MS,
  eventsList,
  eventsSubscribe,
  eventsUnsubscribe,
  type EventsListRequest,
  type EventsSubscribeInput,
  type EventsUnsubscribeInput,
} from "../mcp-events/adapter.js"
import { daemonBearerPrincipal } from "../mcp-events/events-registry.js"
import { createSentinelStore, type SentinelStore } from "../sentinel-store.js"
import { createSentinelRuntime, type SentinelRuntime, type SentinelRuntimeRegistry } from "../sentinel-runtime.js"
import { createFakeSentinelProvider, makeFakeEvent, type FakeSentinelProvider } from "../sentinel-providers/fake.js"
import { resetChallengeCacheForTests } from "../webhook-egress/challenge.js"
import { setEgressDispatcherForTests } from "../webhook-egress/ssrf-fetch.js"
import type { SentinelEvent, SentinelProviderHandle } from "../sentinel-providers/types.js"
import type { SessionMessage } from "../session-message.js"

vi.setConfig({ testTimeout: 30_000 })

const SECRET = "whsec_" + Buffer.from(new Uint8Array(32).fill(7)).toString("base64")
const SECRET_WRONG = "whsec_" + Buffer.from(new Uint8Array(32).fill(9)).toString("base64")
const CALLBACK_URL = "https://chatgpt.example.com/mcp-events/cb"

const SUB_PARAMS = {
  name: "github.pull_request.closed",
  arguments: { repo: "agentproto/ts", number: 1428 },
  delivery: { mode: "webhook" as const, url: CALLBACK_URL, secret: SECRET },
}

const PR_CLOSED = makeFakeEvent({
  id: "evt_pr_1428_closed",
  type: "github.pull_request.closed",
  subject: "github:agentproto/ts#1428",
  subjects: ["github:agentproto/ts#1428"],
  summary: "PR #1428 closed (merged)",
  data: { action: "closed", merged: true, repo: "agentproto/ts", number: 1428 },
  time: "2026-10-02T10:00:00.000Z",
})

// A second closed event (same subscription type, different id) — used by
// the restart test to prove post-restart delivery.
const PR_CLOSED_AGAIN = makeFakeEvent({
  id: "evt_pr_1428_closed_2",
  type: "github.pull_request.closed",
  subject: "github:agentproto/ts#1428",
  subjects: ["github:agentproto/ts#1428"],
  summary: "PR #1428 closed again",
  data: { action: "closed", merged: false, repo: "agentproto/ts", number: 1428 },
  time: "2026-10-02T11:00:00.000Z",
})

// ── Standard Webhooks verification (reimplemented in-test, per plan W-E) ──

function verifyStandardWebhookSignature(
  headers: Record<string, string>,
  body: string,
  secrets: readonly string[],
): boolean {
  const id = headers["webhook-id"]
  const ts = headers["webhook-timestamp"]
  const sigHeader = headers["webhook-signature"]
  if (!id || !ts || !sigHeader) return false
  const payload = `${id}.${ts}.${body}`
  for (const secret of secrets) {
    let key: Buffer
    try {
      key = Buffer.from(secret.slice("whsec_".length), "base64")
    } catch {
      continue
    }
    const expected = createHmac("sha256", key).update(payload).digest("base64")
    for (const segment of sigHeader.split(" ")) {
      const comma = segment.indexOf(",")
      if (comma < 0) continue
      const version = segment.slice(0, comma)
      const signature = segment.slice(comma + 1)
      if (version !== "v1" || !signature) continue
      const given = Buffer.from(signature)
      const want = Buffer.from(expected)
      if (given.length === want.length && timingSafeEqual(given, want)) return true
    }
  }
  return false
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// ── The fake ChatGPT ─────────────────────────────────────────────────────

interface RecordedChallenge {
  headers: Record<string, string>
  body: string
  signatureOk: boolean
}

interface RecordedDelivery {
  headers: Record<string, string>
  body: string
  signatureOk: boolean
}

class FakeChatGPT {
  private readonly server: HttpServer
  private baseUrlValue = ""
  private secrets: readonly string[]
  private challengeStatus = 200
  private deliveryStatus = 200
  readonly challenges: RecordedChallenge[] = []
  readonly deliveries: RecordedDelivery[] = []

  constructor(secrets: readonly string[]) {
    this.secrets = secrets
    this.server = createServer((req, res) => {
      void this.handle(req, res)
    })
  }

  get baseUrl(): string {
    return this.baseUrlValue
  }

  /** Test hook: status the challenge endpoint answers with. */
  setChallengeStatus(status: number): void {
    this.challengeStatus = status
  }

  /** Test hook: status the delivery endpoint answers with. */
  setDeliveryStatus(status: number): void {
    this.deliveryStatus = status
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server.address() as AddressInfo
        this.baseUrlValue = `http://127.0.0.1:${address.port}`
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve())
      this.server.closeAllConnections()
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req)
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers[key] = value
      else if (Array.isArray(value)) headers[key] = value.join(",")
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      parsed = undefined
    }

    if (isRecord(parsed) && parsed.type === "verification") {
      const signatureOk = verifyStandardWebhookSignature(headers, body, this.secrets)
      this.challenges.push({ headers, body, signatureOk })
      if (this.challengeStatus < 200 || this.challengeStatus > 299) {
        res.writeHead(this.challengeStatus, { "content-type": "application/json" })
        res.end("{}")
        return
      }
      if (!signatureOk) {
        // A real ChatGPT refuses to echo a challenge it cannot verify:
        // 2xx, no echo → the challenger reports `challenge_failed`.
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "invalid webhook signature" }))
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ challenge: parsed.challenge }))
      return
    }

    const signatureOk = verifyStandardWebhookSignature(headers, body, this.secrets)
    this.deliveries.push({ headers, body, signatureOk })
    if (!signatureOk) {
      res.writeHead(401, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "invalid webhook signature" }))
      return
    }
    if (this.deliveryStatus < 200 || this.deliveryStatus > 299) {
      res.writeHead(this.deliveryStatus, { "content-type": "application/json" })
      res.end("{}")
      return
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end("{}")
  }
}

// ── Harness ──────────────────────────────────────────────────────────────

function stubRegistry(): SentinelRuntimeRegistry {
  return {
    async sendMessage(_msg: SessionMessage) {
      return {
        messageId: "msg_test",
        delivered: { via: "turn" },
        queued: false,
        urgencyApplied: "next-turn",
      } as never
    },
  }
}

function callClient(client: Client, method: string, params?: Record<string, unknown>) {
  return client.request({ method, ...(params ? { params } : {}) } as never, z.looseObject({}))
}

interface HarnessOptions {
  persist?: boolean
  now?: () => number
  secrets?: readonly string[]
}

interface Harness {
  store: SentinelStore
  runtime: SentinelRuntime
  provider: FakeSentinelProvider
  client: Client
  fake: FakeChatGPT
  tmp: string
  now: () => number
  fire: (event: SentinelEvent) => Promise<void>
  dispose: () => Promise<void>
}

async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), "mcp-events-e2e-"))
  const now = opts.now ?? (() => Date.now())
  const secrets = opts.secrets ?? [SECRET]
  const store = createSentinelStore({
    ...(opts.persist ? { filePath: join(tmp, "sentinels.json") } : { persist: false }),
    nowMs: now,
  })
  const provider = createFakeSentinelProvider({ slug: "local-gh" })
  const resolveProvider = async (slug: string): Promise<SentinelProviderHandle | null> =>
    slug === "local-gh" ? provider : null
  const runtime = createSentinelRuntime({
    store,
    registry: stubRegistry(),
    resolveProvider,
    isSessionAlive: () => true,
    restartSession: async (id) => id,
    ...(opts.persist ? { outboxPath: join(tmp, "outbox.json") } : {}),
    nowMs: now,
  })

  const { server } = await createMcpServer({ specs: [] })
  const principal = daemonBearerPrincipal()
  registerEventsMethods(server, {
    list: (params) => eventsList(params as EventsListRequest, { principal }),
    subscribe: (params) =>
      eventsSubscribe(params as unknown as EventsSubscribeInput, { principal, store, resolveProvider, nowMs: now }),
    unsubscribe: (params) =>
      eventsUnsubscribe(params as unknown as EventsUnsubscribeInput, { principal, store, resolveProvider }),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "mcp-events-e2e", version: "0.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  const fake = new FakeChatGPT(secrets)
  await fake.start()
  setEgressDispatcherForTests(async (req) => {
    const target = new URL(req.url)
    const response = await fetch(`${fake.baseUrl}${target.pathname}${target.search}`, {
      method: "POST",
      headers: req.headers,
      body: req.body ? new Uint8Array(req.body) : undefined,
    })
    return { status: response.status, body: await response.text() }
  })

  const fire = async (event: SentinelEvent): Promise<void> => {
    provider.emit(event)
    await runtime.pollOnce()
    await runtime.webhookOutbox.dispatch()
  }

  const dispose = async (): Promise<void> => {
    setEgressDispatcherForTests(null)
    resetChallengeCacheForTests()
    await client.close()
    runtime.stop()
    await fake.stop()
    rmSync(tmp, { recursive: true, force: true })
  }

  return { store, runtime, provider, client, fake, tmp, now, fire, dispose }
}

let h: Harness | undefined

beforeEach(async () => {
  h = await makeHarness()
})

afterEach(async () => {
  if (h) {
    await h.dispose()
    h = undefined
  }
})

// ── The suite ────────────────────────────────────────────────────────────

describe("mcp-events e2e — full user story", () => {
  it("subscribe (challenge passes) → signed delivery → 2xx → unsubscribe → delivery stops", async () => {
    // Frozen clock (the harness's `nowMs` seam): refreshBefore is then exact.
    // A wall clock made the granted delta drift on loaded CI runners.
    await h!.dispose()
    h = undefined
    const t0 = 1_700_000_000_000
    h = await makeHarness({ now: () => t0 })
    const sub = (await callClient(h.client, "events/subscribe", SUB_PARAMS)) as {
      id: string
      refreshBefore: string
      cursor: string | null
    }
    expect(sub.id).toMatch(/^sub_[0-9a-f]{32}$/)
    expect(sub.cursor).toBeNull()
    // refreshBefore is the granted expiration (until.ms as ISO-8601).
    expect(sub.refreshBefore).toBe(new Date(t0 + DEFAULT_TTL_MS).toISOString())

    // The fake ChatGPT saw exactly one challenge, signed with SECRET, echoed.
    expect(h!.fake.challenges).toHaveLength(1)
    const challenge = h!.fake.challenges[0]!
    expect(challenge.signatureOk).toBe(true)
    const challengeBody = JSON.parse(challenge.body) as { type: string; challenge: string }
    expect(challengeBody.type).toBe("verification")
    expect(challengeBody.challenge).toMatch(/^[0-9a-f]{64}$/)
    // Node's http server lowercases inbound header names.
    expect(challenge.headers["x-mcp-subscription-id"]).toBe(sub.id)
    expect(challenge.headers["webhook-id"]).toMatch(/^msg_verification_/)

    // The subscription row exists with a webhook target.
    const sentinel = h!.store.get(sub.id)
    expect(sentinel?.spec.target.kind).toBe("webhook")

    // A matching event lands → signed POST at the fake → 2xx.
    await h!.fire(PR_CLOSED)
    expect(h!.fake.deliveries).toHaveLength(1)
    const delivery = h!.fake.deliveries[0]!
    expect(delivery.signatureOk).toBe(true)
    expect(delivery.headers["webhook-id"]).toBe("evt_pr_1428_closed")
    // The subscription id the client received rides on every event delivery.
    expect(delivery.headers["x-mcp-subscription-id"]).toBe(sub.id)
    const envelope = JSON.parse(delivery.body) as Record<string, unknown>
    expect(envelope).toMatchObject({
      eventId: "evt_pr_1428_closed",
      name: "github.pull_request.closed",
      cursor: null,
    })
    expect(envelope.data).toMatchObject({
      action: "closed",
      merged: true,
      subject: "github:agentproto/ts#1428",
    })
    // The outbox row reached delivered; the event was acked only after terminal.
    const rows = h!.runtime.webhookOutbox.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe("delivered")
    expect(h!.store.isSeen(sub.id, "evt_pr_1428_closed")).toBe(true)

    // Unsubscribe → idempotent {} → provider watch cancelled.
    expect(
      await callClient(h!.client, "events/unsubscribe", {
        name: SUB_PARAMS.name,
        arguments: SUB_PARAMS.arguments,
        delivery: { mode: "webhook", url: SUB_PARAMS.delivery.url },
      }),
    ).toEqual({})
    expect(h!.store.get(sub.id)).toBeUndefined()
    expect(h!.provider.canceled.has("github:agentproto/ts#1428")).toBe(true)

    // A later event produces no further delivery.
    await h!.fire(PR_CLOSED_AGAIN)
    expect(h!.fake.deliveries).toHaveLength(1)
  })

  it("events/list over the real transport", async () => {
    const list = (await callClient(h!.client, "events/list")) as {
      events: Array<{ name: string }>
      nextCursor: string | null
    }
    expect(list.events.map((e) => e.name)).toEqual([
      "github.pull_request.closed",
      "github.pull_request.synchronize",
      "github.pull_request_review.submitted",
      "github.check_suite.completed",
    ])
    expect(list.nextCursor).toBeNull()
  })
})

describe("mcp-events e2e — failure paths", () => {
  it("wrong secret: challenge not echoed → -32015 challenge_failed, no store row", async () => {
    await expect(
      callClient(h!.client, "events/subscribe", {
        ...SUB_PARAMS,
        delivery: { mode: "webhook", url: CALLBACK_URL, secret: SECRET_WRONG },
      }),
    ).rejects.toMatchObject({ code: -32015, data: { reason: "challenge_failed" } })
    expect(h!.fake.challenges).toHaveLength(1)
    expect(h!.fake.challenges[0]!.signatureOk).toBe(false)
    expect(h!.store.list()).toHaveLength(0)
  })

  it("non-2xx challenge: -32015 non_2xx, no store row", async () => {
    h!.fake.setChallengeStatus(500)
    await expect(callClient(h!.client, "events/subscribe", SUB_PARAMS)).rejects.toMatchObject({
      code: -32015,
      data: { reason: "non_2xx" },
    })
    expect(h!.store.list()).toHaveLength(0)
  })

  it("private callback URL: ssrf_blocked before any HTTP leaves the process", async () => {
    await expect(
      callClient(h!.client, "events/subscribe", {
        ...SUB_PARAMS,
        delivery: { mode: "webhook", url: "https://192.168.1.10/hook", secret: SECRET },
      }),
    ).rejects.toMatchObject({ code: -32015, data: { reason: "ssrf_blocked" } })
    expect(h!.fake.challenges).toHaveLength(0)
  })

  it("410 subscriber: terminal no-retry, row dead, exactly one POST", async () => {
    const sub = (await callClient(h!.client, "events/subscribe", SUB_PARAMS)) as { id: string }
    h!.fake.setDeliveryStatus(410)
    await h!.fire(PR_CLOSED)
    expect(h!.fake.deliveries).toHaveLength(1)
    const rows = h!.runtime.webhookOutbox.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe("dead")
    expect(rows[0]!.failReason).toBe("http_410")
    // Ack-after-terminal still holds: the dead row acks the event.
    expect(h!.store.isSeen(sub.id, "evt_pr_1428_closed")).toBe(true)
  })
})

describe("mcp-events e2e — restart persistence + TTL", () => {
  it("restart: a new store+runtime over the same files re-attaches and keeps delivering", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mcp-events-e2e-restart-"))
    let fake: FakeChatGPT | undefined
    let client: Client | undefined
    let runtime1: SentinelRuntime | undefined
    let runtime2: SentinelRuntime | undefined
    try {
      const now = (): number => 1_700_000_000_000
      const provider = createFakeSentinelProvider({ slug: "local-gh" })
      const resolveProvider = async (slug: string): Promise<SentinelProviderHandle | null> =>
        slug === "local-gh" ? provider : null
      const chatgpt = new FakeChatGPT([SECRET])
      fake = chatgpt
      await chatgpt.start()
      setEgressDispatcherForTests(async (req) => {
        const target = new URL(req.url)
        const response = await fetch(`${chatgpt.baseUrl}${target.pathname}${target.search}`, {
          method: "POST",
          headers: req.headers,
          body: req.body ? new Uint8Array(req.body) : undefined,
        })
        return { status: response.status, body: await response.text() }
      })

      const fire = async (runtime: SentinelRuntime, event: SentinelEvent): Promise<void> => {
        provider.emit(event)
        await runtime.pollOnce()
        await runtime.webhookOutbox.dispatch()
      }

      const connect = async (store: SentinelStore): Promise<Client> => {
        const { server } = await createMcpServer({ specs: [] })
        const principal = daemonBearerPrincipal()
        registerEventsMethods(server, {
          list: (params) => eventsList(params as EventsListRequest, { principal }),
          subscribe: (params) =>
            eventsSubscribe(params as unknown as EventsSubscribeInput, {
              principal,
              store,
              resolveProvider,
              nowMs: now,
            }),
          unsubscribe: (params) =>
            eventsUnsubscribe(params as unknown as EventsUnsubscribeInput, { principal, store, resolveProvider }),
        })
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
        const connected = new Client({ name: "mcp-events-e2e-restart", version: "0.0.0" })
        await Promise.all([server.connect(serverTransport), connected.connect(clientTransport)])
        return connected
      }

      // "Boot 1": subscribe + first delivery, all persisted.
      const store1 = createSentinelStore({ filePath: join(tmp, "sentinels.json"), nowMs: now })
      runtime1 = createSentinelRuntime({
        store: store1,
        registry: stubRegistry(),
        resolveProvider,
        isSessionAlive: () => true,
        restartSession: async (id) => id,
        outboxPath: join(tmp, "outbox.json"),
        nowMs: now,
      })
      client = await connect(store1)
      const sub = (await callClient(client, "events/subscribe", SUB_PARAMS)) as { id: string }
      await fire(runtime1, PR_CLOSED)
      expect(fake.deliveries).toHaveLength(1)
      expect(fake.deliveries[0]!.signatureOk).toBe(true)

      // "Restart": flush to disk, rebuild store + runtime over the same files.
      store1.flushSync()
      runtime1.webhookOutbox.flushSync()
      await client.close()
      runtime1.stop()
      const store2 = createSentinelStore({ filePath: join(tmp, "sentinels.json"), nowMs: now })
      runtime2 = createSentinelRuntime({
        store: store2,
        registry: stubRegistry(),
        resolveProvider,
        isSessionAlive: () => true,
        restartSession: async (id) => id,
        outboxPath: join(tmp, "outbox.json"),
        nowMs: now,
      })
      await runtime2.start()
      // The re-attach path ran: create (boot 1) + attach (boot 2) on the same handle.
      expect(provider.attachCalls.length).toBeGreaterThanOrEqual(2)
      expect(store2.get(sub.id)?.spec.target.kind).toBe("webhook")

      // A second event after the restart is delivered, signed with the
      // persisted secret (the fake verifies it against the same SECRET).
      await fire(runtime2, PR_CLOSED_AGAIN)
      expect(fake.deliveries).toHaveLength(2)
      expect(fake.deliveries[1]!.signatureOk).toBe(true)
      expect(JSON.parse(fake.deliveries[1]!.body).eventId).toBe("evt_pr_1428_closed_2")
      runtime2.stop()
    } finally {
      if (client) await client.close()
      if (runtime1) runtime1.stop()
      if (runtime2) runtime2.stop()
      setEgressDispatcherForTests(null)
      resetChallengeCacheForTests()
      if (fake) await fake.stop()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("TTL expiry: an event landing after until.at is never delivered", async () => {
    const clock = { t: 1_700_000_000_000 }
    const now = (): number => clock.t
    const harness = await makeHarness({ now })
    try {
      const sub = (await callClient(harness.client, "events/subscribe", { ...SUB_PARAMS, ttlMs: 60_000 })) as {
        id: string
        refreshBefore: string
      }
      expect(sub.refreshBefore).toBe(new Date(clock.t + 60_000).toISOString())

      // Advance past the granted expiration, then fire the event.
      clock.t += 61_000
      await harness.fire(PR_CLOSED)

      expect(harness.fake.deliveries).toHaveLength(0)
      expect(harness.store.get(sub.id)?.status).toBe("expired")
      expect(harness.provider.canceled.has("github:agentproto/ts#1428")).toBe(true)
    } finally {
      await harness.dispose()
    }
  })
})
