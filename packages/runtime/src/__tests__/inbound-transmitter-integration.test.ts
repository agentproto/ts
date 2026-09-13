/**
 * Real end-to-end proof of the transmitter consolidation wiring
 * (index.ts): `POST /inbound` → the real `routeInboundMessage` → the
 * real `SessionsRegistry.enqueuePrompt` → a live session's `send()`
 * actually receives the routed text as a turn. Every unit above this
 * (transmitter-bindings.test.ts, inbound-router.test.ts,
 * inbound-http-route.test.ts, transmit-message.test.ts) exercises its
 * own layer with mocked deps — this test is the one place that composes
 * the REAL binding store + REAL registry + REAL router through a REAL
 * HTTP request, the same composition index.ts wires at boot, so a
 * mismatch between any two layers' real shapes (not just their frozen
 * interfaces) would fail here even if every unit test above stays green.
 */

import { describe, it, expect, vi } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { createSessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent } from "../sessions.js"
import { createTransmitterBindingStore } from "../transmitter-bindings.js"
import { routeInboundMessage } from "../inbound-router.js"
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
  return {
    start() {},
    stop() {},
    async fireNow() {},
  }
}

describe("POST /inbound -> routeInboundMessage -> enqueuePrompt (real wiring)", () => {
  it("routes a push-ingress message into a live bound session, which actually receives it as a turn", async () => {
    const receivedPrompts: string[] = []

    // Real registry — same instance a gateway's `sessions` field is.
    const sessions = createSessionsRegistry({ persist: false })

    // Real bound-session double: no `pid` (mirrors an ACP-native/remote
    // session), which is the exact case the isSessionAlive adapter must
    // treat as alive (processAlive stays `undefined`, not `false` —
    // sessions.ts's `stampProcessAlive`).
    const agentSession: AgentSessionLike = {
      sessionId: "fake_adapter_session_1",
      async *send(message: unknown): AsyncIterable<AgentStreamEvent> {
        // `runAgentTurn` (sessions.ts) wraps a string turn into the
        // ACP-style `{type:"text", text}` content block before calling
        // `send` — extract the text rather than assume a bare string.
        const text =
          message && typeof message === "object" && "text" in message
            ? (message as { text?: unknown }).text
            : message
        receivedPrompts.push(typeof text === "string" ? text : JSON.stringify(message))
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    }
    const desc = sessions.spawnAgent({
      workspaceSlug: "default",
      cwd: process.cwd(),
      agentSession,
      adapterSlug: "fake-cli",
      origin: "webhook",
    })

    // Real binding store, isolated to a tmp file.
    const bindingsDir = mkdtempSync(join(tmpdir(), "transmitter-bindings-e2e-"))
    const bindingStore = createTransmitterBindingStore({
      filePath: join(bindingsDir, "bindings.json"),
      debounceMs: 50,
    })
    bindingStore.upsert({
      alias: "agentpush",
      source: "+33600000000",
      contactRef: "alice",
      sessionId: desc.id,
      mode: "route-or-spawn",
    })

    // Same adapter shape index.ts builds around `sessions`.
    const isSessionAlive = (id: string): boolean => {
      const d = sessions.get(id)
      if (!d) return false
      return d.processAlive !== false
    }
    const restartSession = async (id: string): Promise<string> => {
      throw new Error(`restartSession should not be called for a live session (${id})`)
    }

    const port = await freePort()
    const TOKEN = "test-secret-token"
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      token: TOKEN,
      mcpServerFactory: async () =>
        (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
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

    try {
      const res = await fetch(`http://127.0.0.1:${port}/inbound`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          alias: "agentpush",
          source: "+33600000000",
          contact_ref: "alice",
          text: "hello from telegram",
        }),
      })

      expect(res.status).toBe(200)
      const body = (await res.json()) as { action: string; sessionId?: string }
      expect(body).toEqual({ action: "routed", sessionId: desc.id })

      // enqueuePrompt's admission is awaited synchronously (proven by the
      // 200 above), but the turn itself fires in the background — wait for
      // the fake adapter to actually observe it.
      await vi.waitFor(() => {
        expect(receivedPrompts).toContain("hello from telegram")
      })
    } finally {
      await http.stop()
      sessions.shutdown()
      rmSync(bindingsDir, { recursive: true, force: true })
    }
  })
})
