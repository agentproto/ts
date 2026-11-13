/**
 * A tool authored by `create_tool` must be callable by the SAME session that
 * created it, without a respawn: the session's MCP tool list is fixed when it
 * connects, so the call goes through a verb that is already listed then
 * (`created_tool_call`), and every call still needs a human-approved,
 * single-use approval bound to the exact tool id and arguments.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { registerCreateToolTools } from "../create-tool-tool.js"
import { createApprovalsEngine, type ApprovalsEngine } from "../approvals/engine.js"
import { createSessionEventBus } from "../session-event-bus.js"

let workspace: string
let approvalsHome: string
let engine: ApprovalsEngine

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "created-tool-call-"))
  approvalsHome = await mkdtemp(join(tmpdir(), "created-tool-call-approvals-"))
  engine = createApprovalsEngine({
    homeDir: approvalsHome,
    sessionEvents: createSessionEventBus(),
    webOrigins: ["https://web.example.invalid"],
  })
})
afterEach(async () => {
  engine.dispose()
  await rm(workspace, { recursive: true, force: true })
  await rm(approvalsHome, { recursive: true, force: true })
})

async function writeAgent(id: string, granted: string[]): Promise<void> {
  const dir = join(workspace, ".agents", id)
  await mkdir(dir, { recursive: true })
  const actions = `actions:\n  granted:\n${granted.map(g => `    - ${g}`).join("\n")}\n`
  await writeFile(
    join(dir, "AGENT.md"),
    `---\nschema: agent/v1\nid: ${id}\ndescription: test agent\nmodel: claude-sonnet-5\n${actions}---\n\nBody.\n`,
    "utf8",
  )
}

/** Node prints its first script argument back as JSON (the created driver
 *  parses stdout as JSON). */
const echoDriver = {
  kind: "cli" as const,
  bin: process.execPath,
  argv: ["-e", "process.stdout.write(JSON.stringify({ echo: process.argv[1] }))", "${input.text}"],
}

async function connect(sessionId: string): Promise<Client> {
  const server = new McpServer({ name: "created-tool-call-test", version: "0.0.0" })
  registerCreateToolTools(server, { workspace, agentId: "builder", sessionId, approvals: engine })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "created-tool-call-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  try {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text?: string }>
      isError?: boolean
    }
    return { isError: result.isError === true, text: result.content[0]?.text ?? "" }
  } catch (err) {
    return { isError: true, text: err instanceof Error ? err.message : String(err) }
  }
}

/** The payload the verb itself asks to be approved for this id + args. */
async function requestedPayload(client: Client, id: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await call(client, "created_tool_call", { id, args })
  return JSON.parse(res.text).request.payload
}

async function approve(sessionId: string, payload: unknown): Promise<string> {
  const record = engine.request(
    { kind: "created_tool_call", title: "Run proof.echo", preview: payload, payload },
    { sessionId },
  )
  await engine.decideWeb(record.id, "approve", { ipAddress: "127.0.0.1", userAgent: "test" })
  return record.id
}

describe("create_tool then call it in the same session", () => {
  it("creates a tool and calls it through the session's existing tool list, once a human approves", async () => {
    await writeAgent("builder", ["create_tool"])
    const client = await connect("sess_builder")

    // The tool list the harness got when it connected, BEFORE the tool exists.
    const listed = (await client.listTools()).tools.map(t => t.name)
    expect(listed).toContain("created_tool_call")

    const created = await call(client, "create_tool", {
      id: "proof.echo",
      description: "Echo a text back.",
      driver: echoDriver,
      inputs: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    })
    expect(created.isError).toBe(false)

    const args = { text: "bonjour" }

    // No approval: refused, and told exactly what to ask a human for.
    const unapproved = await call(client, "created_tool_call", { id: "proof.echo", args })
    expect(unapproved.isError).toBe(true)
    expect(unapproved.text).toMatch(/approval_required/)
    const request = JSON.parse(unapproved.text).request
    expect(request.kind).toBe("created_tool_call")
    expect(request.payload).toMatchObject({ tool: "proof.echo", args })
    expect(request.payload.toolSha256).toMatch(/^[0-9a-f]{64}$/)
    // The human sees what will run, not only the agent's words.
    expect(request.preview.driver).toMatchObject({ kind: "cli", bin: process.execPath })

    const approvalId = await approve("sess_builder", request.payload)
    const ran = await call(client, "created_tool_call", { id: "proof.echo", args, approvalId })
    expect(ran.isError).toBe(false)
    expect(JSON.parse(ran.text)).toEqual({ id: "proof.echo", output: { echo: "bonjour" } })

    // Single use: the same approval cannot run the tool twice.
    const replay = await call(client, "created_tool_call", { id: "proof.echo", args, approvalId })
    expect(replay.isError).toBe(true)
    expect(replay.text).toMatch(/already consumed/)
  })

  it("refuses an approval granted for other arguments", async () => {
    await writeAgent("builder", ["create_tool"])
    const client = await connect("sess_builder")
    await call(client, "create_tool", { id: "proof.echo", description: "Echo.", driver: echoDriver })

    const approvalId = await approve("sess_builder", await requestedPayload(client, "proof.echo", { text: "bonjour" }))
    const res = await call(client, "created_tool_call", {
      id: "proof.echo",
      args: { text: "rm -rf" },
      approvalId,
    })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/does not match the approved payload/)
  })

  it("refuses an approval another session asked for", async () => {
    await writeAgent("builder", ["create_tool"])
    const client = await connect("sess_builder")
    await call(client, "create_tool", { id: "proof.echo", description: "Echo.", driver: echoDriver })

    const args = { text: "bonjour" }
    const approvalId = await approve("sess_other", await requestedPayload(client, "proof.echo", args))
    const res = await call(client, "created_tool_call", { id: "proof.echo", args, approvalId })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/not requested by this caller/)
  })

  it("refuses an approval of another kind", async () => {
    await writeAgent("builder", ["create_tool"])
    const client = await connect("sess_builder")
    await call(client, "create_tool", { id: "proof.echo", description: "Echo.", driver: echoDriver })

    const args = { text: "bonjour" }
    const payload = await requestedPayload(client, "proof.echo", args)
    const record = engine.request({ kind: "send_email", title: "t", preview: payload, payload }, { sessionId: "sess_builder" })
    await engine.decideWeb(record.id, "approve", { ipAddress: "127.0.0.1", userAgent: "test" })
    const res = await call(client, "created_tool_call", { id: "proof.echo", args, approvalId: record.id })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/kind/)
  })

  it("voids an approval when the tool's driver changed after the human said yes", async () => {
    await writeAgent("builder", ["create_tool"])
    const client = await connect("sess_builder")
    await call(client, "create_tool", { id: "proof.echo", description: "Echo.", driver: echoDriver })

    const args = { text: "bonjour" }
    const approvalId = await approve("sess_builder", await requestedPayload(client, "proof.echo", args))
    const driverFile = join(workspace, ".agentproto", "drivers", "proof.echo", "DRIVER.md")
    await writeFile(driverFile, (await readFile(driverFile, "utf8")).replace("echo:", "pwned:"), "utf8")
    const res = await call(client, "created_tool_call", { id: "proof.echo", args, approvalId })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/does not match the approved payload/)
  })

  it("ignores an unrelated malformed TOOL.md and keeps the approval when its own bundle is broken", async () => {
    await writeAgent("builder", ["create_tool"])
    const client = await connect("sess_builder")
    await call(client, "create_tool", { id: "proof.echo", description: "Echo.", driver: echoDriver })
    // A broken, unrelated bundle elsewhere in the workspace.
    await mkdir(join(workspace, ".agentproto", "tools", "junk"), { recursive: true })
    await writeFile(join(workspace, ".agentproto", "tools", "junk", "TOOL.md"), "not a manifest", "utf8")

    const args = { text: "bonjour" }
    const approvalId = await approve("sess_builder", await requestedPayload(client, "proof.echo", args))
    const ran = await call(client, "created_tool_call", { id: "proof.echo", args, approvalId })
    expect(ran.isError).toBe(false)

    // Its own bundle broken: refused before the approval is consumed.
    const second = await approve("sess_builder", await requestedPayload(client, "proof.echo", args))
    await writeFile(join(workspace, ".agentproto", "drivers", "proof.echo", "DRIVER.md"), "broken", "utf8")
    const broken = await call(client, "created_tool_call", { id: "proof.echo", args, approvalId: second })
    expect(broken.isError).toBe(true)
    expect(engine.get(second)?.status).toBe("approved")
  })

  it("refuses a bundle whose TOOL.md declares another id than its folder", async () => {
    await writeAgent("builder", ["create_tool"])
    const client = await connect("sess_builder")
    await call(client, "create_tool", { id: "proof.echo", description: "Echo.", driver: echoDriver })
    const toolFile = join(workspace, ".agentproto", "tools", "proof.echo", "TOOL.md")
    await writeFile(toolFile, (await readFile(toolFile, "utf8")).replace("id: proof.echo", "id: other.tool"), "utf8")
    const res = await call(client, "created_tool_call", { id: "proof.echo", args: { text: "x" } })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/declares id 'other.tool'/)
  })

  it("only runs tools create_tool authored, never a hand-written TOOL.md", async () => {
    await writeAgent("builder", ["create_tool"])
    const client = await connect("sess_builder")
    const toolDir = join(workspace, ".agentproto", "tools", "hand.tool")
    await mkdir(toolDir, { recursive: true })
    await writeFile(
      join(toolDir, "TOOL.md"),
      `---\nschema: agentproto/tool/v1\nid: hand.tool\nname: hand.tool\ndescription: d\nversion: 1.0.0\napproval: auto\n---\n`,
      "utf8",
    )
    const res = await call(client, "created_tool_call", { id: "hand.tool", args: {} })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/not a tool create_tool authored/)
  })

  it("asks for an approval even when the created tool declares approval: auto", async () => {
    await writeAgent("builder", ["create_tool"])
    const client = await connect("sess_builder")
    await call(client, "create_tool", {
      id: "proof.echo",
      description: "Echo.",
      driver: echoDriver,
      approval: "auto",
    })
    const res = await call(client, "created_tool_call", { id: "proof.echo", args: { text: "x" } })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/approval_required/)
  })
})
