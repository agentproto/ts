/**
 * WP-C1 — `session_rename` MCP tool accepts an optional `slug` and threads it
 * to `renameSession` so an agent can set a session's addressable handle
 * headlessly (the MCP twin of `PATCH /sessions/:id`'s `slug` field).
 *
 * Addressing is by `sessionId`/`idOrName`; `slug` is the NEW handle (the two
 * roles collide on one key — see the tool docblock).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import { registerSessionTools, compactSessionItem } from "../session-tools.js"

function fakeHarness(): AgentSessionLike {
  return {
    sessionId: "rename-slug-fake",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  return content?.find(c => c.type === "text")?.text ?? ""
}

describe("session_rename accepts a slug override", () => {
  let tmp: string
  let reg: ReturnType<typeof createSessionsRegistry>
  let client: Client

  const spawn = (): string =>
    reg.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession: fakeHarness(),
      adapterSlug: "fake",
      label: "before",
    }).id

  const call = (args: Record<string, unknown>) =>
    client.callTool({ name: "session_rename", arguments: args })

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "session-rename-slug-"))
    reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    const server = new McpServer({ name: "t", version: "0" })
    registerSessionTools(server, { registry: reg, workspace: tmp })
    const [c, s] = InMemoryTransport.createLinkedPair()
    await server.connect(s)
    client = new Client({ name: "t-client", version: "0" })
    await client.connect(c)
  })

  afterEach(async () => {
    await client.close()
    reg.shutdown()
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  it("sets the slug when addressed by sessionId", async () => {
    const id = spawn()
    const result = await call({ sessionId: id, slug: "after-handle" })
    expect((result as { isError?: boolean }).isError).toBeFalsy()
    const body = JSON.parse(textOf(result)) as { id: string; slug?: string }
    expect(body.id).toBe(id)
    expect(body.slug).toBe("after-handle")
    expect(reg.get(id)?.slug).toBe("after-handle")
    expect(reg.findByIdOrName("after-handle")?.id).toBe(id)
  })

  it("sets the slug when addressed by idOrName", async () => {
    const id = spawn()
    const result = await call({ idOrName: id, slug: "renamed-via-name" })
    expect((result as { isError?: boolean }).isError).toBeFalsy()
    expect(reg.get(id)?.slug).toBe("renamed-via-name")
  })

  it("clears the slug on an empty string", async () => {
    const id = spawn()
    await call({ sessionId: id, slug: "temporary" })
    expect(reg.get(id)?.slug).toBe("temporary")
    const result = await call({ sessionId: id, slug: "" })
    expect((result as { isError?: boolean }).isError).toBeFalsy()
    expect(reg.get(id)?.slug).toBeUndefined()
  })

  it("still sets title/label alongside a slug", async () => {
    const id = spawn()
    const result = await call({ sessionId: id, slug: "before", label: "Display" })
    expect((result as { isError?: boolean }).isError).toBeFalsy()
    expect(reg.get(id)?.slug).toBe("before")
    expect(reg.get(id)?.label).toBe("Display")
  })

  it("errors when no rename field is supplied", async () => {
    const id = spawn()
    const result = await call({ sessionId: id })
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toContain("nothing_to_rename")
  })

  it("surfaces the slug on the compact session_list projection", () => {
    const id = spawn()
    reg.renameSession(id, { slug: "compact-visible" })
    const item = compactSessionItem(reg.get(id)!)
    expect(item.slug).toBe("compact-visible")
  })
})
