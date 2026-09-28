/**
 * `session_artifact_add` / `_list` / `_get` / `_pin` MCP tools
 * (session-tools.ts) — end-to-end through the real MCP client surface, plus
 * the `session:artifact-added` / `session:artifact-pinned-changed` events
 * they fire on the shared session event bus (session-event-bus.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import type { PtyFactory, PtyProcess } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import type { SessionEvent } from "../session-event-bus.js"

const fakePtyFactory: PtyFactory = (): PtyProcess => ({
  pid: 7777,
  write: () => {},
  resize: () => {},
  kill: () => {},
  onData: () => {},
  onExit: () => {},
})

async function buildHarness(tmp: string) {
  const events: SessionEvent[] = []
  const sessionEvents = createSessionEventBus()
  sessionEvents.onAny(ev => events.push(ev))

  const registry = createSessionsRegistry({
    persist: false,
    transcriptDir: tmp,
    spawnPty: fakePtyFactory,
    sessionEvents,
  })
  const desc = registry.spawnPty({ workspaceSlug: "default", cwd: process.cwd(), argv: ["bash"], cols: 80, rows: 24 })

  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
  registerSessionTools(server, { workspace: process.cwd(), registry, ptyEnabled: true })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0" })
  await client.connect(clientTransport)

  return {
    client,
    sessionId: desc.id,
    events,
    async close() {
      registry.kill(desc.id)
      await client.close()
      await server.close()
    },
  }
}

function firstJson<T>(result: { content: Array<{ type: string; text?: string }> }): T {
  const text = result.content.find(c => c.type === "text")?.text
  return JSON.parse(text ?? "null") as T
}

describe("session_artifact_* MCP tools", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "session-artifact-tools-"))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("adds, lists, gets, and pins an artifact, firing the matching lifecycle events", async () => {
    const h = await buildHarness(tmp)
    try {
      const addResult = await h.client.callTool({
        name: "session_artifact_add",
        arguments: {
          idOrName: h.sessionId,
          key: "notes",
          name: "notes.md",
          mimeType: "text/markdown",
          bytes: Buffer.from("# hi").toString("base64"),
        },
      })
      const added = firstJson<{ key: string; kind: string; versions: Array<{ version: number }> }>(
        addResult as never,
      )
      expect(added.key).toBe("notes")
      expect(added.kind).toBe("document")
      expect(added.versions).toHaveLength(1)

      const listResult = await h.client.callTool({ name: "session_artifact_list", arguments: { idOrName: h.sessionId } })
      const listed = firstJson<{ artifacts: Array<{ key: string }> }>(listResult as never)
      expect(listed.artifacts.map(a => a.key)).toEqual(["notes"])

      const getResult = await h.client.callTool({
        name: "session_artifact_get",
        arguments: { idOrName: h.sessionId, key: "notes" },
      })
      const got = firstJson<{ text?: string; truncated: boolean }>(getResult as never)
      expect(got.text).toBe("# hi")
      expect(got.truncated).toBe(false)

      const pinResult = await h.client.callTool({
        name: "session_artifact_pin",
        arguments: { idOrName: h.sessionId, key: "notes", pinned: true },
      })
      const pinned = firstJson<{ pinned: boolean }>(pinResult as never)
      expect(pinned.pinned).toBe(true)

      expect(h.events.some(e => e.type === "session:artifact-added" && e.key === "notes")).toBe(true)
      expect(
        h.events.some(e => e.type === "session:artifact-pinned-changed" && e.key === "notes" && e.pinned === true),
      ).toBe(true)
    } finally {
      await h.close()
    }
  })

  it("errors on an unknown session id", async () => {
    const h = await buildHarness(tmp)
    try {
      const result = await h.client.callTool({
        name: "session_artifact_add",
        arguments: { idOrName: "no-such-session", bytes: Buffer.from("x").toString("base64") },
      })
      expect((result as { isError?: boolean }).isError).toBe(true)
    } finally {
      await h.close()
    }
  })

  it("errors getting/pinning an unknown artifact key", async () => {
    const h = await buildHarness(tmp)
    try {
      const getResult = await h.client.callTool({
        name: "session_artifact_get",
        arguments: { idOrName: h.sessionId, key: "nope" },
      })
      expect((getResult as { isError?: boolean }).isError).toBe(true)

      const pinResult = await h.client.callTool({
        name: "session_artifact_pin",
        arguments: { idOrName: h.sessionId, key: "nope", pinned: true },
      })
      expect((pinResult as { isError?: boolean }).isError).toBe(true)
    } finally {
      await h.close()
    }
  })
})
