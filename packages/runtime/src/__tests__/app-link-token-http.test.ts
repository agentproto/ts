/**
 * AIP-53 link-token scoping over the real HTTP surface: a Telegram-gated
 * link token, once exchanged via `POST /apps/:appId/link-auth`, widens
 * `tunnelBearerAllowed` (http-server.ts) ONLY for its own app's tool-call
 * route and its own session's three read routes — everything else (a
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

import { startHttpServer, type RuntimeHttpServerOptions } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createSessionsRegistry } from "../sessions.js"
import type { PtyFactory, PtyProcess } from "../sessions.js"
import { createAppRegistry, type AppRegistry } from "../app-registry.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import { mintAppLinkToken, mintAppLinkSessionToken, resetAppLinkSigningKeyCacheForTests } from "../app-link-token.js"
import { resetAppLinkAuthStateForTests } from "../app-link-auth.js"
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
    resetAppLinkAuthStateForTests()
  })

  async function withServer(
    fn: (base: string, registry: ReturnType<typeof createSessionsRegistry>) => Promise<void>,
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
        tools: ["conversation_read"],
        toolScope: { conversation_read: { sessionId: "$link.sessionId" } },
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

  it("a link-session token grants NOTHING beyond the three read routes + its own tool-call: /mcp, kill, and the PTY route stay gated", async () => {
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
  })
})
