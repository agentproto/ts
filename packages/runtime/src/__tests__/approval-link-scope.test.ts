/**
 * A link-session token carrying an `approvalId` claim reads and decides
 * exactly that one daemon approval, through `GET /approvals/:id` and
 * `POST /approvals/:id/decision/telegram`, and only when its verified
 * `telegramUserId` is in the owner-only `approvals.humanTelegramIds` list.
 * Everything else under `/approvals` stays behind the tunnel bearer.
 *
 * Real `startHttpServer` + real `ApprovalsEngine`; the tunnel boundary is
 * simulated like `app-link-token-http.test.ts` does it (a loopback socket
 * carrying `X-Forwarded-For` reads as "crossed the network").
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer, type RuntimeHttpServerOptions } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createSessionsRegistry } from "../sessions.js"
import { createSessionEventBus, type SessionEvent } from "../session-event-bus.js"
import { createApprovalsEngine, type ApprovalsEngine } from "../approvals/engine.js"
import type { ApprovalRecord } from "../approvals/types.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import { mintAppLinkSessionToken, resetAppLinkSigningKeyCacheForTests } from "../app-link-token.js"
import { appLinkTunnelBypass } from "../app-link-gate.js"

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

const APP_ID = "@agentik/bureau"
const FORWARDED = { "x-forwarded-for": "203.0.113.7" }
const BOT_SECRET = "bot-bridge-secret"
const OWNER_TG = "4242"
const PREVIEW_MARKER = "preview-secret-marker-7f3a"
const FORBIDDEN = { error: "approval_link_forbidden" }

let dir: string
let keyPath: string
let engine: ApprovalsEngine
let events: SessionEvent[]
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agentproto-approval-link-"))
  keyPath = join(dir, "app_link_hmac")
  events = []
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(async () => {
  errorSpy.mockRestore()
  engine?.dispose()
  resetAppLinkSigningKeyCacheForTests()
  await rm(dir, { recursive: true, force: true })
})

async function withServer(
  humanTelegramIds: readonly string[] | undefined,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const bus = createSessionEventBus()
  bus.onAny(ev => events.push(ev))
  engine = createApprovalsEngine({ homeDir: join(dir, "approvals"), sessionEvents: bus, telegramBotSecret: BOT_SECRET })
  const registry = createSessionsRegistry({ persist: false, transcriptDir: join(dir, "sessions") })
  const port = await freePort()
  const opts: RuntimeHttpServerOptions = {
    port,
    auth: { mode: "bearer", token: "tunnel-bearer-secret" },
    mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    sessions: registry,
    meta: { workspace: process.cwd(), registered: [] },
    approvals: engine,
    approvalsWebOrigins: [],
    approvalsTelegramBotSecret: BOT_SECRET,
    appLinkKeyPath: keyPath,
    ...(humanTelegramIds !== undefined ? { approvalsHumanTelegramIds: humanTelegramIds } : {}),
  }
  const http = await startHttpServer(opts)
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await http.stop()
    registry.shutdown()
  }
}

function requestApproval(opts: { channels?: Array<"telegram" | "ui_card">; expiresAt?: string } = {}): ApprovalRecord {
  return engine.request(
    {
      kind: "send",
      title: "Submit application",
      preview: { note: PREVIEW_MARKER },
      payload: { x: 1 },
      ...(opts.channels ? { channels: opts.channels } : {}),
      ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
    },
    { operator: true },
  )
}

function linkToken(claims: Record<string, string>): string {
  return mintAppLinkSessionToken({ appId: APP_ID, claims, ttlMs: 60_000, keyPath }).token
}

function ownerToken(approvalId: string): string {
  return linkToken({ approvalId, telegramUserId: OWNER_TG })
}

async function getApproval(base: string, id: string, token: string, extra: Record<string, string> = {}) {
  const res = await fetch(`${base}/approvals/${id}`, { headers: { ...FORWARDED, authorization: `Bearer ${token}`, ...extra } })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function decide(base: string, id: string, token: string, decision: "approve" | "deny") {
  const res = await fetch(`${base}/approvals/${id}/decision/telegram`, {
    method: "POST",
    headers: { ...FORWARDED, authorization: `Bearer ${token}`, "content-type": "application/json", origin: base },
    body: JSON.stringify({ decision }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

function auditLines(): string[] {
  return errorSpy.mock.calls.map(args => String(args[0])).filter(line => line.startsWith("approval-link:"))
}

describe("approval link: allowed", () => {
  it("reads its own approval over the tunnel with no daemon bearer", async () => {
    await withServer([OWNER_TG], async base => {
      const a = requestApproval()
      const res = await getApproval(base, a.id, ownerToken(a.id))
      expect(res.status).toBe(200)
      expect(res.body).toEqual(JSON.parse(JSON.stringify(engine.get(a.id))))
    })
  })

  it("reads it from the page's own origin (same-origin Origin header)", async () => {
    await withServer([OWNER_TG], async base => {
      const a = requestApproval()
      const res = await getApproval(base, a.id, ownerToken(a.id), { origin: base })
      expect(res.status).toBe(200)
    })
  })

  it("approves it; the record and the decided event carry the Telegram id; a second decide is refused", async () => {
    await withServer([OWNER_TG], async base => {
      const a = requestApproval()
      const token = ownerToken(a.id)
      const res = await decide(base, a.id, token, "approve")
      expect(res.status).toBe(200)
      expect(res.body.status).toBe("approved")
      const stored = engine.get(a.id)!
      expect(stored.status).toBe("approved")
      expect(stored.decision).toMatchObject({ decision: "approved", channel: "telegram", telegramUserId: OWNER_TG })
      const decided = events.find(e => e.type === "approval:decided")
      expect(decided).toMatchObject({ approvalId: a.id, channel: "telegram", telegramUserId: OWNER_TG })

      const again = await decide(base, a.id, token, "deny")
      expect(again.status).toBe(403)
      expect(again.body).toEqual(FORBIDDEN)
      expect(engine.get(a.id)!.status).toBe("approved")
    })
  })

  it("denies it the same way", async () => {
    await withServer([OWNER_TG], async base => {
      const a = requestApproval()
      const token = ownerToken(a.id)
      const res = await decide(base, a.id, token, "deny")
      expect(res.status).toBe(200)
      expect(engine.get(a.id)!.status).toBe("denied")
      expect(engine.get(a.id)!.decision?.telegramUserId).toBe(OWNER_TG)
      expect((await decide(base, a.id, token, "approve")).status).toBe(403)
      expect(engine.get(a.id)!.status).toBe("denied")
    })
  })
})

describe("approval link: refused with one stable 403", () => {
  it("another approval than the claimed one (read and decide)", async () => {
    await withServer([OWNER_TG], async base => {
      const a = requestApproval()
      const b = requestApproval()
      const token = ownerToken(a.id)
      expect(await getApproval(base, b.id, token)).toEqual({ status: 403, body: FORBIDDEN })
      expect(await decide(base, b.id, token, "approve")).toEqual({ status: 403, body: FORBIDDEN })
      expect(engine.get(b.id)!.status).toBe("pending")
    })
  })

  it("a token with a sessionId claim and no approvalId", async () => {
    await withServer([OWNER_TG], async base => {
      const a = requestApproval()
      const token = linkToken({ sessionId: "sess_1", telegramUserId: OWNER_TG })
      expect(await getApproval(base, a.id, token)).toEqual({ status: 403, body: FORBIDDEN })
      expect(await decide(base, a.id, token, "approve")).toEqual({ status: 403, body: FORBIDDEN })
      expect(engine.get(a.id)!.status).toBe("pending")
    })
  })

  it("a token with no verified telegramUserId", async () => {
    await withServer([OWNER_TG], async base => {
      const a = requestApproval()
      const token = linkToken({ approvalId: a.id })
      expect(await getApproval(base, a.id, token)).toEqual({ status: 403, body: FORBIDDEN })
      expect(await decide(base, a.id, token, "approve")).toEqual({ status: 403, body: FORBIDDEN })
      expect(engine.get(a.id)!.status).toBe("pending")
    })
  })

  it("a telegramUserId outside the allow-list, same answer as any other refusal", async () => {
    await withServer([OWNER_TG], async base => {
      const a = requestApproval()
      const token = linkToken({ approvalId: a.id, telegramUserId: "999" })
      expect(await getApproval(base, a.id, token)).toEqual({ status: 403, body: FORBIDDEN })
      expect(await decide(base, a.id, token, "approve")).toEqual({ status: 403, body: FORBIDDEN })
      expect(engine.get(a.id)!.status).toBe("pending")
    })
  })

  it("an empty or absent allow-list turns the feature off", async () => {
    for (const list of [[], undefined]) {
      await withServer(list, async base => {
        const a = requestApproval()
        const token = ownerToken(a.id)
        expect(await getApproval(base, a.id, token)).toEqual({ status: 403, body: FORBIDDEN })
        expect(await decide(base, a.id, token, "approve")).toEqual({ status: 403, body: FORBIDDEN })
        expect(engine.get(a.id)!.status).toBe("pending")
      })
      engine.dispose()
    }
  })

  it("an approval that is already decided or expired", async () => {
    await withServer([OWNER_TG], async base => {
      const decided = requestApproval()
      await engine.decideTelegram(decided.id, "deny", { ipAddress: "x", userAgent: "y" })
      expect(await decide(base, decided.id, ownerToken(decided.id), "approve")).toEqual({ status: 403, body: FORBIDDEN })
      expect(engine.get(decided.id)!.status).toBe("denied")

      const expired = requestApproval({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      expect(await decide(base, expired.id, ownerToken(expired.id), "approve")).toEqual({ status: 403, body: FORBIDDEN })
      expect(engine.get(expired.id)!.status).toBe("expired")
    })
  })

  it("an approval whose telegram channel is not enabled", async () => {
    await withServer([OWNER_TG], async base => {
      const a = requestApproval({ channels: ["ui_card"] })
      expect(engine.get(a.id)!.channels).toEqual(["ui_card"])
      expect(await decide(base, a.id, ownerToken(a.id), "approve")).toEqual({ status: 403, body: FORBIDDEN })
      expect(engine.get(a.id)!.status).toBe("pending")
    })
  })

  it("a token for an unknown approval id", async () => {
    await withServer([OWNER_TG], async base => {
      expect(await decide(base, "apr_ghost", ownerToken("apr_ghost"), "approve")).toEqual({ status: 403, body: FORBIDDEN })
    })
  })
})

describe("approval link: every other /approvals route stays behind the tunnel bearer", () => {
  it("wrong methods, list, wait, consume, create and the web_click decide are not admitted", async () => {
    await withServer([OWNER_TG], async base => {
      const a = requestApproval()
      const auth = { ...FORWARDED, authorization: `Bearer ${ownerToken(a.id)}`, "content-type": "application/json" }
      const probes: Array<[string, string, unknown?]> = [
        ["PUT", `/approvals/${a.id}`],
        ["DELETE", `/approvals/${a.id}`],
        ["POST", `/approvals/${a.id}`, { decision: "approve" }],
        ["GET", `/approvals/${a.id}/decision/telegram`],
        ["PUT", `/approvals/${a.id}/decision/telegram`, { decision: "approve" }],
        ["GET", "/approvals"],
        ["GET", "/approvals?status=pending"],
        ["GET", `/approvals/${a.id}/wait?timeoutMs=10`],
        ["POST", `/approvals/${a.id}/consume`, { payload: { x: 1 } }],
        ["POST", "/approvals", { kind: "k", title: "t", preview: {}, payload: {} }],
        ["POST", `/approvals/${a.id}/decision`, { decision: "approve" }],
      ]
      for (const [method, path, body] of probes) {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: auth,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        })
        expect(res.status, `${method} ${path}`).toBe(401)
      }
      expect(engine.get(a.id)!.status).toBe("pending")
      expect(engine.list().length).toBe(1)
    })
  })
})

describe("approval link: the bot bridge is unchanged", () => {
  it("the telegramBotSecret bearer still decides on loopback, with no Telegram id recorded", async () => {
    await withServer([OWNER_TG], async base => {
      const a = requestApproval()
      const res = await fetch(`${base}/approvals/${a.id}/decision/telegram`, {
        method: "POST",
        headers: { authorization: `Bearer ${BOT_SECRET}`, "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      })
      expect(res.status).toBe(200)
      const stored = engine.get(a.id)!
      expect(stored.status).toBe("approved")
      expect(stored.decision?.telegramUserId).toBeUndefined()
    })
  })

  it("a wrong bearer on loopback is still refused with forbidden_channel", async () => {
    await withServer([OWNER_TG], async base => {
      const a = requestApproval()
      const res = await fetch(`${base}/approvals/${a.id}/decision/telegram`, {
        method: "POST",
        headers: { authorization: "Bearer nope", "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      })
      expect(res.status).toBe(403)
      expect(((await res.json()) as { error: string }).error).toBe("forbidden_channel")
      expect(engine.get(a.id)!.status).toBe("pending")
    })
  })
})

describe("approval link: audit", () => {
  it("one line per request, allowed and denied, never the token nor the preview", async () => {
    await withServer([OWNER_TG], async base => {
      const a = requestApproval()
      const b = requestApproval()
      const token = ownerToken(a.id)
      const stranger = linkToken({ approvalId: a.id, telegramUserId: "999" })
      await getApproval(base, a.id, token)
      await getApproval(base, b.id, token)
      await decide(base, a.id, stranger, "approve")
      await decide(base, a.id, token, "approve")

      const lines = auditLines()
      expect(lines).toHaveLength(4)
      expect(lines[0]).toMatch(new RegExp(`^approval-link: read allowed approvalId=${a.id} telegramUserId=${OWNER_TG} `))
      expect(lines[1]).toMatch(new RegExp(`^approval-link: read denied approvalId=${b.id} telegramUserId=${OWNER_TG} .*reason=claim_mismatch`))
      expect(lines[2]).toMatch(new RegExp(`^approval-link: decide denied approvalId=${a.id} telegramUserId=999 .*reason=not_allowlisted`))
      expect(lines[3]).toMatch(new RegExp(`^approval-link: decide allowed approvalId=${a.id} telegramUserId=${OWNER_TG} `))
      for (const line of lines) {
        expect(line).not.toContain(token)
        expect(line).not.toContain(stranger)
        expect(line).not.toContain(PREVIEW_MARKER)
      }
    })
  })
})

describe("approval link: tunnel gate predicate", () => {
  function fakeReq(token: string): IncomingMessage {
    return { headers: { authorization: `Bearer ${token}` }, url: "/", socket: { remoteAddress: "203.0.113.7" } } as unknown as IncomingMessage
  }

  it("admits a link token on exactly GET /approvals/:id and POST /approvals/:id/decision/telegram", () => {
    const token = linkToken({ approvalId: "apr_a", telegramUserId: OWNER_TG })
    const table: Array<[string, string, boolean]> = [
      ["GET", "/approvals/apr_a", true],
      ["POST", "/approvals/apr_a/decision/telegram", true],
      ["HEAD", "/approvals/apr_a", false],
      ["PUT", "/approvals/apr_a", false],
      ["DELETE", "/approvals/apr_a", false],
      ["POST", "/approvals/apr_a", false],
      ["GET", "/approvals/apr_a/decision/telegram", false],
      ["POST", "/approvals/apr_a/decision", false],
      ["GET", "/approvals/apr_a/wait", false],
      ["POST", "/approvals/apr_a/consume", false],
      ["GET", "/approvals", false],
      ["POST", "/approvals", false],
      ["GET", "/approvals/apr_a/extra", false],
    ]
    for (const [method, path, expected] of table) {
      expect(appLinkTunnelBypass(fakeReq(token), path, method, keyPath), `${method} ${path}`).toBe(expected)
    }
  })

  it("does not admit an invalid token", () => {
    expect(appLinkTunnelBypass(fakeReq("garbage"), "/approvals/apr_a", "GET", keyPath)).toBe(false)
  })
})
