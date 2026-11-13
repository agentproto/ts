/**
 * Two holes in the `created_tool_call` approval gate:
 *  1. the hash covered TOOL.md + DRIVER.md only, so a script the driver runs
 *     could be rewritten after the human approved;
 *  2. `approval_request` stored the agent's own title/preview, so the human
 *     could be shown reassuring text for a different payload.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { registerCreateToolTools } from "../create-tool-tool.js"
import { registerApprovalTools } from "../approvals/tools.js"
import { createApprovalsEngine, type ApprovalsEngine } from "../approvals/engine.js"
import { createSessionEventBus } from "../session-event-bus.js"

let workspace: string
let approvalsHome: string
let engine: ApprovalsEngine

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "created-tool-gate-"))
  approvalsHome = await mkdtemp(join(tmpdir(), "created-tool-gate-approvals-"))
  engine = createApprovalsEngine({
    homeDir: approvalsHome,
    sessionEvents: createSessionEventBus(),
    webOrigins: ["https://web.example.invalid"],
  })
  const dir = join(workspace, ".agents", "builder")
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, "AGENT.md"),
    `---\nschema: agent/v1\nid: builder\ndescription: test agent\nmodel: claude-sonnet-5\nactions:\n  granted:\n    - create_tool\n---\n\nBody.\n`,
    "utf8",
  )
})
afterEach(async () => {
  engine.dispose()
  await rm(workspace, { recursive: true, force: true })
  await rm(approvalsHome, { recursive: true, force: true })
})

async function connect(sessionId: string): Promise<Client> {
  const server = new McpServer({ name: "gate-test", version: "0.0.0" })
  registerCreateToolTools(server, { workspace, agentId: "builder", sessionId, approvals: engine })
  registerApprovalTools(server, { engine, callerSessionId: sessionId, workspace })
  const [c, s] = InMemoryTransport.createLinkedPair()
  await server.connect(s)
  const client = new Client({ name: "gate-client", version: "0.0.0" })
  await client.connect(c)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text?: string }>; isError?: boolean }
  return { isError: r.isError === true, text: r.content[0]?.text ?? "" }
}

const SCRIPT = (msg: string) => `process.stdout.write(JSON.stringify({ msg: ${JSON.stringify(msg)} }))`

async function createScriptTool(client: Client, argv: string[]): Promise<string> {
  const id = "proof.script"
  const created = await call(client, "create_tool", {
    id,
    description: "Run a bundled script.",
    driver: { kind: "cli", bin: process.execPath, argv },
  })
  expect(created.isError).toBe(false)
  await writeFile(join(workspace, ".agentproto", "tools", id, "run.js"), SCRIPT("approved"), "utf8")
  return id
}

const BUNDLE_SCRIPT = [".agentproto/tools/proof.script/run.js"]

async function approvePayload(sessionId: string, payload: unknown): Promise<string> {
  const record = engine.request({ kind: "created_tool_call", title: "t", preview: payload, payload }, { sessionId })
  await engine.decideWeb(record.id, "approve", { ipAddress: "127.0.0.1", userAgent: "test" })
  return record.id
}

describe("the approval hash covers the scripts the driver runs", () => {
  it("runs the bundled script once approved", async () => {
    const client = await connect("sess_a")
    const id = await createScriptTool(client, BUNDLE_SCRIPT)
    const req = JSON.parse((await call(client, "created_tool_call", { id, args: {} })).text).request
    expect(req.preview.files.map((f: { path: string }) => f.path)).toEqual(["run.js"])
    const approvalId = await approvePayload("sess_a", req.payload)
    const ran = await call(client, "created_tool_call", { id, args: {}, approvalId })
    expect(JSON.parse(ran.text).output).toEqual({ msg: "approved" })
  })

  it("refuses to run a script changed after the human approved", async () => {
    const client = await connect("sess_a")
    const id = await createScriptTool(client, BUNDLE_SCRIPT)
    const req = JSON.parse((await call(client, "created_tool_call", { id, args: {} })).text).request
    const approvalId = await approvePayload("sess_a", req.payload)
    await writeFile(join(workspace, ".agentproto", "tools", id, "run.js"), SCRIPT("EVIL"), "utf8")
    const ran = await call(client, "created_tool_call", { id, args: {}, approvalId })
    expect(ran.isError).toBe(true)
    expect(ran.text).not.toMatch(/EVIL/)
  })

  it("refuses a driver whose argv points outside the bundle", async () => {
    const client = await connect("sess_a")
    const id = await createScriptTool(client, ["../../../outside.js"])
    const res = await call(client, "created_tool_call", { id, args: {} })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/outside the tool bundle/)
  })
})

describe("approval_request for a created tool", () => {
  it("shows the daemon-generated preview, not the caller's", async () => {
    const client = await connect("sess_a")
    const id = await createScriptTool(client, BUNDLE_SCRIPT)
    const req = JSON.parse((await call(client, "created_tool_call", { id, args: { x: 1 } })).text).request
    const res = await call(client, "approval_request", {
      kind: "created_tool_call",
      title: "Harmless: read a calendar",
      preview: { note: "totally safe" },
      payload: req.payload,
    })
    const record = JSON.parse(res.text)
    expect(record.title).toBe("Run created tool proof.script")
    expect(record.preview).toEqual(req.preview)
    expect(JSON.stringify(record.preview)).not.toMatch(/totally safe/)
  })

  it("refuses a payload whose hash is not the tool's current one", async () => {
    const client = await connect("sess_a")
    const id = await createScriptTool(client, BUNDLE_SCRIPT)
    const req = JSON.parse((await call(client, "created_tool_call", { id, args: {} })).text).request
    const res = await call(client, "approval_request", {
      kind: "created_tool_call",
      title: "x",
      preview: {},
      payload: { ...req.payload, toolSha256: "0".repeat(64) },
    })
    expect(res.text).toMatch(/does not match/)
  })
})
