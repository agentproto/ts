/**
 * `session_screencast_frame` wiring:
 *
 *  - ONE reader per daemon: the HTTP route and the tool, booted through the
 *    real `createGateway`, share the 800 ms frame cache and the 2-capture cap,
 *    so a route request and a tool call for the same session make a single
 *    Bureau `browser_screenshot`, and two sessions never share a frame.
 *  - NO link-token path: a link-session token calling the tool through
 *    `POST /apps/:id/tool-call` is refused whether or not the app lists the
 *    tool in `ui.tools`, and the Bureau fake is never called.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer, type RuntimeHttpServerOptions } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createSessionsRegistry } from "../sessions.js"
import { createAppRegistry } from "../app-registry.js"
import { createSessionScreencastReader } from "../session-screencast.js"
import { McpProxyRegistry } from "../mcp-proxy.js"
import { mintAppLinkSessionToken, resetAppLinkSigningKeyCacheForTests } from "../app-link-token.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import type { TelegramBotCredsStore } from "../telegram-bot-creds.js"
import { FAKE_BOT_TOKEN } from "./helpers/telegram-init-data-fixture.js"

const TOOL = "session_screencast_frame"
const FRAME_A = Buffer.from("frame-of-session-a")
const FRAME_B = Buffer.from("frame-of-session-b")

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

const text = (value: unknown) => ({ type: "text", text: JSON.stringify(value) })

/** A Bureau stand-in: one open tab per session, a distinct frame per session. */
function bureauFor(frames: Record<string, Buffer>) {
  const calls: { tool: string; caller: string | undefined }[] = []
  const handle = async (tool: string, args: Record<string, unknown>, caller: string | undefined) => {
    calls.push({ tool, caller })
    if (tool === "browser_list_owned_tabs") {
      return { content: [text({ tabs: [{ targetId: `tab_${caller}`, openedAt: "2026-11-09T10:00:00Z" }] })] }
    }
    if (tool === "browser_screenshot") {
      const bytes = frames[caller ?? ""]
      if (!bytes) return { isError: true, content: [text({ code: "browser:target_gone" })] }
      expect(args.tabId).toBe(`tab_${caller}`)
      return { structuredContent: { base64: bytes.toString("base64"), format: "jpeg", width: 1, height: 1 } }
    }
    return { isError: true, content: [text({ code: "unexpected" })] }
  }
  const shots = () => calls.filter(c => c.tool === "browser_screenshot")
  return { calls, handle, shots }
}

describe("session_screencast_frame: one reader per daemon", () => {
  let home = ""

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "screencast-frame-gw-"))
    vi.stubEnv("HOME", home)
    vi.stubEnv("AGENTPROTO_HOME", join(home, ".agentproto"))
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("serves the route and the tool from one cache and one capture cap", async () => {
    const { createGateway } = await import("../index.js")
    const bureau = bureauFor({ sess_a: FRAME_A, sess_b: FRAME_B })
    vi.spyOn(McpProxyRegistry.prototype, "callTool").mockImplementation((async (
      _alias: string,
      tool: string,
      args: Record<string, unknown>,
      context?: { callerSessionId?: string },
    ) => ({ ok: true, result: await bureau.handle(tool, args, context?.callerSessionId) })) as never)

    const workspace = await mkdtemp(join(home, "ws-"))
    const gateway = await createGateway({
      workspace,
      specs: [],
      port: await freePort(),
      boot: false,
      persist: false,
      persistPath: join(workspace, "sessions.json"),
    })
    try {
      const client = new Client({ name: "screencast-frame", version: "0" }, { capabilities: {} })
      await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp`)))
      expect((await client.listTools()).tools.map(t => t.name)).toContain(TOOL)

      const viaRoute = await fetch(`${gateway.url}/sessions/sess_a/screencast.jpg`, {
        headers: { authorization: `Bearer ${gateway.token}` },
      })
      expect(viaRoute.status).toBe(200)
      expect(Buffer.from(await viaRoute.arrayBuffer()).equals(FRAME_A)).toBe(true)

      const viaTool = (await client.callTool({ name: TOOL, arguments: { sessionId: "sess_a" } })) as unknown as {
        content: { type: string; data: string; mimeType: string }[]
      }
      expect(viaTool.content).toHaveLength(1)
      expect(viaTool.content[0]?.type).toBe("image")
      expect(viaTool.content[0]?.mimeType).toBe("image/jpeg")
      expect(Buffer.from(viaTool.content[0]!.data, "base64").equals(FRAME_A)).toBe(true)
      expect(bureau.shots()).toHaveLength(1)

      const other = (await client.callTool({ name: TOOL, arguments: { sessionId: "sess_b" } })) as unknown as {
        content: { data: string }[]
      }
      expect(Buffer.from(other.content[0]!.data, "base64").equals(FRAME_B)).toBe(true)
      expect(bureau.shots().map(s => s.caller)).toEqual(["sess_a", "sess_b"])
      await client.close()

      // The agent-scoped gateway (`/mcp/orchestrator`) never lists the tool.
      const scope = gateway.mintOrchestratorScope()
      const scoped = new Client({ name: "screencast-frame-scoped", version: "0" }, { capabilities: {} })
      await scoped.connect(
        new StreamableHTTPClientTransport(
          new URL(`${gateway.url}/mcp/orchestrator?scope=${encodeURIComponent(scope.token)}`),
        ),
      )
      const scopedTools = (await scoped.listTools()).tools.map(t => t.name)
      expect(scopedTools.length).toBeGreaterThan(0)
      expect(scopedTools).not.toContain(TOOL)
      await scoped.close()
    } finally {
      await gateway.stop()
    }
  })
})

describe("session_screencast_frame: no link-token path", () => {
  let dir: string | undefined

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
    resetAppLinkSigningKeyCacheForTests()
  })

  const LISTED_APP = "@test/lists-screencast"
  const UNLISTED_APP = "@test/omits-screencast"
  const FORWARDED = { "x-forwarded-for": "203.0.113.7" }

  async function withServer(
    fn: (ctx: {
      base: string
      keyPath: string
      dispatchTool: ReturnType<typeof vi.fn>
      bureau: ReturnType<typeof bureauFor>
    }) => Promise<void>,
  ): Promise<void> {
    dir = await mkdtemp(join(tmpdir(), "agentproto-screencast-frame-link-"))
    const keyPath = join(dir, "app_link_hmac")
    const bureau = bureauFor({ sess_a: FRAME_A })
    const sessionScreencast = createSessionScreencastReader({
      callImportedTool: async (_alias, tool, args, caller) => bureau.handle(tool, args, caller),
      resolveAlias: async () => "bureau",
    })
    const dispatchTool = vi.fn(async () => ({ ok: true }))
    const appRegistry = createAppRegistry()
    const base = {
      dir,
      agents: [],
      workflows: [],
      unvalidatedAgentTools: [],
    }
    appRegistry.upsertApp({
      ...base,
      appId: LISTED_APP,
      ui: {
        path: join(dir, "ui.html"),
        tools: ["conversation_read", TOOL],
        toolScope: { conversation_read: { sessionId: "$link.sessionId" } },
      },
    })
    appRegistry.upsertApp({
      ...base,
      appId: UNLISTED_APP,
      ui: {
        path: join(dir, "ui.html"),
        tools: ["conversation_read"],
        toolScope: { conversation_read: { sessionId: "$link.sessionId" } },
      },
    })
    const port = await freePort()
    const opts: RuntimeHttpServerOptions = {
      port,
      auth: { mode: "bearer", token: "tunnel-bearer-secret" },
      mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
      conversations: noopConversations(),
      events: createRuntimeEvents(),
      heartbeat: noopHeartbeat(),
      meta: { workspace: process.cwd(), registered: [] },
      sessions: createSessionsRegistry({ persist: false }),
      appRegistry,
      appToolCallDeps: {
        dispatchTool: dispatchTool as never,
        callImportedTool: async (_alias, tool, args, caller) => bureau.handle(tool, args, caller),
      },
      sessionScreencast,
      telegramCreds: fakeTelegramCreds(FAKE_BOT_TOKEN),
      appLinkKeyPath: keyPath,
    }
    const http = await startHttpServer(opts)
    try {
      await fn({ base: `http://127.0.0.1:${port}`, keyPath, dispatchTool, bureau })
    } finally {
      await http.stop()
    }
  }

  const linkToken = (appId: string, sessionId: string, keyPath: string) =>
    mintAppLinkSessionToken({ appId, claims: { sessionId, telegramUserId: "42" }, ttlMs: 60_000, keyPath }).token

  const callTool = (base: string, appId: string, headers: Record<string, string>, sessionId: string) =>
    fetch(`${base}/apps/${encodeURIComponent(appId)}/tool-call`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ tool: TOOL, args: { sessionId } }),
    })

  const refused = async (res: Response): Promise<boolean> => {
    if (res.status >= 400) return true
    const body = (await res.json()) as { isError?: boolean }
    return body.isError === true
  }

  for (const [label, appId] of [
    ["an app that lists the tool in ui.tools", LISTED_APP],
    ["an app that does not list it", UNLISTED_APP],
  ] as const) {
    it(`refuses a link-session token calling it through ${label}, for its own and any other session`, async () => {
      await withServer(async ({ base, keyPath, dispatchTool, bureau }) => {
        const headers = { ...FORWARDED, authorization: `Bearer ${linkToken(appId, "sess_a", keyPath)}` }
        expect(await refused(await callTool(base, appId, headers, "sess_a"))).toBe(true)
        expect(await refused(await callTool(base, appId, headers, "sess_b"))).toBe(true)
        expect(dispatchTool).not.toHaveBeenCalled()
        expect(bureau.calls).toEqual([])
      })
    })
  }

  it("still admits the operator (bearer) through an app that lists the tool in ui.tools", async () => {
    await withServer(async ({ base, dispatchTool }) => {
      const res = await callTool(base, LISTED_APP, { authorization: "Bearer tunnel-bearer-secret" }, "sess_a")
      expect(res.status).toBe(200)
      expect(dispatchTool).toHaveBeenCalledTimes(1)
    })
  })

  it("keeps the route behavior: a link token still reads the frame of its own session over HTTP", async () => {
    await withServer(async ({ base, keyPath, bureau }) => {
      const headers = { ...FORWARDED, authorization: `Bearer ${linkToken(LISTED_APP, "sess_a", keyPath)}` }
      const res = await fetch(`${base}/sessions/sess_a/screencast.jpg`, { headers })
      expect(res.status).toBe(200)
      expect(Buffer.from(await res.arrayBuffer()).equals(FRAME_A)).toBe(true)
      expect(bureau.shots()).toHaveLength(1)
    })
  })
})

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

function fakeTelegramCreds(token: string): TelegramBotCredsStore {
  return {
    read: async alias => (alias === "default" ? { token } : null),
    write: async () => {},
    exists: async alias => alias === "default",
  }
}
