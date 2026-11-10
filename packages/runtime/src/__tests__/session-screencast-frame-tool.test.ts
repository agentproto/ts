/**
 * `session_screencast_frame`: a read-only MCP tool returning the same frame the
 * HTTP route `GET /sessions/:id/screencast.jpg` serves (a Bureau screenshot of
 * the session's own newest open tab), as one MCP `image` block.
 *
 * Covered here: the tool over an in-memory MCP connection (shape, one miss
 * message, caller guard, subset/profile exclusion). The shared reader through a
 * real gateway and the link-token refusal live in
 * `session-screencast-frame-wiring.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"
import {
  createSessionScreencastReader,
  SESSION_SCREENCAST_NO_FRAME_MESSAGE,
  type SessionScreencastOutcome,
  type SessionScreencastReader,
} from "../session-screencast.js"
import { DEFAULT_ORCHESTRATOR_TOOLS } from "../orchestrator-gateway.js"
import { CLASSIFIED_TOOL_NAMES, CORE_PROFILE_TOOLS, PROFILE_TOOLS } from "../tool-profiles.js"
import { DAEMON_TOOL_NAMES } from "../daemon-tool-names.generated.js"

const TOOL = "session_screencast_frame"
const MISS = "No open browser tab for this session."
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9])

type ToolResult = {
  isError?: boolean
  content: { type: string; text?: string; data?: string; mimeType?: string }[]
}

function fakeReader(outcome: SessionScreencastOutcome | (() => Promise<SessionScreencastOutcome>)) {
  const read = vi.fn(async (_id: string): Promise<SessionScreencastOutcome> => {
    return typeof outcome === "function" ? outcome() : outcome
  })
  return { reader: { read } as SessionScreencastReader, read }
}

describe("session_screencast_frame", () => {
  let workspace: string
  let registry: SessionsRegistry
  const closers: (() => Promise<void>)[] = []

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "session-screencast-frame-"))
    registry = createSessionsRegistry({ persistPath: join(workspace, "sessions.json"), persist: false })
  })

  afterEach(async () => {
    for (const close of closers.splice(0)) await close()
    registry.shutdown()
    rmSync(workspace, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  async function connect(extra: Record<string, unknown>): Promise<Client> {
    const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
    registerSessionTools(server, { registry, workspace: process.cwd(), ...extra } as never)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "test-client", version: "0" })
    await client.connect(clientTransport)
    closers.push(() => client.close())
    return client
  }

  const call = async (client: Client, sessionId: string): Promise<ToolResult> =>
    (await client.callTool({ name: TOOL, arguments: { sessionId } })) as unknown as ToolResult

  it("is listed on the root gateway as a read-only, idempotent tool", async () => {
    const { reader } = fakeReader({ ok: true, bytes: JPEG, mimeType: "image/jpeg" })
    const client = await connect({ sessionScreencast: reader })
    const tool = (await client.listTools()).tools.find(t => t.name === TOOL)
    expect(tool).toBeDefined()
    expect(tool?.annotations?.readOnlyHint).toBe(true)
    expect(tool?.annotations?.idempotentHint).toBe(true)
    expect(tool?.annotations?.destructiveHint).toBe(false)
    expect(Object.keys((tool?.inputSchema as { properties?: object }).properties ?? {})).toEqual(["sessionId"])
  })

  it("returns one image block with the decoded bytes and the frame's mime type", async () => {
    const { reader, read } = fakeReader({ ok: true, bytes: JPEG, mimeType: "image/jpeg" })
    const client = await connect({ sessionScreencast: reader })
    const res = await call(client, "sess_a")
    expect(res.isError).toBeFalsy()
    expect(res.content).toHaveLength(1)
    expect(res.content[0]?.type).toBe("image")
    expect(res.content[0]?.mimeType).toBe("image/jpeg")
    expect(Buffer.from(res.content[0]?.data ?? "", "base64").equals(JPEG)).toBe(true)
    expect(read.mock.calls).toEqual([["sess_a"]])
  })

  it("passes the mime type of a non-jpeg frame through", async () => {
    const { reader } = fakeReader({ ok: true, bytes: JPEG, mimeType: "image/png" })
    const res = await call(await connect({ sessionScreencast: reader }), "sess_a")
    expect(res.content[0]?.mimeType).toBe("image/png")
  })

  describe("a miss", () => {
    const expectMiss = (res: ToolResult) => {
      expect(res.isError).toBe(true)
      expect(res.content).toHaveLength(1)
      expect(res.content[0]?.type).toBe("text")
      expect(res.content[0]?.text).toBe(MISS)
    }

    it("uses the reader's own no-frame message", () => {
      expect(SESSION_SCREENCAST_NO_FRAME_MESSAGE).toBe(MISS)
    })

    it("answers the same single message for every reason a frame can be missing", async () => {
      const logs: string[] = []
      const SECRET = "c2VjcmV0LWZyYW1lLWJ5dGVz"
      const text = (value: unknown) => ({ type: "text", text: JSON.stringify(value) })
      const tab = { content: [text({ tabs: [{ targetId: "t1", openedAt: "2026-11-09T10:00:00Z" }] })] }
      const cases: Record<string, (c: { tool: string }) => unknown> = {
        "no tab": c => (c.tool === "browser_list_owned_tabs" ? { content: [text({ tabs: [] })] } : null),
        "tool error": c =>
          c.tool === "browser_list_owned_tabs"
            ? tab
            : { isError: true, content: [text({ code: "browser:target_gone", message: SECRET })] },
        "bad result": c => (c.tool === "browser_list_owned_tabs" ? tab : { content: [text({ note: SECRET })] }),
        throw: c => {
          throw new Error(`bureau down ${SECRET} ${c.tool}`)
        },
      }
      const seen = new Set<string>()
      for (const [name, handler] of Object.entries(cases)) {
        const callImportedTool = vi.fn(async (_a: string, tool: string) => handler({ tool }))
        const reader = createSessionScreencastReader({
          callImportedTool,
          resolveAlias: async () => "bureau",
          log: line => logs.push(line),
        })
        const client = await connect({ sessionScreencast: reader })
        const res = await call(client, `sess_${name.replace(/\W/g, "_")}`)
        expectMiss(res)
        expect(callImportedTool).toHaveBeenCalled()
        seen.add(res.content[0]?.text ?? "")
      }
      // no callImportedTool at all
      const unwired = await connect({
        sessionScreencast: createSessionScreencastReader({ log: line => logs.push(line) }),
      })
      expectMiss(await call(unwired, "sess_unwired"))
      // no reader handed to the tool registry
      expectMiss(await call(await connect({}), "sess_no_reader"))
      // a reader that rejects
      const rejecting = fakeReader(async () => {
        throw new Error(`boom ${SECRET}`)
      })
      expectMiss(await call(await connect({ sessionScreencast: rejecting.reader }), "sess_reject"))

      expect(seen.size).toBe(1)
      expect(logs.join("\n")).not.toContain(SECRET)
    })

    it("never logs base64 image data for a served frame", async () => {
      const spies = [
        vi.spyOn(console, "log").mockImplementation(() => {}),
        vi.spyOn(console, "warn").mockImplementation(() => {}),
        vi.spyOn(console, "error").mockImplementation(() => {}),
      ]
      const { reader } = fakeReader({ ok: true, bytes: JPEG, mimeType: "image/jpeg" })
      await call(await connect({ sessionScreencast: reader }), "sess_a")
      await call(await connect({}), "sess_a")
      const logged = spies.flatMap(s => s.mock.calls.flat()).join("\n")
      expect(logged).not.toContain(JPEG.toString("base64"))
    })
  })

  describe("who may call it", () => {
    it("lets the operator connection (no caller session) read any session id", async () => {
      const { reader, read } = fakeReader({ ok: true, bytes: JPEG, mimeType: "image/jpeg" })
      const client = await connect({ sessionScreencast: reader })
      expect((await call(client, "sess_a")).content[0]?.type).toBe("image")
      expect((await call(client, "sess_b")).content[0]?.type).toBe("image")
      expect(read.mock.calls.map(c => c[0])).toEqual(["sess_a", "sess_b"])
    })

    it("refuses a caller session reading another session, without calling the reader", async () => {
      const { reader, read } = fakeReader({ ok: true, bytes: JPEG, mimeType: "image/jpeg" })
      const client = await connect({ sessionScreencast: reader, callerSessionId: "sess_a" })
      expect((await client.listTools()).tools.map(t => t.name)).toContain(TOOL)
      const res = await call(client, "sess_b")
      expect(res.isError).toBe(true)
      expect(res.content.every(b => b.type === "text")).toBe(true)
      expect(res.content[0]?.text).not.toBe(MISS)
      expect(read).not.toHaveBeenCalled()
    })

    it("refuses a scoped orchestrator reading a session other than its own owner", async () => {
      const { reader, read } = fakeReader({ ok: true, bytes: JPEG, mimeType: "image/jpeg" })
      const client = await connect({
        sessionScreencast: reader,
        callerScope: { token: "scope_tok", tools: new Set(DEFAULT_ORCHESTRATOR_TOOLS), ownerSessionId: "sess_a", depth: 0 },
      })
      expect((await client.listTools()).tools.map(t => t.name)).toContain(TOOL)
      expect((await call(client, "sess_b")).isError).toBe(true)
      expect(read).not.toHaveBeenCalled()
    })

    it("lets a caller session read its own tab", async () => {
      const { reader, read } = fakeReader({ ok: true, bytes: JPEG, mimeType: "image/jpeg" })
      const client = await connect({ sessionScreencast: reader, callerSessionId: "sess_a" })
      const res = await call(client, "sess_a")
      expect(res.content[0]?.type).toBe("image")
      expect(read.mock.calls).toEqual([["sess_a"]])
    })

    it("is absent from the agent-scoped gateway surface and from every named profile except full", async () => {
      expect(DEFAULT_ORCHESTRATOR_TOOLS).not.toContain(TOOL)
      expect(CORE_PROFILE_TOOLS).not.toContain(TOOL)
      for (const members of Object.values(PROFILE_TOOLS)) expect(members).not.toContain(TOOL)
      expect(CLASSIFIED_TOOL_NAMES.has(TOOL)).toBe(true)
      expect(DAEMON_TOOL_NAMES).toContain(TOOL)

      const { reader } = fakeReader({ ok: true, bytes: JPEG, mimeType: "image/jpeg" })
      const scoped = await connect({
        sessionScreencast: reader,
        toolSubset: new Set(DEFAULT_ORCHESTRATOR_TOOLS),
        callerScope: { token: "scope_tok", tools: new Set(DEFAULT_ORCHESTRATOR_TOOLS), ownerSessionId: "sess_a", depth: 0 },
      })
      expect((await scoped.listTools()).tools.map(t => t.name)).not.toContain(TOOL)
    })
  })
})
