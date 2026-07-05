/**
 * Unit tests for command-tools.ts's audit-log wiring:
 *   - command_execute appends a JSONL entry to the workspace's
 *     command-log after a run
 *   - the entry lands in the correct day-bucketed file
 *   - command_log_tail reads entries back (lastN)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerCommandTools } from "../command-tools.js"
import { commandLogPath } from "../command-log.js"

async function buildHarness(workspace: string): Promise<{
  client: Client
  close: () => Promise<void>
}> {
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
  registerCommandTools(server, { workspace })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0" })
  await client.connect(clientTransport)

  return { client, close: () => client.close() }
}

function allowlist(workspace: string, commands: string[]): void {
  mkdirSync(join(workspace, ".agentproto"), { recursive: true })
  writeFileSync(
    join(workspace, ".agentproto", "allowed-commands.json"),
    JSON.stringify({ version: 1, commands }),
  )
}

/** Wait for the fire-and-forget log append to land — command_execute
 *  doesn't await it before responding (by design: logging must never
 *  delay the caller), so tests poll a tick before reading the file. */
async function flush(): Promise<void> {
  await new Promise(res => setTimeout(res, 20))
}

describe("command_execute → command-log", () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "command-tools-test-"))
    allowlist(workspace, ["node"])
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it("appends a log entry mirroring the returned ExecuteResult", async () => {
    const { client, close } = await buildHarness(workspace)
    const result = await client.callTool({
      name: "command_execute",
      arguments: {
        command: "node",
        args: ["-e", "console.log('hello-from-test')"],
      },
    })
    expect(result.isError).toBeFalsy()
    await flush()

    const today = new Date().toISOString().slice(0, 10)
    const raw = readFileSync(commandLogPath(workspace, today), "utf8").trim()
    const entry = JSON.parse(raw)
    expect(entry).toMatchObject({
      command: "node",
      args: ["-e", "console.log('hello-from-test')"],
      exitCode: 0,
    })
    expect(entry.stdout).toContain("hello-from-test")

    await close()
  })

  it("still logs a nonzero-exit invocation (audit trail covers failures too)", async () => {
    const { client, close } = await buildHarness(workspace)
    await client.callTool({
      name: "command_execute",
      arguments: { command: "node", args: ["-e", "process.exit(3)"] },
    })
    await flush()

    const today = new Date().toISOString().slice(0, 10)
    const entry = JSON.parse(readFileSync(commandLogPath(workspace, today), "utf8").trim())
    expect(entry.exitCode).toBe(3)

    await close()
  })

  it("command_log_tail reads back logged entries, newest last, respecting lastN", async () => {
    const { client, close } = await buildHarness(workspace)
    for (const n of [1, 2, 3]) {
      await client.callTool({
        name: "command_execute",
        arguments: { command: "node", args: ["-e", `console.log(${n})`] },
      })
    }
    await flush()

    const result = await client.callTool({
      name: "command_log_tail",
      arguments: { lastN: 2 },
    })
    expect(result.isError).toBeFalsy()
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}"
    const { entries } = JSON.parse(text) as { entries: Array<{ stdout: string }> }
    expect(entries).toHaveLength(2)
    expect(entries.map(e => e.stdout.trim())).toEqual(["2", "3"])

    await close()
  })

  it("command_log_tail returns an empty list for a workspace with no history", async () => {
    const { client, close } = await buildHarness(workspace)
    const result = await client.callTool({
      name: "command_log_tail",
      arguments: {},
    })
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}"
    expect(JSON.parse(text)).toEqual({ entries: [] })
    await close()
  })
})
