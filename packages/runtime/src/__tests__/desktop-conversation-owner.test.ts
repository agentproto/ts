/**
 * A session that created a desktop conversation (`desktop_conversation_create`)
 * must be able to ask it afterwards, WITHOUT messaging being opened to anyone
 * else. The creator is recorded as the thread's owner (`ownerSessionId`), which
 * is the creator's `parent` relation to the external row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerDesktopConversationCreateTool } from "../desktop-conversations.js"
import { registerMessageTools } from "../message-tools.js"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"

const TID = "01a1eb95-2b47-75c1-b260-86f148899358"
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "desktop-owner-"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function fakeCodex(): Promise<string> {
  const bin = join(root, "codex")
  await writeFile(
    bin,
    `#!/usr/bin/env node
process.stdin.on("data", () => {})
process.stdin.on("end", () => {
  for (const e of ${JSON.stringify([
    { type: "thread.started", thread_id: TID },
    { type: "item.completed", item: { type: "agent_message", text: "pong" } },
    { type: "turn.completed" },
  ])}) console.log(JSON.stringify(e))
})
`,
  )
  await chmod(bin, 0o755)
  return bin
}

function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: "acp_test",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

async function connect(register: (server: Awaited<ReturnType<typeof createMcpServer>>["server"]) => void) {
  const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
  register(server)
  const [c, s] = InMemoryTransport.createLinkedPair()
  await server.connect(s)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(c)
  return client
}
const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text

describe("desktop_conversation_create records its creator as owner", () => {
  it("the creator may message the thread it created; an unrelated session may not", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const mk = (label: string) =>
      registry.spawnAgent({ workspaceSlug: "ws-x", cwd: "/tmp", agentSession: fakeAgentSession(), adapterSlug: "mock", label, depth: 0 })
    const creator = mk("creator")
    const stranger = mk("stranger")
    vi.spyOn(registry, "enqueuePrompt").mockResolvedValue({ queued: false })

    const bin = await fakeCodex()
    const createClient = await connect(server =>
      registerDesktopConversationCreateTool(server, { registry, callerSessionId: creator.id, codexBin: bin }),
    )
    const created = await createClient.callTool({
      name: "desktop_conversation_create",
      arguments: { app: "codex", cwd: root, prompt: "ping" },
    })
    expect(JSON.parse(textOf(created))).toMatchObject({ status: "completed", externalId: `codex:${TID}` })

    const asCreator = await connect(server => registerMessageTools(server, { registry, callerSessionId: creator.id }))
    const ok = await asCreator.callTool({ name: "message_send", arguments: { to: `codex:${TID}`, text: "again" } })
    expect(JSON.parse(textOf(ok)).ok).toBe(true)

    const asStranger = await connect(server => registerMessageTools(server, { registry, callerSessionId: stranger.id }))
    const refused = await asStranger.callTool({ name: "message_send", arguments: { to: `codex:${TID}`, text: "hi" } })
    expect((refused as { isError?: boolean }).isError).toBe(true)
    expect(textOf(refused)).toContain("not a tree neighbour")
  })

  it("records no owner for an identity-less caller (nobody gains a right)", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const bin = await fakeCodex()
    const client = await connect(server => registerDesktopConversationCreateTool(server, { registry, codexBin: bin }))
    await client.callTool({ name: "desktop_conversation_create", arguments: { app: "codex", cwd: root, prompt: "ping" } })
    expect(registry.get(`codex:${TID}`)?.ownerSessionId).toBeUndefined()
  })
})
