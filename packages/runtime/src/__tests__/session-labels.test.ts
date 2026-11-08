/**
 * `session_labels` (session-labels.ts, registered in session-tools.ts): ids in,
 * `{id, label?, operatorLabel?, adapter?, state?}` out and nothing else. Also
 * proves an app UI reaches it through `performAppToolCall` only when its
 * `ui.tools` lists it, calling the handler the way the daemon's
 * `dispatchTool` does (no input-schema parse).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { createMcpServer } from "@agentproto/mcp-server"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"
import type { AgentSessionLike, AgentStreamEvent, SessionDescriptor } from "../sessions.js"
import { createSessionEventBus } from "../session-event-bus.js"
import { createAppRegistry } from "../app-registry.js"
import { performAppToolCall } from "../app-tools.js"

let n = 0
function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: `c_${n++}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

function spawn(registry: SessionsRegistry, extra: { label?: string; adapterSlug?: string } = {}): SessionDescriptor {
  return registry.spawnAgent({
    workspaceSlug: "w",
    cwd: "/private/secret/cwd",
    agentSession: fakeAgentSession(),
    adapterSlug: extra.adapterSlug ?? "mock",
    ...(extra.label ? { label: extra.label } : {}),
  })
}

interface Row {
  id: string
  label?: string
  operatorLabel?: string
  adapter?: string
  state?: string
}

function labelsOf(result: unknown): Row[] {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content
  return (JSON.parse(content.find(c => c.type === "text")?.text ?? "null") as { labels: Row[] }).labels
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true
}

describe("session_labels", () => {
  let tmp: string
  let registry: SessionsRegistry
  let server: McpServer
  let client: Client

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "session-labels-"))
    registry = createSessionsRegistry({ sessionEvents: createSessionEventBus(), persist: false })
    server = (await createMcpServer({ specs: [], name: "test", version: "0" })).server
    registerSessionTools(server, { workspace: tmp, registry })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    client = new Client({ name: "test-client", version: "0" })
    await client.connect(clientTransport)
  })

  afterEach(async () => {
    await client.close()
    await server.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  const call = (ids: unknown) => client.callTool({ name: "session_labels", arguments: { ids } as never })

  it("returns the labels of known ids, in input order", async () => {
    const a = spawn(registry, { label: "linkedin-scout", adapterSlug: "claude-code" })
    const b = spawn(registry, { label: "cv-writer", adapterSlug: "codex" })
    registry.setOperatorLabel(b.id, "jeremy-cv")

    const rows = labelsOf(await call([b.id, a.id]))

    expect(rows.map(r => r.id)).toEqual([b.id, a.id])
    expect(rows[0]).toMatchObject({ label: "cv-writer", operatorLabel: "jeremy-cv", adapter: "codex" })
    expect(rows[1]).toMatchObject({ label: "linkedin-scout", adapter: "claude-code" })
    expect(rows[1]).not.toHaveProperty("operatorLabel")
    expect(["live", "idle"]).toContain(rows[0]?.state)
  })

  it("returns the id alone for an unknown id", async () => {
    const rows = labelsOf(await call(["sess_nope"]))
    expect(rows).toEqual([{ id: "sess_nope" }])
    expect(Object.keys(rows[0] as object)).toEqual(["id"])
  })

  it("resolves the session:<fp>:<id> form with the last segment and echoes the id as sent", async () => {
    const a = spawn(registry, { label: "tab-owner" })
    const form = `session:fp1234:${a.id}`
    const rows = labelsOf(await call([form, "session:fp1234:sess_nope", "session:"]))
    expect(rows[0]).toMatchObject({ id: form, label: "tab-owner" })
    expect(rows[1]).toEqual({ id: "session:fp1234:sess_nope" })
    expect(rows[2]).toEqual({ id: "session:" })
  })

  it("reports exited for an ended session", async () => {
    const a = spawn(registry, { label: "gone" })
    await registry.kill(a.id)
    const rows = labelsOf(await call([a.id]))
    expect(rows[0]?.state).toBe("exited")
  })

  it("never returns a field outside id, label, operatorLabel, adapter, state", async () => {
    const a = spawn(registry, { label: "full", adapterSlug: "claude-code" })
    registry.setOperatorLabel(a.id, "op")
    const rows = labelsOf(await call([a.id, "sess_nope"]))
    expect(Object.keys(rows[0] as object).sort()).toEqual(["adapter", "id", "label", "operatorLabel", "state"])
    expect(Object.keys(rows[1] as object)).toEqual(["id"])
    expect(JSON.stringify(rows)).not.toContain("/private/secret/cwd")
  })

  it("does not use the prompt-derived title as the label", async () => {
    const a = spawn(registry)
    registry.renameSession(a.id, { title: "summarise my secret prompt" })
    const rows = labelsOf(await call([a.id]))
    expect(rows[0]).not.toHaveProperty("label")
    expect(JSON.stringify(rows)).not.toContain("secret prompt")
  })

  it("refuses an empty list, more than 100 ids and an over-long id", async () => {
    expect(isError(await call([]))).toBe(true)
    expect(isError(await call(Array.from({ length: 101 }, (_, i) => `sess_${i}`)))).toBe(true)
    expect(isError(await call(["x".repeat(257)]))).toBe(true)
    expect(isError(await call([""]))).toBe(true)
    expect(isError(await call(Array.from({ length: 100 }, (_, i) => `sess_${i}`)))).toBe(false)
  })

  describe("through the app tool-call path", () => {
    // Same reach-in the daemon's `dispatchTool` (index.ts) uses: the raw handler, no schema parse.
    const dispatchTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      const tools = (server as unknown as {
        _registeredTools: Record<string, { handler: (a: unknown, extra: unknown) => unknown }>
      })._registeredTools
      const tool = tools[name]
      if (!tool) throw new Error(`unknown daemon tool "${name}"`)
      return tool.handler(args, {})
    }

    function appRegistryWith(tools: string[]) {
      const appRegistry = createAppRegistry()
      appRegistry.upsertApp({
        appId: "@x/bureau",
        dir: tmp,
        agents: [],
        workflows: [],
        unvalidatedAgentTools: [],
        ui: { path: join(tmp, "index.html"), tools },
      })
      return appRegistry
    }

    function errorText(result: unknown): string {
      const content = (result as { content: Array<{ type: string; text?: string }> }).content
      return content.find(c => c.type === "text")?.text ?? ""
    }

    function unwrapLabels(result: unknown): Row[] {
      let cur: unknown = result
      for (let i = 0; i < 6; i++) {
        const content = (cur as { content?: Array<{ type: string; text?: string }> }).content
        const text = content?.find(c => c.type === "text")?.text
        if (text === undefined) break
        try {
          cur = JSON.parse(text)
        } catch {
          break
        }
        if ((cur as { labels?: unknown }).labels) return (cur as { labels: Row[] }).labels
      }
      throw new Error(`no labels in ${JSON.stringify(result)}`)
    }

    it("an app that lists session_labels in ui.tools can call it", async () => {
      const a = spawn(registry, { label: "agent-a" })
      const result = await performAppToolCall(
        appRegistryWith(["session_labels"]),
        { appId: "@x/bureau", tool: "session_labels", args: { ids: [a.id] } },
        { dispatchTool },
      )
      expect(isError(result)).toBe(false)
      expect(unwrapLabels(result)[0]).toMatchObject({ id: a.id, label: "agent-a" })
    })

    it("an app that does not list it is refused", async () => {
      const a = spawn(registry, { label: "agent-a" })
      const result = await performAppToolCall(
        appRegistryWith(["app_list"]),
        { appId: "@x/bureau", tool: "session_labels", args: { ids: [a.id] } },
        { dispatchTool },
      )
      expect(isError(result)).toBe(true)
      const { error } = JSON.parse(errorText(result)) as { error: string }
      expect(error).toMatch(/not in app "@x\/bureau"'s ui.tools allowlist/)
    })

    it("the handler still refuses bad ids when the schema is bypassed", async () => {
      const app = appRegistryWith(["session_labels"])
      for (const ids of [[], Array.from({ length: 101 }, (_, i) => `sess_${i}`), "sess_x", undefined]) {
        const result = await performAppToolCall(
          app,
          { appId: "@x/bureau", tool: "session_labels", args: { ids } as never },
          { dispatchTool },
        )
        // `app_tool_call` wraps the handler's own envelope, so its isError sits one level down.
        const envelope = JSON.parse(errorText(result)) as { isError?: boolean; content: Array<{ text: string }> }
        expect(envelope.isError).toBe(true)
        expect(envelope.content[0]?.text).toMatch(/must be 1 to 100/)
      }
    })
  })
})
