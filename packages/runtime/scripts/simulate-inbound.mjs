/**
 * simulate-inbound.mjs — runnable demo of the transmitter's push-ingress
 * wiring, composed exactly the way `index.ts` composes it at daemon boot:
 * a real `SessionsRegistry`, a real `TransmitterBindingStore`, the real
 * `routeInboundMessage` helper, and a real `startHttpServer` listening on
 * loopback. It registers one fake session double (records what it
 * receives instead of spawning a real adapter), binds a
 * (alias, source, contactRef) triple to that session, fires a REAL
 * `POST /inbound` HTTP request at the running server, and prints the
 * HTTP status, the `{action, sessionId}` response, and the exact text
 * the bound session received as a turn.
 *
 * Run with vite-node (vitest's own execution engine — resolves this
 * package's `.js`-suffixed relative imports against the `.ts` sources
 * exactly like the test suite does, no build step required):
 *
 *   pnpm --filter @agentproto/runtime sim:inbound
 *   pnpm --filter @agentproto/runtime sim:inbound -- --text "hi there" --contact bob
 *
 * Parameters (flag wins over env var wins over default):
 *   --alias / ALIAS            agentpush MCP alias        (default "agentpush")
 *   --source / SOURCE          channel/phone               (default "+33600000000")
 *   --contact / CONTACT        contact_ref                 (default "alice")
 *   --text / TEXT              inbound message text         (default "hello from telegram")
 *   --session-id / SESSION_ID  pin the bound session's id  (default: auto-generated)
 *   --port / PORT              HTTP port                   (default: a free ephemeral port)
 *   --token / TOKEN            bearer token                (default "sim-inbound-token")
 */

import { createServer } from "node:http"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../src/http-server.js"
import { createRuntimeEvents } from "../src/events.js"
import { createSessionsRegistry } from "../src/sessions.js"
import { createTransmitterBindingStore } from "../src/transmitter-bindings.js"
import { routeInboundMessage } from "../src/inbound-router.js"

function parseArgs() {
  const out = {}
  for (const raw of process.argv.slice(2)) {
    const match = /^--([^=]+)=(.*)$/.exec(raw)
    if (match) {
      out[match[1]] = match[2]
      continue
    }
    const bare = /^--([^=]+)$/.exec(raw)
    if (bare) {
      const next = process.argv[process.argv.indexOf(raw) + 1]
      if (next && !next.startsWith("--")) out[bare[1]] = next
    }
  }
  return out
}

function opt(args, flag, envVar, fallback) {
  if (args[flag] !== undefined) return args[flag]
  if (process.env[envVar] !== undefined) return process.env[envVar]
  return fallback
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function noopConversations() {
  return {
    async open() {},
    async appendTurn() {},
    async read() {
      return { meta: {}, turns: [] }
    },
    async list() {
      return []
    },
    pathFor: id => id,
  }
}

function noopHeartbeat() {
  return {
    start() {},
    stop() {},
    async fireNow() {},
  }
}

/** `runAgentTurn` (sessions.ts) wraps a string turn in an ACP-style
 *  `{type:"text", text}` content block before calling `send` — extract
 *  the text rather than assume a bare string. */
function extractTurnText(message) {
  if (message && typeof message === "object" && "text" in message) {
    return typeof message.text === "string" ? message.text : JSON.stringify(message)
  }
  return typeof message === "string" ? message : JSON.stringify(message)
}

async function main() {
  const args = parseArgs()
  const alias = opt(args, "alias", "ALIAS", "agentpush")
  const source = opt(args, "source", "SOURCE", "+33600000000")
  const contactRef = opt(args, "contact", "CONTACT", "alice")
  const text = opt(args, "text", "TEXT", "hello from telegram")
  const pinnedSessionId = opt(args, "session-id", "SESSION_ID", undefined)
  const pinnedPort = opt(args, "port", "PORT", undefined)
  const token = opt(args, "token", "TOKEN", "sim-inbound-token")

  const receivedTurns = []

  // Real registry — same shape a gateway's `sessions` field is.
  const sessions = createSessionsRegistry({ persist: false })

  // Fake session double: no `pid` (mirrors an ACP-native/remote session,
  // the case `isSessionAlive` below must treat as alive — `processAlive`
  // stays `undefined`, not `false`, when there's no OS pid to probe).
  const agentSession = {
    sessionId: "sim-adapter-session",
    async *send(message) {
      receivedTurns.push(extractTurnText(message))
      yield { kind: "turn-end", reason: "completed" }
    },
    async cancel() {},
    async close() {},
  }
  const desc = sessions.spawnAgent({
    workspaceSlug: "default",
    cwd: process.cwd(),
    agentSession,
    adapterSlug: "sim-cli",
    origin: "webhook",
    ...(pinnedSessionId ? { id: pinnedSessionId } : {}),
  })
  const sessionId = desc.id

  // Real binding store, isolated to a per-run tmp file.
  const bindingStore = createTransmitterBindingStore({
    filePath: `/tmp/simulate-inbound-bindings-${process.pid}.json`,
    debounceMs: 50,
  })
  bindingStore.upsert({ alias, source, contactRef, sessionId, mode: "route-or-spawn" })

  // Same liveness/restart adapter shape index.ts wires around `sessions`.
  const isSessionAlive = id => {
    const d = sessions.get(id)
    if (!d) return false
    return d.processAlive !== false
  }
  const restartSession = async id => {
    throw new Error(`simulate-inbound: restartSession should not be called for a live session (${id})`)
  }

  const port = pinnedPort ? Number(pinnedPort) : await freePort()

  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    token,
    mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "sim", version: "0" })).server,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    meta: { workspace: process.cwd(), registered: [] },
    routeInboundMessage: (msg, mode) =>
      routeInboundMessage(
        { bindings: bindingStore, enqueuePrompt: sessions.enqueuePrompt, isSessionAlive, restartSession },
        msg,
        mode,
      ),
  })

  console.log(`[simulate-inbound] daemon listening on http://127.0.0.1:${port}`)
  console.log(`[simulate-inbound] bound (${alias}:${source}:${contactRef}) -> session ${sessionId}`)
  console.log(`[simulate-inbound] POST /inbound { alias:${JSON.stringify(alias)}, source:${JSON.stringify(source)}, contact_ref:${JSON.stringify(contactRef)}, text:${JSON.stringify(text)} }`)

  let failed = false
  try {
    const res = await fetch(`http://127.0.0.1:${port}/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ alias, source, contact_ref: contactRef, text }),
    })
    const body = await res.json()

    console.log(`[simulate-inbound] HTTP status: ${res.status}`)
    console.log(`[simulate-inbound] response: ${JSON.stringify(body)}`)

    const deadline = Date.now() + 5_000
    while (receivedTurns.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }

    if (receivedTurns.length === 0) {
      console.error("[simulate-inbound] FAILED: the bound session never received a turn")
      failed = true
    } else {
      console.log(`[simulate-inbound] session ${sessionId} received turn text: ${JSON.stringify(receivedTurns[0])}`)
    }

    if (body.action !== "routed") {
      console.error(`[simulate-inbound] FAILED: expected action "routed", got ${JSON.stringify(body.action)}`)
      failed = true
    }
  } finally {
    await http.stop()
    sessions.shutdown()
  }

  if (failed) {
    process.exitCode = 1
  } else {
    console.log("[simulate-inbound] OK")
  }
}

main().catch(err => {
  console.error("[simulate-inbound] error:", err)
  process.exitCode = 1
})
