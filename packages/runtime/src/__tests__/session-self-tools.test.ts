/**
 * MCP-level tests for `session_command_self` and `session_handoff` (self-call).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { AgentAdapterResolver } from "../http-server.js"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent, type SessionsRegistry } from "../sessions.js"
import { registerSessionTools } from "../session-tools.js"

interface Fake extends AgentSessionLike {
  prompts: string[]
}

function fake(commands: string[]): Fake {
  const f: Fake = {
    sessionId: `acp-${Math.random().toString(36).slice(2)}`,
    prompts: [],
    availableModes: [],
    async *send(message): AsyncIterable<AgentStreamEvent> {
      const text = (Array.isArray(message) ? message : [message])
        .map(b => (typeof b === "string" ? b : ((b as { text?: string } | undefined)?.text ?? "")))
        .join("")
      f.prompts.push(text)
      yield { kind: "available-commands", commands: commands.map(name => ({ name })) }
      yield { kind: "text-delta", text: "ok" }
      yield { kind: "turn-end" }
    },
    async cancel() {},
    async close() {},
  }
  return f
}

const textOf = (r: unknown): string =>
  ((r as { content?: Array<{ text?: string }> }).content ?? []).map(c => c.text ?? "").join("")
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe("session_command_self / session_handoff on the caller itself", () => {
  let tmp: string
  let reg: SessionsRegistry
  let client: Client
  let selfCommands: string[] | undefined

  const boot = async (callerId: () => string | undefined) => {
    const resolver: AgentAdapterResolver = async () => ({
      startSession: async () => fake(["compact", "clear", "model"]),
      commandPreview: "fake",
      ...(selfCommands ? { selfCommands } : {}),
    })
    const server = new McpServer({ name: "t", version: "0" })
    registerSessionTools(server, {
      registry: reg,
      workspace: tmp,
      resolveAgentAdapter: resolver,
      get callerSessionId() {
        return callerId()
      },
    } as never)
    const [c, s] = InMemoryTransport.createLinkedPair()
    await server.connect(s)
    client = new Client({ name: "t-client", version: "0" })
    await client.connect(c)
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "self-tools-"))
    reg = createSessionsRegistry({ persist: false, transcriptDir: tmp })
    selfCommands = ["compact", "clear", "model"]
  })
  afterEach(async () => {
    await client?.close()
    reg.shutdown()
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  const spawn = async (agent: Fake): Promise<string> => {
    const id = reg.spawnAgent({ workspaceSlug: "default", cwd: tmp, agentSession: agent, adapterSlug: "fake", model: "m-sonnet" }).id
    await reg.sendPrompt(id, "hello") // first turn: the harness advertises its commands
    await sleep(30)
    return id
  }

  it("queues an allowed command on the caller's own session, verbatim", async () => {
    const agent = fake(["compact", "clear", "model"])
    const id = await spawn(agent)
    await boot(() => id)
    const r = await client.callTool({ name: "session_command_self", arguments: { command: "/clear" } })
    expect((r as { isError?: boolean }).isError, textOf(r)).toBeFalsy()
    expect(JSON.parse(textOf(r))).toMatchObject({ queued: true, command: "/clear", runsAt: "end-of-current-turn" })
    await sleep(50)
    expect(agent.prompts).toContain("/clear")
  })

  it("refuses a command outside the manifest allow-list with the allowed list", async () => {
    const id = await spawn(fake(["compact", "logout"]))
    await boot(() => id)
    const r = await client.callTool({ name: "session_command_self", arguments: { command: "logout" } })
    expect((r as { isError?: boolean }).isError).toBe(true)
    expect(JSON.parse(textOf(r))).toMatchObject({ code: "command_not_allowed", allowed: ["compact", "clear", "model"] })
  })

  it("refuses everything when the adapter declares no self-commands", async () => {
    selfCommands = undefined
    const id = await spawn(fake(["compact"]))
    await boot(() => id)
    const r = await client.callTool({ name: "session_command_self", arguments: { command: "compact" } })
    expect(JSON.parse(textOf(r))).toMatchObject({ code: "no_self_commands" })
  })

  it("is refused for a session whose policy reserves compaction to the operator", async () => {
    const id = await spawn(fake(["compact"]))
    const desc = reg.get(id)!
    desc.contextContinuity = { ...(desc.contextContinuity as object), compactRequiresOperator: true } as never
    await boot(() => id)
    const r = await client.callTool({ name: "session_command_self", arguments: { command: "compact" } })
    expect((r as { isError?: boolean }).isError).toBe(true)
    expect(textOf(r)).toContain("operator")
  })

  it("needs a caller identity", async () => {
    await boot(() => undefined)
    const r = await client.callTool({ name: "session_command_self", arguments: { command: "compact" } })
    expect((r as { isError?: boolean }).isError).toBe(true)
  })

  it("session_handoff on itself: successor named in the result, source retired with continuedTo", async () => {
    const id = await spawn(fake(["compact"]))
    await boot(() => id)
    const r = await client.callTool({
      name: "session_handoff",
      arguments: { model: "m-fable", notes: "ship the PR", closeSource: false },
    })
    expect((r as { isError?: boolean }).isError, textOf(r)).toBeFalsy()
    const body = JSON.parse(textOf(r))
    expect(body).toMatchObject({ context: "handoff-summary", mode: "new-session", from: id, selfHandoff: true })
    expect(reg.get(id)?.continuedTo).toBe(body.to)
    expect(body.previousSession.readWith).toContain("transcript_read")
  })

  it("session_handoff: nothing to change is an explicit refusal", async () => {
    const id = await spawn(fake(["compact"]))
    await boot(() => id)
    const r = await client.callTool({ name: "session_handoff", arguments: { model: "m-sonnet" } })
    expect(JSON.parse(textOf(r))).toMatchObject({ code: "nothing_to_change" })
  })
})
