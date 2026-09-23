import { createServer } from "node:http"
import { AddressInfo } from "node:net"
import { describe, expect, it } from "vitest"
import { createMcpServer } from "@agentproto/mcp-server"

import { startHttpServer } from "../http-server.js"
import { createSessionsRegistry } from "../sessions.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"

const TEST_ONLY_CANARY = "synthetic-resume-env-canary-not-a-credential"

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}

const conversations: ConversationStore = {
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

const heartbeat: HeartbeatRunner = {
  start() {},
  stop() {},
  async fireNow() {},
}

describe("HTTP session descriptor redaction", () => {
  it("omits ptyResumeEnv from list, detail, and rename responses while preserving registry state", async () => {
    const registry = createSessionsRegistry({
      persist: false,
      spawnPty: () => ({
        pid: 4242,
        write: () => {},
        resize: () => {},
        kill: () => {},
        onData: () => {},
        onExit: () => {},
      }),
    })
    const session = registry.spawnPty({
      workspaceSlug: "default",
      cwd: process.cwd(),
      argv: ["bash"],
      cols: 80,
      rows: 24,
      env: { RESUME_CONFIG_DIR: TEST_ONLY_CANARY },
    })
    const port = await freePort()
    const http = await startHttpServer({
      port,
      auth: { mode: "none" },
      mcpServerFactory: async () =>
        (await createMcpServer({ specs: [], name: "http-redaction-test", version: "0" })).server,
      conversations,
      events: createRuntimeEvents(),
      heartbeat,
      sessions: registry,
      ptyEnabled: true,
      meta: { workspace: process.cwd(), registered: [] },
    })

    try {
      const responses = [
        await fetch(`http://127.0.0.1:${port}/sessions`),
        await fetch(`http://127.0.0.1:${port}/sessions/${session.id}`),
        await fetch(`http://127.0.0.1:${port}/sessions/${session.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: "renamed fixture" }),
        }),
        await fetch(`http://127.0.0.1:${port}/sessions/terminal`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            argv: ["bash"],
            cwd: process.cwd(),
            env: { RESUME_CONFIG_DIR: TEST_ONLY_CANARY },
          }),
        }),
      ]
      const bodies = await Promise.all(responses.map(async response => ({
        status: response.status,
        text: await response.text(),
      })))

      for (const [index, { status, text }] of bodies.entries()) {
        expect(status).toBe(index === 3 ? 201 : 200)
        expect(text).not.toContain(TEST_ONLY_CANARY)
        const body = JSON.parse(text) as Record<string, unknown>
        const listed = body.sessions as Array<Record<string, unknown>> | undefined
        const descriptor = listed?.find(row => row.id === session.id) ?? (listed ? undefined : body)
        expect(descriptor).toBeDefined()
        expect(descriptor).not.toHaveProperty("ptyResumeEnv")
      }

      const stored = registry.get(session.id)
      expect(stored?.ptyResumeEnv).toBeDefined()
      expect(Object.values(stored?.ptyResumeEnv ?? {}).includes(TEST_ONLY_CANARY)).toBe(true)
    } finally {
      await http.stop()
      registry.shutdown()
    }
  })
})
