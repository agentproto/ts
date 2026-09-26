/**
 * P0 tunnel-auth fix (PHONE-PLAN.md "P0: security fix"): once the daemon is
 * in bearer mode (`remote_enable`'s in-memory token, or a static
 * `auth:{mode:"bearer"}`), every NON-loopback request must present that
 * exact bearer — an allowlisted `Origin` header (which `curl` can forge
 * freely once a request has crossed a public tunnel) must never substitute
 * for it. Before this fix:
 *   - `GET /sessions` and its SSE stream had no gate at all.
 *   - Mutating `/sessions/*` routes (and the PTY WS upgrade) accepted a
 *     forged `Origin: https://cli.agentproto.sh` with no token whatsoever
 *     (`checkSessionsToken`'s Origin-allowlist branch, which is a browser-
 *     CSRF proof, not a bearer substitute over the network).
 *
 * This suite simulates the tunnel boundary the way the daemon itself
 * detects it (`isLoopback`): a request whose socket is loopback but which
 * carries a proxy-forwarding header (`X-Forwarded-For`, matching what
 * cloudflared adds) is treated as having crossed the network, exactly as
 * documented in loopback-bypass-forwarding.test.ts. No real tunnel needed.
 *
 * `opts.token` (the separate per-boot `/sessions` token, gated by
 * `checkSessionsToken`) is deliberately left UNSET here so its own
 * Origin-allowlist branch can't mask what's being tested: the NEW gate this
 * fix adds (`tunnelBearerAllowed`), in isolation.
 */

import { afterEach, describe, expect, it } from "vitest"
import { createHmac } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import WebSocket from "ws"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer, type RuntimeHttpServerOptions } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createSessionsRegistry } from "../sessions.js"
import type { PtyFactory, PtyProcess, SessionDescriptor } from "../sessions.js"
import { createAppRegistry, type AppRegistry } from "../app-registry.js"
import { createInboundEndpointStore } from "../inbound-endpoints.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

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

/** Trivial PTY stub — no real shell, just enough for the registry to carry
 *  a `pty:true` session the /pty WS upgrade and /sessions/:id/stream + /kill
 *  routes can resolve by id. */
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

const BEARER = "tunnel-bearer-secret"
// The default allowlist entry a real attacker would forge — see
// DEFAULT_ALLOWED_ORIGINS in http-server.ts and PHONE-PLAN.md's P0 note
// ("spawn agents or PTYs by sending Origin: https://cli.agentproto.sh").
const FORGED_ORIGIN = "https://cli.agentproto.sh"
const FORWARDED = { "x-forwarded-for": "203.0.113.7" }

const INBOUND_SLUG = "wh1"
const INBOUND_SECRET = "whsec-12345"

type CredKind = "none" | "origin" | "bearer"

function credHeaders(kind: CredKind): Record<string, string> {
  switch (kind) {
    case "none":
      return {}
    case "origin":
      return { origin: FORGED_ORIGIN }
    case "bearer":
      return { authorization: `Bearer ${BEARER}` }
  }
}

function withNetwork(
  forwarded: boolean,
  headers: Record<string, string>,
): Record<string, string> {
  return forwarded ? { ...headers, ...FORWARDED } : headers
}

describe("P0 tunnel-auth gate", () => {
  let dir: string
  let appRegistry: AppRegistry

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  async function withServer(
    fn: (base: string, port: number, registry: ReturnType<typeof createSessionsRegistry>) => Promise<void>,
  ): Promise<void> {
    dir = await mkdtemp(join(tmpdir(), "agentproto-tunnel-gate-"))
    const uiPath = join(dir, "ui.html")
    await writeFile(uiPath, "<!doctype html><html><body>app-shell-marker</body></html>", "utf8")
    appRegistry = createAppRegistry()
    appRegistry.upsertApp({
      appId: "@agentproto/test-app",
      dir,
      agents: [],
      workflows: [],
      unvalidatedAgentTools: [],
      ui: { path: uiPath, title: "Test App" },
    })

    const endpointStore = createInboundEndpointStore({ persist: false })
    endpointStore.upsert({
      slug: INBOUND_SLUG,
      provider: "generic",
      alias: "tg",
      secret: INBOUND_SECRET,
      mode: "route",
      enabled: true,
    })

    const registry = createSessionsRegistry({ persist: false, spawnPty: fakePtyFactory() })
    const port = await freePort()
    const opts: RuntimeHttpServerOptions = {
      port,
      auth: { mode: "bearer", token: BEARER },
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
      appToolCallDeps: { dispatchTool: async () => "ok" },
      endpointStore,
      routeInboundMessage: async () => ({ action: "routed", sessionId: "s1" }),
    }
    const http = await startHttpServer(opts)
    try {
      await fn(`http://127.0.0.1:${port}`, port, registry)
    } finally {
      await http.stop()
      registry.shutdown()
    }
  }

  function spawnSession(registry: ReturnType<typeof createSessionsRegistry>): SessionDescriptor {
    return registry.spawnPty({
      workspaceSlug: "default",
      cwd: process.cwd(),
      argv: ["bash"],
      cols: 80,
      rows: 24,
    })
  }

  function signedInboundBody(): { body: string; signature: string } {
    const body = JSON.stringify({ channel: "tg", from: "user1", text: "hi" })
    const signature = `sha256=${createHmac("sha256", INBOUND_SECRET).update(body).digest("hex")}`
    return { body, signature }
  }

  /** GET `path`; a stream that isn't rejected outright (`/sessions/:id/stream`
   *  writes its headers but no bytes until a 25s keep-alive ping — see its
   *  handler in http-server.ts) never resolves within the short timeout, so
   *  treat that timeout as "accepted" rather than waiting out the real
   *  interval. A blocked (401) request always resolves immediately either
   *  way, so the two outcomes stay cleanly distinguishable. */
  async function probeGet(
    base: string,
    path: string,
    headers: Record<string, string>,
  ): Promise<number> {
    try {
      const res = await fetch(`${base}${path}`, {
        headers,
        signal: AbortSignal.timeout(300),
      })
      return res.status
    } catch {
      return 200
    }
  }

  function connectPty(
    port: number,
    id: string,
    headers: Record<string, string>,
  ): Promise<number | "open"> {
    return connectPtyUrl(port, `/sessions/${id}/pty`, headers)
  }

  function connectPtyUrl(
    port: number,
    pathAndQuery: string,
    headers: Record<string, string>,
  ): Promise<number | "open"> {
    return new Promise(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${pathAndQuery}`, { headers })
      ws.once("open", () => {
        resolve("open")
        ws.close()
      })
      ws.once("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? -1)
        res.resume()
      })
      ws.once("error", () => {
        // Some socket-level rejections surface as a plain error instead of
        // unexpected-response — treat as blocked.
        resolve(-1)
      })
    })
  }

  it("loopback: every route family is unaffected regardless of credentials", async () => {
    await withServer(async (base, port, registry) => {
      for (const kind of ["none", "origin", "bearer"] as const) {
        const headers = credHeaders(kind)
        // Fresh sessions per iteration: the mutating /kill check below
        // actually kills its target on loopback (nothing blocks it), so
        // reusing one id across iterations — or with the pty target below —
        // would 410 on the second touch instead of proving the gate is a
        // no-op.
        const killTarget = spawnSession(registry)
        const ptyTarget = spawnSession(registry)

        expect((await fetch(`${base}/health`, { headers })).status).toBe(200)
        expect((await fetch(`${base}/sessions`, { headers })).status).toBe(200)
        expect((await fetch(`${base}/conversations`, { headers })).status).toBe(200)
        expect(await probeGet(base, `/sessions/${killTarget.id}/stream`, headers)).not.toBe(401)

        const kill = await fetch(`${base}/sessions/${killTarget.id}/kill`, {
          method: "POST",
          headers,
        })
        expect(kill.status).not.toBe(401)

        const ui = await fetch(`${base}/apps/@agentproto/test-app/ui`, { headers })
        expect(ui.status).toBe(200)

        expect(await connectPty(port, ptyTarget.id, headers)).toBe("open")
      }
    })
  })

  it("forwarded + no token: every gated route family is rejected; exemptions still pass", async () => {
    await withServer(async (base, port, registry) => {
      const target = spawnSession(registry)
      const headers = withNetwork(true, credHeaders("none"))

      // /health — always exempt.
      expect((await fetch(`${base}/health`, { headers })).status).toBe(200)

      // GET /sessions — previously had NO gate at all.
      expect((await fetch(`${base}/sessions`, { headers })).status).toBe(401)

      // SSE stream — previously had NO gate at all.
      expect(await probeGet(base, `/sessions/${target.id}/stream`, headers)).toBe(401)

      // /conversations GET.
      expect((await fetch(`${base}/conversations`, { headers })).status).toBe(401)

      // Mutating /sessions/* route — blocked before it ever reaches
      // registry.kill, so `target` is still alive for the checks below.
      const kill = await fetch(`${base}/sessions/${target.id}/kill`, {
        method: "POST",
        headers,
      })
      expect(kill.status).toBe(401)

      // PTY WS upgrade.
      expect(await connectPty(port, target.id, headers)).toBe(401)

      // /mcp.
      const mcp = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
      expect(mcp.status).toBe(401)

      // GET /apps/:appId/ui — exempt (static shell, phone loads it pre-token).
      const ui = await fetch(`${base}/apps/@agentproto/test-app/ui`, { headers })
      expect(ui.status).toBe(200)
      expect(await ui.text()).toContain("app-shell-marker")

      // POST /apps/:appId/tool-call — NOT exempt (an API under the shell).
      const toolCall = await fetch(`${base}/apps/@agentproto/test-app/tool-call`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ tool: "x", args: {} }),
      })
      expect(toolCall.status).toBe(401)

      // /inbound (legacy, no slug, no independent secret) — NOT exempt.
      const inboundLegacy = await fetch(`${base}/inbound`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ alias: "tg", source: "s", contact_ref: "u1", text: "hi" }),
      })
      expect(inboundLegacy.status).toBe(401)

      // /inbound/:slug — exempt: its own HMAC signature is the credential.
      const { body, signature } = signedInboundBody()
      const inboundSlug = await fetch(`${base}/inbound/${INBOUND_SLUG}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", "x-agentproto-signature": signature },
        body,
      })
      expect(inboundSlug.status).toBe(200)

      // /inbound/:slug WITHOUT a valid signature still fails (its own gate,
      // not the tunnel bearer) — proves the exemption isn't a blanket bypass.
      const inboundSlugBad = await fetch(`${base}/inbound/${INBOUND_SLUG}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body,
      })
      expect(inboundSlugBad.status).toBe(401)
    })
  })

  it("forwarded + forged allowlisted Origin only: still rejected (the actual vulnerability)", async () => {
    await withServer(async (base, port, registry) => {
      const target = spawnSession(registry)
      const headers = withNetwork(true, credHeaders("origin"))

      // Before this fix, a forged Origin alone satisfied checkSessionsToken's
      // Origin-allowlist branch and guardBrowserOrigin's pass-through, with no
      // bearer at all. Now the central gate blocks all of these first.
      expect((await fetch(`${base}/sessions`, { headers })).status).toBe(401)
      expect(await probeGet(base, `/sessions/${target.id}/stream`, headers)).toBe(401)
      expect((await fetch(`${base}/conversations`, { headers })).status).toBe(401)

      const kill = await fetch(`${base}/sessions/${target.id}/kill`, {
        method: "POST",
        headers,
      })
      expect(kill.status).toBe(401)

      expect(await connectPty(port, target.id, headers)).toBe(401)

      const mcp = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
      expect(mcp.status).toBe(401)

      // The static shell still loads (exempt) even with a forged Origin.
      const ui = await fetch(`${base}/apps/@agentproto/test-app/ui`, { headers })
      expect(ui.status).toBe(200)

      // But the API beneath it does not.
      const toolCall = await fetch(`${base}/apps/@agentproto/test-app/tool-call`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ tool: "x", args: {} }),
      })
      expect(toolCall.status).toBe(401)

      // /health is always exempt.
      expect((await fetch(`${base}/health`, { headers })).status).toBe(200)
    })
  })

  it("forwarded + valid bearer: every route family is allowed", async () => {
    await withServer(async (base, port, registry) => {
      const streamTarget = spawnSession(registry)
      const killTarget = spawnSession(registry)
      const ptyTarget = spawnSession(registry)
      const headers = withNetwork(true, credHeaders("bearer"))

      expect((await fetch(`${base}/health`, { headers })).status).toBe(200)
      expect((await fetch(`${base}/sessions`, { headers })).status).toBe(200)
      expect((await fetch(`${base}/conversations`, { headers })).status).toBe(200)
      expect(await probeGet(base, `/sessions/${streamTarget.id}/stream`, headers)).not.toBe(401)

      const kill = await fetch(`${base}/sessions/${killTarget.id}/kill`, {
        method: "POST",
        headers,
      })
      expect(kill.status).not.toBe(401)

      expect(await connectPty(port, ptyTarget.id, headers)).toBe("open")

      const mcp = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
      expect(mcp.status).not.toBe(401)

      const ui = await fetch(`${base}/apps/@agentproto/test-app/ui`, { headers })
      expect(ui.status).toBe(200)

      const toolCall = await fetch(`${base}/apps/@agentproto/test-app/tool-call`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ tool: "x", args: {} }),
      })
      expect(toolCall.status).not.toBe(401)

      const inboundLegacy = await fetch(`${base}/inbound`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ alias: "tg", source: "s", contact_ref: "u1", text: "hi" }),
      })
      expect(inboundLegacy.status).not.toBe(401)

      // The bearer also works via ?token= — the WS-upgrade convenience form,
      // since a browser WebSocket can't set an Authorization header.
      const noHeaderButForwarded = withNetwork(true, {})
      const qsTarget = spawnSession(registry)
      const ptyQsGood = await connectPtyUrl(
        port,
        `/sessions/${qsTarget.id}/pty?token=${encodeURIComponent(BEARER)}`,
        noHeaderButForwarded,
      )
      expect(ptyQsGood).toBe("open")

      // A forwarded WS upgrade with neither header nor query bearer is still
      // rejected — the ?token= form isn't a blanket bypass, it's a spelling
      // of the same bearer.
      const ptyQsMissing = await connectPtyUrl(
        port,
        `/sessions/${qsTarget.id}/pty`,
        noHeaderButForwarded,
      )
      expect(ptyQsMissing).toBe(401)
    })
  })
})
