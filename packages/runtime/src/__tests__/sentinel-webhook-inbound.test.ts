/**
 * `POST /inbound/sentinel-<hookKey>` — the "sentinel" inbound dialect end to
 * end through the real REST layer (`startHttpServer`): signature gate, unknown
 * key, delivery into the sentinel runtime, redelivery dedup, 5xx-on-failure,
 * and the bearer-mode exemption (the route is authenticated by the HMAC, not
 * by the tunnel bearer).
 */

import { createHmac } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it } from "vitest"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import { createSentinelRuntime, type SentinelRuntimeRegistry } from "../sentinel-runtime.js"
import { createSentinelStore } from "../sentinel-store.js"
import { handleSentinelInbound } from "../sentinel-inbound.js"
import { createWebhookHookStore } from "../sentinel-providers/webhook-hooks.js"
import { webhookSentinelProvider, type WebhookGhRunner } from "../sentinel-providers/webhook.js"
import { deliveryPreferenceFor, singleMatch, type SentinelSpec } from "../sentinel-providers/types.js"
import type { SessionMessage } from "../session-message.js"
import type { SendMessageResult } from "../sessions.js"

const TOKEN = "tunnel-bearer-token"

const PR_MERGED = JSON.stringify({
  action: "closed",
  number: 12,
  pull_request: { number: 12, title: "t", html_url: "https://github.com/o/r/pull/12", merged: true, head: { sha: "s1" } },
  repository: { full_name: "o/r" },
  sender: { login: "alice" },
})

const sign = (body: string, secret: string): string => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`

const fakeGh: WebhookGhRunner = async args => (args.includes("POST") ? JSON.stringify({ id: 4242 }) : "{}")

async function setup(opts?: { auth?: "none" | "bearer"; failSend?: boolean; noRuntime?: boolean }) {
  const hooks = createWebhookHookStore({ persist: false })
  const provider = webhookSentinelProvider({
    gh: fakeGh,
    hooks,
    publicUrl: () => ({ url: "https://hooks.example.com", stable: true, source: "env" }),
  })
  const spec: SentinelSpec = {
    match: singleMatch("github:o/r#12"),
    until: { kind: "subject_terminal" },
    target: { kind: "session", sessionId: "sess_1", urgency: "next-turn" },
    provider: "webhook",
  }
  const handle = await provider.create(spec, deliveryPreferenceFor(provider, 15_000))
  const store = createSentinelStore({ persist: false })
  const sentinel = store.create({ spec, provider: "webhook", handle })
  const rec = hooks.getByRepo("o/r")!

  const sent: string[] = []
  const registry: SentinelRuntimeRegistry = {
    async sendMessage(msg: SessionMessage): Promise<SendMessageResult> {
      if (opts?.failSend) throw new Error("boom")
      sent.push(msg.text)
      return { messageId: "m", delivered: { via: "turn" }, queued: false, urgencyApplied: "next-turn" }
    },
  }
  const resolveProvider = async (slug: string) => (slug === "webhook" ? provider : null)
  const runtime = createSentinelRuntime({
    store,
    registry,
    resolveProvider,
    isSessionAlive: () => true,
    restartSession: async id => id,
    log: () => {},
  })

  const port = await freePort()
  const http = await startHttpServer({
    port,
    auth: opts?.auth === "bearer" ? { mode: "bearer", token: TOKEN } : { mode: "none" },
    sentinels: { store, resolveProvider, isSessionAlive: () => true, ...(opts?.noRuntime ? {} : { runtime }) },
    mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    meta: { workspace: process.cwd(), registered: [] },
  })
  const post = (
    path: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; json: Record<string, unknown> }> =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body }).then(
      async res => ({ status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> }),
    )
  const deliver = (id: string, over?: { body?: string; headers?: Record<string, string>; key?: string }) => {
    const body = over?.body ?? PR_MERGED
    return post(`/inbound/sentinel-${over?.key ?? rec.key}`, body, {
      "x-hub-signature-256": sign(body, rec.secret),
      "x-github-event": "pull_request",
      "x-github-delivery": id,
      ...over?.headers,
    })
  }
  return { http, port, post, deliver, rec, store, sentinel, sent, runtime, hooks, provider, resolveProvider, stop: () => http.stop() }
}

describe("POST /inbound/sentinel-<hookKey>", () => {
  it("delivers a signed GitHub event to the bound sentinel (200) and expires it on the terminal event", async () => {
    const s = await setup()
    try {
      const res = await s.deliver("del-1")
      expect(res.status).toBe(200)
      expect(res.json).toMatchObject({ ok: true, events: 1, sentinels: 1, delivered: 1 })
      expect(s.sent).toHaveLength(1)
      expect(s.sent[0]).toContain("merged by alice")
      expect(s.store.get(s.sentinel.id)?.status).toBe("expired")
    } finally {
      await s.stop()
    }
  })

  it("a GitHub redelivery (same X-GitHub-Delivery) is acknowledged but not delivered again", async () => {
    const s = await setup()
    try {
      // never-ending sentinel so the second delivery reaches the seen check
      const spec: SentinelSpec = { ...s.sentinel.spec, until: { kind: "never" } }
      const keep = s.store.create({ spec, provider: "webhook", handle: s.sentinel.handle })
      s.store.remove(s.sentinel.id)

      expect((await s.deliver("del-2")).json).toMatchObject({ delivered: 1 })
      const again = await s.deliver("del-2")
      expect(again.status).toBe(200)
      expect(again.json).toMatchObject({ ok: true, delivered: 0 })
      expect(s.sent).toHaveLength(1)
      expect(s.store.get(keep.id)?.eventCount).toBe(1)
    } finally {
      await s.stop()
    }
  })

  it("401 on a bad signature and on a missing signature — nothing delivered", async () => {
    const s = await setup()
    try {
      const bad = await s.deliver("d", { headers: { "x-hub-signature-256": sign(PR_MERGED, "wrong") } })
      expect(bad.status).toBe(401)
      expect(bad.json).toMatchObject({ error: "bad_signature", reason: "bad_signature" })

      const res = await fetch(`http://127.0.0.1:${s.port}/inbound/sentinel-${s.rec.key}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": "d" },
        body: PR_MERGED,
      })
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({ reason: "missing_signature" })

      expect(s.sent).toHaveLength(0)
      expect(s.store.get(s.sentinel.id)?.status).toBe("active")
    } finally {
      await s.stop()
    }
  })

  it("404 (generic, nothing echoed) for an unknown hook key", async () => {
    const s = await setup()
    try {
      const res = await s.deliver("d", { key: "deadbeefdeadbeefdeadbeefdeadbeef" })
      expect(res.status).toBe(404)
      expect(JSON.stringify(res.json)).not.toContain("deadbeef")
      expect(s.sent).toHaveLength(0)
    } finally {
      await s.stop()
    }
  })

  it("ping is acked 200 with no delivery", async () => {
    const s = await setup()
    try {
      const body = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 })
      const res = await s.deliver("p", { body, headers: { "x-github-event": "ping", "x-hub-signature-256": sign(body, s.rec.secret) } })
      expect(res.status).toBe(200)
      expect(res.json).toMatchObject({ ok: true, events: 0 })
      expect(s.sent).toHaveLength(0)
    } finally {
      await s.stop()
    }
  })

  it("400 for a validly-signed but malformed delivery", async () => {
    const s = await setup()
    try {
      const body = "not json"
      const res = await s.deliver("p", { body, headers: { "x-hub-signature-256": sign(body, s.rec.secret) } })
      expect(res.status).toBe(400)
      expect(res.json).toMatchObject({ error: "invalid_json" })
    } finally {
      await s.stop()
    }
  })

  it("5xx when delivery to the session fails, and the redelivery is then delivered (not swallowed)", async () => {
    const s = await setup({ failSend: true })
    try {
      const res = await s.deliver("del-5")
      expect(res.status).toBe(500)
      expect(res.json).toMatchObject({ error: "delivery_failed" })
      expect(s.store.isSeen(s.sentinel.id, "evt_del-5")).toBe(false)
    } finally {
      await s.stop()
    }
  })

  it("with no sentinel runtime wired, the sentinel- path is not special-cased (unknown endpoint 404)", async () => {
    const s = await setup({ noRuntime: true })
    try {
      const res = await s.deliver("d")
      expect(res.status).toBe(404)
      expect(s.sent).toHaveLength(0)
    } finally {
      await s.stop()
    }
  })

  it("bearer mode: a non-loopback (proxied) delivery skips the tunnel bearer and is gated by the HMAC instead", async () => {
    const s = await setup({ auth: "bearer" })
    try {
      const proxied = { "x-forwarded-for": "140.82.115.10" }

      // Control: an ordinary route is refused by the tunnel-bearer gate.
      const control = await s.post("/inbound", "{}", proxied)
      expect(control.status).toBe(401)
      expect(control.json.error).toBe("tunnel_unauthorized")

      // The sentinel route: signature failure, NOT tunnel_unauthorized.
      const bad = await s.deliver("d", { headers: { ...proxied, "x-hub-signature-256": sign(PR_MERGED, "wrong") } })
      expect(bad.status).toBe(401)
      expect(bad.json.error).toBe("bad_signature")

      // And a correctly signed one gets through with no bearer at all.
      const good = await s.deliver("d-ok", { headers: proxied })
      expect(good.status).toBe(200)
      expect(good.json).toMatchObject({ ok: true, delivered: 1 })
      expect(s.sent).toHaveLength(1)
    } finally {
      await s.stop()
    }
  })
})

describe("handleSentinelInbound (no HTTP)", () => {
  it("only delivers to sentinels bound to THIS hook key, across repos", async () => {
    const s = await setup()
    try {
      const otherSpec: SentinelSpec = { ...s.sentinel.spec, match: singleMatch("github:o/other#1"), until: { kind: "never" } }
      const otherHandle = await s.provider.create(otherSpec, deliveryPreferenceFor(s.provider, 15_000))
      const other = s.store.create({ spec: otherSpec, provider: "webhook", handle: otherHandle })
      const calls: string[] = []
      const result = await handleSentinelInbound(
        s.rec.key,
        {
          rawBody: PR_MERGED,
          headers: { "x-hub-signature-256": sign(PR_MERGED, s.rec.secret), "x-github-event": "pull_request", "x-github-delivery": "z" },
        },
        {
          store: s.store,
          resolveProvider: s.resolveProvider,
          runtime: {
            async deliverPushed(id) {
              calls.push(id)
              return { delivered: 1, failed: false }
            },
          },
        },
      )
      expect(result?.status).toBe(200)
      expect(calls).toEqual([s.sentinel.id])
      expect(calls).not.toContain(other.id)
    } finally {
      await s.stop()
    }
  })
})

// ── helpers ──────────────────────────────────────────────────────────

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

function noopConversations(): ConversationStore {
  return {
    async open() {},
    async appendTurn() {},
    async read() {
      return { meta: {} as never, turns: [] }
    },
    async list() {
      return []
    },
    pathFor: (id: string) => id,
  }
}

function noopHeartbeat(): HeartbeatRunner {
  return { start() {}, stop() {}, async fireNow() {} }
}
