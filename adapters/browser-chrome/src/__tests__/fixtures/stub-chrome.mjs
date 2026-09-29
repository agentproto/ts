#!/usr/bin/env node
// A stand-in for the Chrome binary: records its argv, opens a DevTools port, and answers a minimal CDP.
import { appendFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join } from "node:path"
import { WebSocketServer } from "ws"

const args = process.argv.slice(2)
const dirArg = args.find((a) => a.startsWith("--user-data-dir="))
const dir = dirArg ? dirArg.slice("--user-data-dir=".length) : undefined
const logFile = process.env.STUB_CHROME_LOG
const record = (entry) => {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`)
}
record({ kind: "argv", args })
if (!dir) process.exit(2)

const server = createServer((req, res) => {
  if (req.url === "/json/version") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ Browser: "StubChrome/1.0" }))
  } else {
    res.writeHead(404).end()
  }
})
const wss = new WebSocketServer({ server, path: "/devtools/browser/stub" })
let targets = 0

wss.on("connection", (ws) => {
  const reply = (id, sessionId, result) => ws.send(JSON.stringify({ id, ...(sessionId ? { sessionId } : {}), result }))
  const emit = (sessionId, method, params) => ws.send(JSON.stringify({ method, params, sessionId }))
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString())
    record({ kind: "cdp", method: msg.method, sessionId: msg.sessionId, params: msg.params })
    switch (msg.method) {
      case "Target.createTarget":
        return reply(msg.id, undefined, { targetId: `target-${++targets}` })
      case "Target.attachToTarget":
        return reply(msg.id, undefined, { sessionId: `session-${msg.params.targetId}` })
      case "Page.navigate":
        reply(msg.id, msg.sessionId, { frameId: "frame-1", loaderId: "loader-1" })
        emit(msg.sessionId, "Page.frameNavigated", { frame: { id: "frame-1", loaderId: "loader-1", url: msg.params.url } })
        for (const name of ["DOMContentLoaded", "load", "networkIdle"]) emit(msg.sessionId, "Page.lifecycleEvent", { name })
        return
      case "Runtime.evaluate":
        return reply(msg.id, msg.sessionId, { result: { type: "number", value: 2 } })
      case "Browser.getVersion":
        return reply(msg.id, undefined, { product: "StubChrome/1.0" })
      default:
        return reply(msg.id, msg.sessionId, {})
    }
  })
})

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address()
  writeFileSync(join(dir, "DevToolsActivePort"), `${port}\n/devtools/browser/stub\n`)
  record({ kind: "listening", port })
})

const shutdown = () => {
  rmSync(join(dir, "DevToolsActivePort"), { force: true })
  record({ kind: "exit" })
  process.exit(0)
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
