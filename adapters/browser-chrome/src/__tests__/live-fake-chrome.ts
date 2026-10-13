// An in-process stand-in for a user's running Chrome with the remote debugging toggle on:
// only the id-less browser websocket answers, HTTP /json/* answers empty, and it already has user tabs.
import { createServer, type Server } from "node:http"
import type { AddressInfo, Socket } from "node:net"
import { WebSocketServer, type WebSocket } from "ws"

export interface FakeCommand {
  method: string
  params?: Record<string, unknown>
  sessionId?: string
}

export interface FakeChromeOptions {
  /** "allow": answers at once; "hold": the handshake never completes; "reject": 403; "silent": opens but never answers. */
  consent?: "allow" | "hold" | "reject" | "silent"
  /** After Target.activateTarget, focus jumps back to the user's window (a user clicking elsewhere). */
  stealFocus?: boolean
}

export interface FakeChrome {
  port: number
  wsUrl: string
  /** Websocket connections opened so far (each one is a consent dialog on real Chrome). */
  connections: number
  commands: FakeCommand[]
  /** Commands that addressed a target the client did not create. */
  violations: FakeCommand[]
  userTargets: readonly string[]
  /** Targets alive now, with their window. */
  targets: Map<string, { windowId: number; url: string; created: boolean }>
  options: FakeChromeOptions
  dropAll(): void
  close(): Promise<void>
}

const USER_WINDOW = 1

export async function startFakeChrome(options: FakeChromeOptions = {}): Promise<FakeChrome> {
  const server: Server = createServer((_req, res) => {
    // The toggle answers HTTP with an empty body.
    res.writeHead(200).end()
  })
  const sockets = new Set<WebSocket>()
  // Upgrade sockets held in verifyClient are not tracked by closeAllConnections.
  const raw = new Set<Socket>()
  server.on("connection", (socket) => {
    raw.add(socket)
    socket.once("close", () => raw.delete(socket))
  })
  const created = new Set<string>()
  let nextTarget = 0
  let nextWindow = 100
  let lastActiveWindow = USER_WINDOW
  const fake: FakeChrome = {
    port: 0,
    wsUrl: "",
    connections: 0,
    commands: [],
    violations: [],
    userTargets: ["user-tab-1", "user-tab-2"],
    targets: new Map([
      ["user-tab-1", { windowId: USER_WINDOW, url: "https://mail.example/", created: false }],
      ["user-tab-2", { windowId: USER_WINDOW, url: "https://bank.example/", created: false }],
    ]),
    options,
    dropAll() {
      for (const ws of sockets) ws.terminate()
    },
    async close() {
      fake.dropAll()
      wss.close()
      server.closeAllConnections()
      for (const socket of raw) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }

  const wss = new WebSocketServer({
    server,
    path: "/devtools/browser",
    verifyClient: (_info, cb) => {
      const mode = fake.options.consent ?? "allow"
      if (mode === "hold") return
      if (mode === "reject") return cb(false, 403, "Forbidden")
      cb(true)
    },
  })

  wss.on("connection", (ws) => {
    fake.connections++
    sockets.add(ws)
    ws.on("close", () => sockets.delete(ws))
    const reply = (id: number, sessionId: string | undefined, result: unknown): void =>
      ws.send(JSON.stringify({ id, ...(sessionId ? { sessionId } : {}), result }))
    const fail = (id: number, message: string): void => ws.send(JSON.stringify({ id, error: { code: -32000, message } }))
    const emit = (method: string, params: unknown, sessionId?: string): void =>
      ws.send(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }))
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as FakeCommand & { id: number }
      fake.commands.push({ method: msg.method, ...(msg.params ? { params: msg.params } : {}), ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) })
      if ((fake.options.consent ?? "allow") === "silent") return
      const targetId = msg.params?.targetId as string | undefined
      if (targetId !== undefined && !created.has(targetId)) fake.violations.push(msg)
      if (msg.sessionId && !created.has(msg.sessionId.replace(/^session-/, ""))) fake.violations.push(msg)
      switch (msg.method) {
        case "Browser.getVersion":
          return reply(msg.id, undefined, { product: "Chrome/155.0.0.0", protocolVersion: "1.3" })
        case "Target.createTarget": {
          const id = `agent-target-${++nextTarget}`
          created.add(id)
          const windowId = msg.params?.newWindow ? ++nextWindow : lastActiveWindow
          lastActiveWindow = windowId
          fake.targets.set(id, { windowId, url: String(msg.params?.url ?? ""), created: true })
          return reply(msg.id, undefined, { targetId: id })
        }
        case "Target.activateTarget": {
          const t = targetId ? fake.targets.get(targetId) : undefined
          if (!t) return fail(msg.id, "No target with given id found")
          lastActiveWindow = fake.options.stealFocus ? USER_WINDOW : t.windowId
          return reply(msg.id, undefined, {})
        }
        case "Browser.getWindowForTarget": {
          const t = targetId ? fake.targets.get(targetId) : undefined
          if (!t) return fail(msg.id, "No target with given id found")
          return reply(msg.id, undefined, { windowId: t.windowId, bounds: {} })
        }
        case "Target.attachToTarget":
          if (!targetId || !fake.targets.has(targetId)) return fail(msg.id, "No target with given id found")
          return reply(msg.id, undefined, { sessionId: `session-${targetId}` })
        case "Target.closeTarget":
          if (!targetId || !fake.targets.delete(targetId)) return fail(msg.id, "No target with given id found")
          reply(msg.id, undefined, { success: true })
          return emit("Target.detachedFromTarget", { sessionId: `session-${targetId}`, targetId })
        case "Runtime.evaluate":
          return reply(msg.id, msg.sessionId, { result: { type: "boolean", value: false } })
        default:
          return reply(msg.id, msg.sessionId, {})
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  fake.port = (server.address() as AddressInfo).port
  fake.wsUrl = `ws://127.0.0.1:${fake.port}/devtools/browser`
  return fake
}
