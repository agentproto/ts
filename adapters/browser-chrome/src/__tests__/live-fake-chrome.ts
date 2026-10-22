// An in-process stand-in for a user's running Chrome with the remote debugging toggle on:
// by default only the id-less browser websocket answers and HTTP /json/* answers empty
// (pre-155). Set `browserId` to emulate Chrome 155+: /json/version advertises a
// `/devtools/browser/<uuid>` URL and the id-less path answers 404.
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
  /** `Runtime.evaluate("document.documentElement.outerHTML")` answers with this. Default a minimal page. */
  domHtml?: string
  /** `Runtime.evaluate("document.title")` answers with this. Default "". */
  domTitle?: string
  /** Simulate "no element matches selector" for click/fill/scroll's generated `querySelector` expressions. */
  selectorMissing?: boolean
  /** Simulate the uploadFile selector not matching an `<input type=file>`. */
  fileInputMissing?: boolean
  /** `Runtime.evaluate("document.location.href")` answers with this (simulating a committed URL that differs from the requested one, e.g. a redirect). Unset: falls through to the generic unmatched-expression default. */
  locationHref?: string
  /** Chrome 155+ browser UUID: /json/version advertises `/devtools/browser/<id>` and the id-less path answers 404. */
  browserId?: string
  /** `browser_wait_for` polling: number of false answers before the condition matches. Default 0 (matches at once); use a large number to exercise a timeout. */
  waitMisses?: number
  /** Simulated `<select>` options for `browser_select`. */
  selectOptions?: Array<{ value: string; label: string }>
  /** Simulated current `<select>` value; defaults to the first option. */
  selectValue?: string
}

export interface FakeChrome {
  port: number
  wsUrl: string
  /** Websocket connections opened so far (each one is a consent dialog on real Chrome). */
  connections: number
  /** Plain HTTP requests (`/json/*`) received. */
  httpRequests: number
  commands: FakeCommand[]
  /** Commands that addressed a target the client did not create. */
  violations: FakeCommand[]
  /** Page.screencastFrameAck payloads received, with the CDP session they rode on. */
  acknowledgments: Array<{ sessionId?: string; params: Record<string, unknown> }>
  userTargets: readonly string[]
  /** Targets alive now, with their window. */
  targets: Map<string, { windowId: number; url: string; created: boolean }>
  /** Files passed to every DOM.setFileInputFiles, per selector (the fake records instead of touching a real input). */
  filesAttached: Map<string, string[]>
  /** Key presses (Input.dispatchKeyEvent) seen, in order. */
  keyEvents: Array<Record<string, unknown>>
  options: FakeChromeOptions
  /** Emit a Page.screencastFrame event into an open flat session (test hook). */
  emitScreencastFrame(
    cdpSessionId: string,
    frame: { data: string; sessionId?: string; deviceWidth?: number; deviceHeight?: number },
  ): void
  /** Whether Page.startScreencast (without a following stop) was seen for this CDP session. */
  screencastActive(sessionId: string): boolean
  dropAll(): void
  close(): Promise<void>
}

const USER_WINDOW = 1
export async function startFakeChrome(options: FakeChromeOptions = {}): Promise<FakeChrome> {
  const server: Server = createServer((_req, res) => {
    fake.httpRequests++
    // Pre-155: the toggle answers HTTP with an empty body. 155+: /json/version
    // advertises the per-launch browser UUID.
    if (fake.options.browserId) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ Browser: "Chrome/155.0.0.0", webSocketDebuggerUrl: fake.wsUrl }))
      return
    }
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
  // CDP sessions with Page.startScreencast seen and not stopped.
  const screencastActiveSessions = new Set<string>()
  // Selector → nodeId map for the DOM.* uploadFile commands.
  const fileInputNodes = new Map<string, number>()
  let nextNodeId = 100
  // Server-initiated sends, added when a websocket connects (frames can arrive
  // at any moment in real Chrome; the same shape here).
  const senders = new Set<(raw: string) => void>()
  const fake: FakeChrome = {
    port: 0,
    wsUrl: "",
    connections: 0,
    httpRequests: 0,
    commands: [],
    violations: [],
    acknowledgments: [],
    userTargets: ["user-tab-1", "user-tab-2"],
    targets: new Map([
      ["user-tab-1", { windowId: USER_WINDOW, url: "https://mail.example/", created: false }],
      ["user-tab-2", { windowId: USER_WINDOW, url: "https://bank.example/", created: false }],
    ]),
    filesAttached: new Map(),
    keyEvents: [],
    options,
    emitScreencastFrame(cdpSessionId, frame) {
      for (const send of senders) {
        send(
          JSON.stringify({
            method: "Page.screencastFrame",
            sessionId: cdpSessionId,
            params: {
              data: frame.data,
              // Real Chrome puts a frame identifier in params.sessionId; the
              // ack echoes it back (this is NOT the flat session's id).
              sessionId: frame.sessionId ?? "frame-1",
              ...(frame.deviceWidth !== undefined || frame.deviceHeight !== undefined
                ? { metadata: { deviceWidth: frame.deviceWidth ?? 0, deviceHeight: frame.deviceHeight ?? 0 } }
                : {}),
            },
          })
        )
      }
    },
    screencastActive(sessionId) {
      return screencastActiveSessions.has(sessionId)
    },
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

  const browserPath = fake.options.browserId ? `/devtools/browser/${fake.options.browserId}` : "/devtools/browser"
  const wss = new WebSocketServer({
    server,
    path: browserPath,
    verifyClient: (_info, cb) => {
      const mode = fake.options.consent ?? "allow"
      if (mode === "hold") return
      if (mode === "reject") return cb(false, 403, "Forbidden")
      cb(true)
    },
  })

  // Chrome 155 answers 404 for the id-less browser URL: only the UUID path exists.
  server.on("upgrade", (req, socket) => {
    if (req.url !== browserPath) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")
      socket.destroy()
    }
  })

  wss.on("connection", (ws) => {
    fake.connections++
    sockets.add(ws)
    ws.on("close", () => sockets.delete(ws))
    senders.add((raw2) => ws.send(raw2))
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
        case "Page.navigate": {
          const navUrl = String(msg.params?.url ?? "")
          const navTargetId = msg.sessionId?.replace(/^session-/, "")
          const t = navTargetId ? fake.targets.get(navTargetId) : undefined
          if (t) t.url = navUrl
          reply(msg.id, msg.sessionId, {})
          return emit("Page.lifecycleEvent", { name: "load" }, msg.sessionId)
        }
        case "Runtime.evaluate": {
          const expression = String(msg.params?.expression ?? "")
          if (expression === "document.documentElement.outerHTML") {
            return reply(msg.id, msg.sessionId, { result: { type: "string", value: fake.options.domHtml ?? "<html><body>hi</body></html>" } })
          }
          if (expression === "document.title") {
            return reply(msg.id, msg.sessionId, { result: { type: "string", value: fake.options.domTitle ?? "" } })
          }
          if (expression === "document.location.href" && fake.options.locationHref !== undefined) {
            return reply(msg.id, msg.sessionId, { result: { type: "string", value: fake.options.locationHref } })
          }
          // click's centerOf: the selector's bounding-box center.
          if (expression.includes("r.width / 2")) {
            return reply(msg.id, msg.sessionId, {
              result: fake.options.selectorMissing
                ? { type: "object", value: null }
                : { type: "object", value: { x: 10, y: 20 } },
            })
          }
          // pressKey's focus-first helper.
          if (expression.includes("__chromeLiveFocus")) {
            return reply(msg.id, msg.sessionId, { result: { type: "boolean", value: !fake.options.selectorMissing } })
          }
          // select's generated expression.
          if (expression.includes("__chromeLiveSelect")) {
            if (fake.options.selectorMissing) {
              return reply(msg.id, msg.sessionId, { result: { type: "object", value: { ok: false, reason: "no-selector" } } })
            }
            const options = fake.options.selectOptions ?? [{ value: "a", label: "Alpha" }, { value: "b", label: "Bravo" }]
            const wanted = fake.options.selectValue ?? options[0]?.value ?? ""
            const index = options.findIndex((o) => o.value === wanted)
            return reply(msg.id, msg.sessionId, {
              result: {
                type: "object",
                value: index >= 0
                  ? { ok: true, value: wanted, label: options[index]?.label, index }
                  : { ok: false, reason: "no-option", options },
              },
            })
          }
          // waitFor's generated polling expression.
          if (expression.includes("__chromeLiveWait")) {
            const misses = fake.options.waitMisses ?? 0
            if (misses > 0) {
              fake.options.waitMisses = misses - 1
              return reply(msg.id, msg.sessionId, { result: { type: "object", value: { ok: false } } })
            }
            return reply(msg.id, msg.sessionId, { result: { type: "object", value: { ok: true, state: "visible" } } })
          }
          // fill's focus-and-select, and scroll's scrollIntoView: both are
          // IIFEs that return false when the selector matches nothing.
          if (expression.includes("el.focus()") || expression.includes("scrollIntoView")) {
            return reply(msg.id, msg.sessionId, { result: { type: "boolean", value: !fake.options.selectorMissing } })
          }
          // uploadFile's "is this selector an <input type=file>?" probe.
          if (expression.includes('el.type === "file"')) {
            return reply(msg.id, msg.sessionId, {
              result: { type: "boolean", value: !fake.options.fileInputMissing && !fake.options.selectorMissing },
            })
          }
          return reply(msg.id, msg.sessionId, { result: { type: "boolean", value: false } })
        }
        case "DOM.getDocument":
          return reply(msg.id, msg.sessionId, { root: { nodeId: 12 } })
        case "DOM.querySelector": {
          const selector = String(msg.params?.selector ?? "")
          if (fake.options.fileInputMissing || fake.options.selectorMissing) {
            fileInputNodes.delete(selector)
            return reply(msg.id, msg.sessionId, { nodeId: 0 })
          }
          fileInputNodes.set(selector, nextNodeId)
          return reply(msg.id, msg.sessionId, { nodeId: nextNodeId })
        }
        case "DOM.setFileInputFiles": {
          const selector = [...fileInputNodes.entries()].find(([, node]) => node === msg.params?.nodeId)?.[0] ?? String(msg.params?.nodeId)
          fake.filesAttached.set(
            selector,
            [...(fake.filesAttached.get(selector) ?? []), ...((msg.params?.files as string[]) ?? [])],
          )
          return reply(msg.id, msg.sessionId, {})
        }
        case "Input.dispatchKeyEvent":
          fake.keyEvents.push((msg.params ?? {}) as Record<string, unknown>)
          return reply(msg.id, msg.sessionId, {})
        case "Page.getLayoutMetrics":
          return reply(msg.id, msg.sessionId, { cssVisualViewport: { clientWidth: 1, clientHeight: 1 } })
        case "Page.captureScreenshot":
          return reply(msg.id, msg.sessionId, { data: "AAAA" })
        case "Page.startScreencast":
          if (msg.sessionId) screencastActiveSessions.add(msg.sessionId)
          return reply(msg.id, msg.sessionId, {})
        case "Page.stopScreencast":
          if (msg.sessionId) screencastActiveSessions.delete(msg.sessionId)
          return reply(msg.id, msg.sessionId, {})
        case "Page.screencastFrameAck":
          fake.acknowledgments.push({
            ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
            params: (msg.params ?? {}) as Record<string, unknown>,
          })
          return reply(msg.id, msg.sessionId, {})
        default:
          return reply(msg.id, msg.sessionId, {})
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  fake.port = (server.address() as AddressInfo).port
  fake.wsUrl = `ws://127.0.0.1:${fake.port}${browserPath}`
  return fake
}
