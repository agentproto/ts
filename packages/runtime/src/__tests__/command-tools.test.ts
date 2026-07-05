/**
 * Unit tests for command-tools.ts's session-based persistence wiring:
 *   - command_execute mints a kind:"command" session via
 *     registry.recordCommand and echoes its id back to the caller
 *   - the session's full result lands at its own events.jsonl
 *   - command_log_tail reads results back, by sessionId or by listing
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerCommandTools } from "../command-tools.js"
import { createSessionsRegistry, type SessionsRegistry } from "../sessions.js"

async function buildHarness(
  workspace: string,
  registry: SessionsRegistry,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
  registerCommandTools(server, { workspace, registry })

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

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text: string }> }).content
  return content?.[0]?.text ?? "{}"
}

/** `recordCommand`'s JSONL body write is fire-and-forget — the session
 *  descriptor (and its id) is available the instant command_execute
 *  returns, but the on-disk write it kicked off may not have landed yet.
 *  Tests that immediately read it back via command_log_tail poll a tick
 *  first, same as `agent_output`-style tests do elsewhere in this suite. */
async function flush(): Promise<void> {
  await new Promise(res => setTimeout(res, 20))
}

describe("command_execute → session-based persistence", () => {
  let workspace: string
  let registry: SessionsRegistry

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "command-tools-test-"))
    allowlist(workspace, ["node"])
    // persist:false skips writing sessions.json, but `persistPath` still
    // anchors the transcript-writer's base dir — omitting it would fall
    // back to the real `~/.agentproto/sessions`.
    registry = createSessionsRegistry({ persistPath: join(workspace, "sessions.json"), persist: false })
  })

  afterEach(() => {
    registry.shutdown()
    rmSync(workspace, { recursive: true, force: true })
  })

  it("mints a kind:\"command\" session and echoes its id back to the caller", async () => {
    const { client, close } = await buildHarness(workspace, registry)
    const result = await client.callTool({
      name: "command_execute",
      arguments: { command: "node", args: ["-e", "console.log('hello-from-test')"] },
    })
    expect(result.isError).toBeFalsy()
    const { sessionId, exitCode, stdout } = JSON.parse(textOf(result))
    expect(exitCode).toBe(0)
    expect(stdout).toContain("hello-from-test")

    const desc = registry.get(sessionId)
    expect(desc?.kind).toBe("command")
    expect(desc?.status).toBe("exited")
    expect(desc?.argv).toEqual(["node", "-e", "console.log('hello-from-test')"])

    await close()
  })

  it("still records a nonzero-exit invocation as status \"error\"", async () => {
    const { client, close } = await buildHarness(workspace, registry)
    const result = await client.callTool({
      name: "command_execute",
      arguments: { command: "node", args: ["-e", "process.exit(3)"] },
    })
    const { sessionId } = JSON.parse(textOf(result))
    const desc = registry.get(sessionId)
    expect(desc?.status).toBe("error")
    expect(desc?.exitCode).toBe(3)

    await close()
  })

  it("command_log_tail(sessionId) reads back the full result for one invocation", async () => {
    const { client, close } = await buildHarness(workspace, registry)
    const exec = await client.callTool({
      name: "command_execute",
      arguments: { command: "node", args: ["-e", "console.log('full-result')"] },
    })
    const { sessionId } = JSON.parse(textOf(exec))
    await flush()

    const tail = await client.callTool({
      name: "command_log_tail",
      arguments: { sessionId },
    })
    const { entry } = JSON.parse(textOf(tail))
    expect(entry).toMatchObject({ command: "node", exitCode: 0 })
    expect(entry.stdout).toContain("full-result")

    await close()
  })

  it("command_log_tail(sessionId) returns a null entry for a non-command session", async () => {
    const { client, close } = await buildHarness(workspace, registry)
    const tail = await client.callTool({
      name: "command_log_tail",
      arguments: { sessionId: "sess_doesnotexist" },
    })
    expect(JSON.parse(textOf(tail))).toEqual({ entry: null })
    await close()
  })

  it("command_log_tail lists recent invocations, newest last, respecting lastN", async () => {
    const { client, close } = await buildHarness(workspace, registry)
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
    const { entries } = JSON.parse(textOf(result)) as { entries: Array<{ stdout: string }> }
    expect(entries).toHaveLength(2)
    expect(entries.map(e => e.stdout.trim())).toEqual(["2", "3"])

    await close()
  })

  it("command_log_tail returns an empty list for a workspace with no history", async () => {
    const { client, close } = await buildHarness(workspace, registry)
    const result = await client.callTool({ name: "command_log_tail", arguments: {} })
    expect(JSON.parse(textOf(result))).toEqual({ entries: [] })
    await close()
  })
})
