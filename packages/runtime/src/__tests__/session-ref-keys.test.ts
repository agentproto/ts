/**
 * Regression coverage for WP-A2: every session-addressing MCP tool accepts
 * `sessionId` OR `idOrName` OR `slug`, all routed through the one frozen
 * `resolveSessionRef`.
 *
 * The inciting bug: `session_compact`'s schema only declared `idOrName`, so a
 * caller (the session-chat UI) sending `{ sessionId }` was rejected by the
 * daemon with `-32602 Input validation error … at idOrName` BEFORE the handler
 * ever ran. This test drives the tools over a real MCP transport (server +
 * Client + InMemoryTransport) so an input-validation failure surfaces as a
 * thrown JSON-RPC error, exactly as a real client would see it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import {
  createSessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
  type SessionsRegistry,
} from "../sessions.js"
import { registerSessionTools } from "../session-tools.js"
import { HANDOFF_PROMPT_OPENER } from "../handoff-markers.js"

const HANDOFF_REPLY = JSON.stringify({
  goal: "test the session-ref keys",
  decisions: [],
  tests: { command: "", result: "" },
  openRisks: [],
  nextStep: "done",
})

function promptText(message: unknown): string {
  const blocks = Array.isArray(message) ? message : [message]
  return blocks
    .map(b => (typeof b === "string" ? b : ((b as { text?: string } | undefined)?.text ?? "")))
    .join("")
}

interface FakeHarness extends AgentSessionLike {
  prompts: string[]
}

function fakeHarness(): FakeHarness {
  const harness: FakeHarness = {
    sessionId: "ref-keys-fake",
    prompts: [],
    async *send(message): AsyncIterable<AgentStreamEvent> {
      const text = promptText(message)
      harness.prompts.push(text)
      if (text.includes(HANDOFF_PROMPT_OPENER)) {
        yield { kind: "text-delta", text: HANDOFF_REPLY }
      } else {
        yield { kind: "text-delta", text: "ok" }
      }
      yield { kind: "turn-end" }
    },
    async cancel() {},
    async close() {},
  }
  return harness
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  return content?.find(c => c.type === "text")?.text ?? ""
}

describe("every session-addressing tool accepts sessionId | idOrName | slug", () => {
  let tmp: string
  let reg: SessionsRegistry
  let client: Client

  const withHarness = async (): Promise<{ id: string; slug: string; harness: FakeHarness }> => {
    const harness = fakeHarness()
    const desc = reg.spawnAgent({
      workspaceSlug: "default",
      cwd: tmp,
      agentSession: harness,
      adapterSlug: "fake",
    })
    // `slug` is minted by WP-B1; until then stamp one directly so the resolver
    // has a slug target to find on the live descriptor.
    const slug = `ref-keys-${desc.id.replace(/[^a-z0-9]/gi, "").toLowerCase()}`
    ;(desc as unknown as { slug?: string }).slug = slug
    return { id: desc.id, slug, harness }
  }

  const call = async (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args })

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "session-ref-keys-"))
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

  describe("session_compact (the inciting idOrName-only tool)", () => {
    it("reaches its handler when called with { sessionId } instead of failing -32602 at idOrName", async () => {
      const { id, harness } = await withHarness()
      await reg.sendPrompt(id, "a first turn so a checkpoint can be built")

      const result = await call("session_compact", { sessionId: id })
      expect((result as { isError?: boolean }).isError).toBeFalsy()
      expect(harness.prompts.some(p => p.startsWith("/compact"))).toBe(true)
    })

    it("still works when called with { idOrName }", async () => {
      const { id, harness } = await withHarness()
      await reg.sendPrompt(id, "a first turn so a checkpoint can be built")

      const result = await call("session_compact", { idOrName: id })
      expect((result as { isError?: boolean }).isError).toBeFalsy()
      expect(harness.prompts.some(p => p.startsWith("/compact"))).toBe(true)
    })

    it("resolves by { slug } too", async () => {
      const { id, slug, harness } = await withHarness()
      await reg.sendPrompt(id, "a first turn so a checkpoint can be built")

      const result = await call("session_compact", { slug })
      expect((result as { isError?: boolean }).isError).toBeFalsy()
      expect(harness.prompts.some(p => p.startsWith("/compact"))).toBe(true)
    })
  })

  // One representative from each prior camp, called with each of the three
  // key spellings — all must reach the handler (no schema rejection).
  const camps: Array<{ name: string; assertResolved: (result: unknown, id: string) => void }> = [
    {
      // idOrName-only camp.
      name: "session_usage",
      assertResolved: (result, id) => expect(textOf(result)).toContain(id),
    },
    {
      // sessionId-only camp.
      name: "session_evidence",
      assertResolved: result => expect((result as { isError?: boolean }).isError).toBeFalsy(),
    },
  ]

  for (const { name, assertResolved } of camps) {
    describe(`${name} accepts all three keys`, () => {
      it("by sessionId", async () => {
        const { id } = await withHarness()
        const result = await call(name, { sessionId: id })
        assertResolved(result, id)
      })
      it("by idOrName", async () => {
        const { id } = await withHarness()
        const result = await call(name, { idOrName: id })
        assertResolved(result, id)
      })
      it("by slug", async () => {
        const { id, slug } = await withHarness()
        const result = await call(name, { slug })
        assertResolved(result, id)
      })
    })
  }

  // The archived-session regression: `registry.list()` hides archived rows, so
  // a resolver fed the raw registry cannot find an archived session by
  // name/slug — even though `session_unarchive` (and any archived lookup) must.
  // Every call site wraps the registry in `archivedInclusiveRegistry`; these
  // tests pin that.
  describe("archived sessions stay addressable by name/slug", () => {
    const archive = (id: string) => {
      const desc = reg.get(id) as unknown as { status?: string }
      if (desc) desc.status = "exited"
      reg.archiveSession(id)
    }

    it("resolves an archived session by slug (session_unarchive)", async () => {
      const { id, slug } = await withHarness()
      archive(id)
      const result = await call("session_unarchive", { slug })
      expect((result as { isError?: boolean }).isError).toBeFalsy()
      expect(reg.get(id)?.archived).toBe(false)
    })

    it("resolves an archived session by legacy name (session_unarchive)", async () => {
      const { id } = await withHarness()
      const name = `legacy-${id.replace(/[^a-z0-9]/gi, "").toLowerCase()}`
      ;(reg.get(id) as unknown as { name?: string }).name = name
      archive(id)
      const result = await call("session_unarchive", { idOrName: name })
      expect((result as { isError?: boolean }).isError).toBeFalsy()
      expect(reg.get(id)?.archived).toBe(false)
    })
  })
})
