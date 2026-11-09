/**
 * AIP-53 link-token scoping over the real HTTP surface: a Telegram-gated
 * link token, once exchanged via `POST /apps/:appId/link-auth`, widens
 * `tunnelBearerAllowed` (http-server.ts) ONLY for its own app's tool-call
 * route and its own session's four read routes; everything else (a
 * DIFFERENT session's reads, `/mcp`, `/sessions/:id/kill`, the PTY
 * upgrade) stays exactly as gated as plain `tunnel-bearer-gate.test.ts`
 * already proves for the no-token case.
 *
 * Simulates the tunnel boundary the same way that suite does: a loopback
 * socket carrying `X-Forwarded-For` reads as "crossed the network"
 * (`isLoopback`'s forwarding check).
 */

import { afterEach, describe, expect, it } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"
import { forgetLiveBrowserInstance, setLiveBrowserInstance } from "../browser-tools.js"

import { startHttpServer, type RuntimeHttpServerOptions } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createSessionsRegistry } from "../sessions.js"
import type { PtyFactory, PtyProcess } from "../sessions.js"
import { createAppRegistry, type AppRegistry } from "../app-registry.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import { mintAppLinkToken, mintAppLinkSessionToken, resetAppLinkSigningKeyCacheForTests } from "../app-link-token.js"
import type { TelegramBotCredsStore } from "../telegram-bot-creds.js"
import { FAKE_BOT_TOKEN, signInitData, buildInitDataFields } from "./helpers/telegram-init-data-fixture.js"

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

async function mcpServerFactory() {
  return (await createMcpServer({ specs: [], name: "main", version: "0" })).server
}

function fakePtyFactory(): PtyFactory {
  return (): PtyProcess => ({
    pid: 4242,
    write: () => {},
    resize: () => {},
    kill: () => {},
    onData: () => {},
    onExit: () => {},
  })
}

function fakeTelegramCreds(token: string): TelegramBotCredsStore {
  return {
    read: async alias => (alias === "default" ? { token } : null),
    write: async () => {},
    exists: async alias => alias === "default",
  }
}

const APP_ID = "@agentik/session-chat"
const FORWARDED = { "x-forwarded-for": "203.0.113.7" }

describe("AIP-53 link-token scoping — HTTP surface", () => {
  let dir: string
  let appRegistry: AppRegistry
  let keyPath: string

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    resetAppLinkSigningKeyCacheForTests()
  })

  async function withServer(
    fn: (base: string, registry: ReturnType<typeof createSessionsRegistry>) => Promise<void>,
    extraOpts: Partial<RuntimeHttpServerOptions> = {},
  ): Promise<void> {
    dir = await mkdtemp(join(tmpdir(), "agentproto-link-token-http-"))
    keyPath = join(dir, "app_link_hmac")
    appRegistry = createAppRegistry()
    appRegistry.upsertApp({
      appId: APP_ID,
      dir,
      agents: [],
      workflows: [],
      unvalidatedAgentTools: [],
      ui: {
        path: join(dir, "ui.html"),
        tools: ["conversation_read", "permissions_respond", "approval_probe"],
        toolScope: {
          conversation_read: { sessionId: "$link.sessionId" },
          permissions_respond: {},
          approval_probe: { approvalId: "$link.approvalId" },
        },
      },
    })

    const registry = createSessionsRegistry({ persist: false, spawnPty: fakePtyFactory() })
    const port = await freePort()
    const opts: RuntimeHttpServerOptions = {
      port,
      auth: { mode: "bearer", token: "tunnel-bearer-secret" },
      mcpServerFactory,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
      sessions: registry,
      resolveAgentAdapter: (async () => {
        throw new Error("not used in this test")
      }) as never,
      ptyEnabled: true,
      appRegistry,
      appToolCallDeps: { dispatchTool: async (_tool, args) => ({ ok: true, args }) },
      telegramCreds: fakeTelegramCreds(FAKE_BOT_TOKEN),
      appLinkKeyPath: keyPath,
      ...extraOpts,
    }
    const http = await startHttpServer(opts)
    try {
      await fn(`http://127.0.0.1:${port}`, registry)
    } finally {
      await http.stop()
      registry.shutdown()
    }
  }

  function spawnSession(registry: ReturnType<typeof createSessionsRegistry>) {
    return registry.spawnPty({ workspaceSlug: "default", cwd: process.cwd(), argv: ["bash"], cols: 80, rows: 24 })
  }

  function mintSessionToken(appId: string, sessionId: string): string {
    return mintAppLinkSessionToken({ appId, claims: { sessionId, telegramUserId: "42" }, ttlMs: 60_000, keyPath }).token
  }

  async function probeGet(base: string, path: string, headers: Record<string, string>): Promise<number> {
    try {
      const res = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(300) })
      return res.status
    } catch {
      return 200
    }
  }

  it("a scoped link-session token reaches its own app's tool-call route over a forwarded (tunnel) request with no bearer", async () => {
    await withServer(async (base, registry) => {
      const target = spawnSession(registry)
      const sessionToken = mintSessionToken(APP_ID, target.id)
      const res = await fetch(`${base}/apps/${encodeURIComponent(APP_ID)}/tool-call`, {
        method: "POST",
        headers: { ...FORWARDED, authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify({ tool: "conversation_read", args: {} }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { content: { text: string }[] }
      const inner = JSON.parse(body.content[0]!.text) as { ok: boolean; args: Record<string, unknown> }
      expect(inner.ok).toBe(true)
      expect(inner.args).toEqual({ sessionId: target.id })
    })
  })

  it("a link-session token scoped to a DIFFERENT appId is refused on this app's tool-call route", async () => {
    await withServer(async base => {
      const sessionToken = mintSessionToken("@some/other-app", "sess_whatever")
      const res = await fetch(`${base}/apps/${encodeURIComponent(APP_ID)}/tool-call`, {
        method: "POST",
        headers: { ...FORWARDED, authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify({ tool: "conversation_read", args: {} }),
      })
      expect(res.status).toBe(401)
    })
  })

  it("read routes for the token's OWN session succeed over the tunnel; a DIFFERENT session's reads do not", async () => {
    await withServer(async (base, registry) => {
      const mine = spawnSession(registry)
      const other = spawnSession(registry)
      const sessionToken = mintSessionToken(APP_ID, mine.id)
      const headers = { ...FORWARDED, authorization: `Bearer ${sessionToken}` }

      expect((await fetch(`${base}/sessions/${mine.id}`, { headers })).status).toBe(200)
      expect((await fetch(`${base}/sessions/${mine.id}/events`, { headers })).status).not.toBe(401)
      expect(await probeGet(base, `/sessions/${mine.id}/events/stream`, headers)).not.toBe(401)

      expect((await fetch(`${base}/sessions/${other.id}`, { headers })).status).toBe(401)
      expect((await fetch(`${base}/sessions/${other.id}/events`, { headers })).status).toBe(401)
    })
  })

  it("GET /sessions/:id/capabilities is allowed for the token's OWN session over the tunnel and refused for a DIFFERENT session", async () => {
    await withServer(async (base, registry) => {
      const mine = spawnSession(registry)
      const other = spawnSession(registry)
      const sessionToken = mintSessionToken(APP_ID, mine.id)
      const headers = { ...FORWARDED, authorization: `Bearer ${sessionToken}` }

      expect((await fetch(`${base}/sessions/${mine.id}/capabilities`, { headers })).status).toBe(200)
      expect((await fetch(`${base}/sessions/${other.id}/capabilities`, { headers })).status).toBe(401)
    })
  })

  it("permissions_respond over the tool-call route checks the permission id against the daemon's pending-permission inbox", async () => {
    await withServer(async (base, registry) => {
      const mine = spawnSession(registry)
      const other = spawnSession(registry)
      const pending = [
        { id: "perm_mine", sessionId: mine.id },
        { id: "perm_other", sessionId: other.id },
      ]
      // The route reads the registry at call time, so stubbing the inbox
      // here is enough: no permission-hold driver needed.
      registry.listPendingPermissions = (() => pending) as unknown as typeof registry.listPendingPermissions
      const sessionToken = mintSessionToken(APP_ID, mine.id)
      const call = async (id: string) => {
        const res = await fetch(`${base}/apps/${encodeURIComponent(APP_ID)}/tool-call`, {
          method: "POST",
          headers: { ...FORWARDED, authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
          body: JSON.stringify({ tool: "permissions_respond", args: { id, decision: "approve" } }),
        })
        expect(res.status).toBe(200)
        return (await res.json()) as { isError?: boolean; content: { text: string }[] }
      }

      const allowed = await call("perm_mine")
      expect(allowed.isError).toBeUndefined()
      expect(JSON.parse(allowed.content[0]!.text)).toEqual({ ok: true, args: { id: "perm_mine", decision: "approve" } })

      expect((await call("perm_other")).isError).toBe(true)
      expect((await call("perm_unknown")).isError).toBe(true)
    })
  })

  it("a link-session token grants NOTHING beyond the four read routes + its own tool-call: /mcp, kill, and the PTY route stay gated", async () => {
    await withServer(async (base, registry) => {
      const mine = spawnSession(registry)
      const sessionToken = mintSessionToken(APP_ID, mine.id)
      const headers = { ...FORWARDED, authorization: `Bearer ${sessionToken}` }

      const mcp = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
      expect(mcp.status).toBe(401)

      const kill = await fetch(`${base}/sessions/${mine.id}/kill`, { method: "POST", headers })
      expect(kill.status).toBe(401)

      // The plain line-tail `/stream` (distinct from `/events/stream`) is
      // deliberately NOT in the read-route allowlist — a link-session token
      // only ever widens the three routes session-chat actually uses.
      expect(await probeGet(base, `/sessions/${mine.id}/stream`, headers)).toBe(401)
    })
  })

  it("a bare (unauthorized) LINK token — never exchanged via link-auth — is refused everywhere a SESSION token would work", async () => {
    await withServer(async (base, registry) => {
      const mine = spawnSession(registry)
      const { token: linkToken } = mintAppLinkToken({
        appId: APP_ID,
        claims: { sessionId: mine.id, telegramUserId: "42" },
        ttlMs: 60_000,
        pendingTelegramAuth: true,
        keyPath,
      })
      const headers = { ...FORWARDED, authorization: `Bearer ${linkToken}` }
      expect((await fetch(`${base}/sessions/${mine.id}`, { headers })).status).toBe(401)
      const toolCall = await fetch(`${base}/apps/${encodeURIComponent(APP_ID)}/tool-call`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ tool: "conversation_read", args: {} }),
      })
      expect(toolCall.status).toBe(401)
    })
  })

  describe("generic claims and the screencast routes", () => {
    const FRAME = Buffer.from("fake-jpeg-frame")
    const SESSIONS_TOKEN = "sessions-boot-token"

    async function exchangeClaimsLink(base: string, claims: Record<string, string>) {
      const { token: linkToken } = mintAppLinkToken({
        appId: APP_ID,
        claims: { ...claims, telegramUserId: "42" },
        ttlMs: 60_000,
        pendingTelegramAuth: true,
        keyPath,
      })
      const res = await fetch(`${base}/apps/${encodeURIComponent(APP_ID)}/link-auth`, {
        method: "POST",
        headers: { ...FORWARDED, "content-type": "application/json" },
        body: JSON.stringify({ linkToken, initData: signInitData(buildInitDataFields({ userId: 42 }), FAKE_BOT_TOKEN) }),
      })
      return { res, body: (await res.json()) as { ok: boolean; token: string; sessionId?: string; claims: Record<string, string> } }
    }

    function registerChromeLive(registry: ReturnType<typeof createSessionsRegistry>, port = 9222): string {
      const desc = registry.registerBrowser({
        adapterId: "chrome-live",
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        wasAlreadyRunning: true,
        stop: async () => {},
      })
      setLiveBrowserInstance(desc.id, {
        screencastFrame: async () => ({ data: FRAME.toString("base64"), format: "jpeg", index: 0 }),
      } as unknown as Parameters<typeof setLiveBrowserInstance>[1])
      return desc.id
    }

    async function statusOf(url: string, headers: Record<string, string> = {}): Promise<number> {
      const res = await fetch(url, { headers: { ...FORWARDED, ...headers } })
      await res.body?.cancel()
      return res.status
    }

    it("a claims-only link exchanges to a token carrying the claims, usable on a claim-pinned tool and not on any session read", async () => {
      await withServer(async (base, registry) => {
        const someSession = spawnSession(registry)
        const { res, body } = await exchangeClaimsLink(base, { approvalId: "a1" })
        expect(res.status).toBe(200)
        expect(body.ok).toBe(true)
        expect(body.claims).toEqual({ approvalId: "a1" })
        expect(body.sessionId).toBeUndefined()

        const call = async (args: Record<string, unknown>) => {
          const r = await fetch(`${base}/apps/${encodeURIComponent(APP_ID)}/tool-call`, {
            method: "POST",
            headers: { ...FORWARDED, authorization: `Bearer ${body.token}`, "content-type": "application/json" },
            body: JSON.stringify({ tool: "approval_probe", args }),
          })
          expect(r.status).toBe(200)
          return (await r.json()) as { isError?: boolean; content: { text: string }[] }
        }
        const pinned = await call({})
        expect(pinned.isError).toBeUndefined()
        expect(JSON.parse(pinned.content[0]!.text)).toEqual({ ok: true, args: { approvalId: "a1" } })
        expect((await call({ approvalId: "a2" })).isError).toBe(true)

        const headers = { ...FORWARDED, authorization: `Bearer ${body.token}` }
        expect((await fetch(`${base}/sessions/${someSession.id}`, { headers })).status).toBe(401)
        expect((await fetch(`${base}/sessions/${someSession.id}/events`, { headers })).status).toBe(401)
        expect((await fetch(`${base}/sessions/${someSession.id}/capabilities`, { headers })).status).toBe(401)
        expect((await fetch(`${base}/sessions/undefined`, { headers })).status).toBe(401)
        expect(await statusOf(`${base}/sessions/${someSession.id}/screencast.jpg`, headers)).toBe(401)
      })
    })

    it("a claims-only token has no sessionId claim, so permissions_respond is refused", async () => {
      await withServer(async (base, registry) => {
        const mine = spawnSession(registry)
        registry.listPendingPermissions = (() => [{ id: "perm_1", sessionId: mine.id }]) as unknown as typeof registry.listPendingPermissions
        const { body } = await exchangeClaimsLink(base, { approvalId: "a1" })
        const r = await fetch(`${base}/apps/${encodeURIComponent(APP_ID)}/tool-call`, {
          method: "POST",
          headers: { ...FORWARDED, authorization: `Bearer ${body.token}`, "content-type": "application/json" },
          body: JSON.stringify({ tool: "permissions_respond", args: { id: "perm_1", decision: "approve" } }),
        })
        expect(((await r.json()) as { isError?: boolean }).isError).toBe(true)
      })
    })

    it("a session link still answers with its sessionId, and claims lists the non-reserved claims only", async () => {
      await withServer(async (base, registry) => {
        const target = spawnSession(registry)
        const { body } = await exchangeClaimsLink(base, { sessionId: target.id, approvalId: "a1", botAlias: "default", sessionTtlMs: "60000" })
        expect(body.sessionId).toBe(target.id)
        expect(body.claims).toEqual({ sessionId: target.id, approvalId: "a1" })
      })
    })

    it("the token's OWN screencast answers on all three spellings, with a bearer header and with ?token=", async () => {
      await withServer(
        async (base, registry) => {
          const mine = registerChromeLive(registry)
          try {
            const token = mintSessionToken(APP_ID, mine)
            const bearer = { authorization: `Bearer ${token}` }
            for (const suffix of ["screencast", "screencast.jpg", "screencast.mjpg"]) {
              expect(await statusOf(`${base}/sessions/${mine}/${suffix}`, bearer)).toBe(200)
              expect(await statusOf(`${base}/sessions/${mine}/${suffix}?token=${token}`)).toBe(200)
            }
            const frame = await fetch(`${base}/sessions/${mine}/screencast.jpg?token=${token}`, { headers: FORWARDED })
            expect(Buffer.from(await frame.arrayBuffer()).equals(FRAME)).toBe(true)
            const viewer = await fetch(`${base}/sessions/${mine}/screencast?token=${token}`, { headers: FORWARDED })
            expect(await viewer.text()).toContain(`/sessions/${mine}/screencast.mjpg?token=${token}`)
          } finally {
            forgetLiveBrowserInstance(mine)
          }
        },
        { token: SESSIONS_TOKEN },
      )
    })

    it("ANOTHER session's screencast stays refused, as does a claims-less or non-GET request", async () => {
      await withServer(
        async (base, registry) => {
          const mine = registerChromeLive(registry, 9222)
          const other = registerChromeLive(registry, 9223)
          try {
            const token = mintSessionToken(APP_ID, mine)
            const bearer = { authorization: `Bearer ${token}` }
            for (const suffix of ["screencast", "screencast.jpg", "screencast.mjpg"]) {
              expect(await statusOf(`${base}/sessions/${other}/${suffix}`, bearer)).toBe(401)
              expect(await statusOf(`${base}/sessions/${other}/${suffix}?token=${token}`)).toBe(401)
              expect(await statusOf(`${base}/sessions/${mine}/${suffix}`)).toBe(401)
            }
            const post = await fetch(`${base}/sessions/${mine}/screencast.jpg`, { method: "POST", headers: { ...FORWARDED, ...bearer } })
            expect(post.status).toBe(401)
            expect(await statusOf(`${base}/sessions/${mine}/screencast.png`, bearer)).toBe(401)
            expect(await statusOf(`${base}/sessions/${mine}/screencast/extra`, bearer)).toBe(401)
          } finally {
            forgetLiveBrowserInstance(mine)
            forgetLiveBrowserInstance(other)
          }
        },
        { token: SESSIONS_TOKEN },
      )
    })
  })

  describe("POST /apps/:appId/link-auth", () => {
    it("exchanges a valid link token + matching initData for a usable session token", async () => {
      await withServer(async (base, registry) => {
        const target = spawnSession(registry)
        const { token: linkToken } = mintAppLinkToken({
          appId: APP_ID,
          claims: { sessionId: target.id, telegramUserId: "42" },
          ttlMs: 60_000,
          pendingTelegramAuth: true,
          keyPath,
        })
        const initData = signInitData(buildInitDataFields({ userId: 42 }), FAKE_BOT_TOKEN)
        const res = await fetch(`${base}/apps/${encodeURIComponent(APP_ID)}/link-auth`, {
          method: "POST",
          headers: { ...FORWARDED, "content-type": "application/json" },
          body: JSON.stringify({ linkToken, initData }),
        })
        expect(res.status).toBe(200)
        const body = (await res.json()) as { ok: boolean; token: string; sessionId: string }
        expect(body.ok).toBe(true)
        expect(body.sessionId).toBe(target.id)

        // The session token minted by link-auth actually works on the
        // scoped tool-call route.
        const toolCall = await fetch(`${base}/apps/${encodeURIComponent(APP_ID)}/tool-call`, {
          method: "POST",
          headers: { ...FORWARDED, authorization: `Bearer ${body.token}`, "content-type": "application/json" },
          body: JSON.stringify({ tool: "conversation_read", args: {} }),
        })
        expect(toolCall.status).toBe(200)
      })
    })

    it("the same link token exchanged TWICE (a second tap on the button, a reload) yields two working session tokens", async () => {
      await withServer(async (base, registry) => {
        const target = spawnSession(registry)
        const { token: linkToken } = mintAppLinkToken({
          appId: APP_ID,
          claims: { sessionId: target.id, telegramUserId: "42" },
          ttlMs: 60_000,
          pendingTelegramAuth: true,
          keyPath,
        })
        const exchange = () =>
          fetch(`${base}/apps/${encodeURIComponent(APP_ID)}/link-auth`, {
            method: "POST",
            headers: { ...FORWARDED, "content-type": "application/json" },
            body: JSON.stringify({ linkToken, initData: signInitData(buildInitDataFields({ userId: 42 }), FAKE_BOT_TOKEN) }),
          })
        expect((await exchange()).status).toBe(200)
        const second = await exchange()
        expect(second.status).toBe(200)
        const body = (await second.json()) as { ok: boolean; token: string }
        expect(body.ok).toBe(true)
        const read = await fetch(`${base}/sessions/${target.id}`, {
          headers: { ...FORWARDED, authorization: `Bearer ${body.token}` },
        })
        expect(read.status).toBe(200)
      })
    })

    it("a Telegram user mismatch is refused (403)", async () => {
      await withServer(async (base, registry) => {
        const target = spawnSession(registry)
        const { token: linkToken } = mintAppLinkToken({
          appId: APP_ID,
          claims: { sessionId: target.id, telegramUserId: "42" },
          ttlMs: 60_000,
          pendingTelegramAuth: true,
          keyPath,
        })
        const initData = signInitData(buildInitDataFields({ userId: 999 }), FAKE_BOT_TOKEN)
        const res = await fetch(`${base}/apps/${encodeURIComponent(APP_ID)}/link-auth`, {
          method: "POST",
          headers: { ...FORWARDED, "content-type": "application/json" },
          body: JSON.stringify({ linkToken, initData }),
        })
        expect(res.status).toBe(403)
      })
    })

    it("a link token minted for a DIFFERENT appId is refused on this route", async () => {
      await withServer(async (base, registry) => {
        const target = spawnSession(registry)
        const { token: linkToken } = mintAppLinkToken({
          appId: "@some/other-app",
          claims: { sessionId: target.id, telegramUserId: "42" },
          ttlMs: 60_000,
          pendingTelegramAuth: true,
          keyPath,
        })
        const initData = signInitData(buildInitDataFields({ userId: 42 }), FAKE_BOT_TOKEN)
        const res = await fetch(`${base}/apps/${encodeURIComponent(APP_ID)}/link-auth`, {
          method: "POST",
          headers: { ...FORWARDED, "content-type": "application/json" },
          body: JSON.stringify({ linkToken, initData }),
        })
        expect(res.status).toBe(401)
      })
    })

    describe("browser Origin", () => {
      const TUNNEL_HOST = "abc-def.trycloudflare.com"
      const TUNNEL_HEADERS = {
        ...FORWARDED,
        "x-forwarded-host": TUNNEL_HOST,
        "x-forwarded-proto": "https",
        "content-type": "application/json",
      }

      async function exchange(
        base: string,
        registry: ReturnType<typeof createSessionsRegistry>,
        headers: Record<string, string>,
      ): Promise<Response> {
        const target = spawnSession(registry)
        const { token: linkToken } = mintAppLinkToken({
          appId: APP_ID,
          claims: { sessionId: target.id, telegramUserId: "42" },
          ttlMs: 60_000,
          pendingTelegramAuth: true,
          keyPath,
        })
        const initData = signInitData(buildInitDataFields({ userId: 42 }), FAKE_BOT_TOKEN)
        return fetch(`${base}/apps/${encodeURIComponent(APP_ID)}/link-auth`, {
          method: "POST",
          headers,
          body: JSON.stringify({ linkToken, initData }),
        })
      }

      it("accepts a same-origin browser POST (Origin equals the origin the request was reached at) and mints a usable session token", async () => {
        await withServer(async (base, registry) => {
          const res = await exchange(base, registry, { ...TUNNEL_HEADERS, origin: `https://${TUNNEL_HOST}` })
          expect(res.status).toBe(200)
          const body = (await res.json()) as { ok: boolean; token: string }
          expect(body.ok).toBe(true)
          const toolCall = await fetch(`${base}/apps/${encodeURIComponent(APP_ID)}/tool-call`, {
            method: "POST",
            headers: { ...FORWARDED, authorization: `Bearer ${body.token}`, "content-type": "application/json" },
            body: JSON.stringify({ tool: "conversation_read", args: {} }),
          })
          expect(toolCall.status).toBe(200)
        })
      })

      it("compares the host case-insensitively and ignores a default port", async () => {
        await withServer(async (base, registry) => {
          const res = await exchange(base, registry, {
            ...TUNNEL_HEADERS,
            origin: `https://${TUNNEL_HOST.toUpperCase()}:443`,
          })
          expect(res.status).toBe(200)
        })
      })

      it("still refuses a different cross-origin Origin with forbidden_origin", async () => {
        await withServer(async (base, registry) => {
          const res = await exchange(base, registry, { ...TUNNEL_HEADERS, origin: "https://evil.example" })
          expect(res.status).toBe(403)
          expect(((await res.json()) as { error: string }).error).toBe("forbidden_origin")
        })
      })

      it("still refuses an Origin that matches the host but not the scheme", async () => {
        await withServer(async (base, registry) => {
          const res = await exchange(base, registry, { ...TUNNEL_HEADERS, origin: `http://${TUNNEL_HOST}` })
          expect(res.status).toBe(403)
          expect(((await res.json()) as { error: string }).error).toBe("forbidden_origin")
        })
      })

      it("is unchanged without an Origin header", async () => {
        await withServer(async (base, registry) => {
          const res = await exchange(base, registry, TUNNEL_HEADERS)
          expect(res.status).toBe(200)
        })
      })

      it("does not extend the exemption to other guarded routes: a same-origin POST to /a2a/apps/:id still gets forbidden_origin", async () => {
        // strictOrigins drops the localhost defaults, so the loopback origin
        // this request is reached at is same-origin but not allowlisted.
        await withServer(
          async base => {
            const res = await fetch(`${base}/a2a/apps/${encodeURIComponent(APP_ID)}`, {
              method: "POST",
              headers: { origin: base, "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: {} }),
            })
            expect(res.status).toBe(403)
            expect(((await res.json()) as { error: string }).error).toBe("forbidden_origin")
          },
          { strictOrigins: true, allowedOrigins: [] },
        )
      })
    })
  })
})
