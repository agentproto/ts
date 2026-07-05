/**
 * Unit tests for the `terminal_input` MCP tool (session-tools.ts).
 *
 * Drives the real tool end-to-end through the MCP client surface and
 * captures what reaches the PTY's `write` via a fake PTY factory, covering
 * the `enter` / `b64` payload affordances added for TUI submission:
 *   - `enter` alone            → "\r" written
 *   - `text` + `enter`         → "foo\r" written
 *   - `b64` of a known sequence → decoded bytes written verbatim
 *   - nothing provided         → isError response, no write
 */

import { describe, it, expect } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import type {
  PtyFactory,
  PtyProcess,
  SessionsRegistry,
} from "../sessions.js"

/** Fake PTY that records every `write` payload so tests can assert on the
 *  exact bytes the tool layer forwards to stdin. */
function makeCapturingPtyFactory(writes: string[]): PtyFactory {
  return (): PtyProcess => ({
    pid: 7777,
    write: (data: string) => { writes.push(data) },
    resize: () => {},
    kill: () => {},
    onData: () => {},
    onExit: () => {},
  })
}

async function buildHarness(): Promise<{
  client: Client
  registry: SessionsRegistry
  writes: string[]
  sessionId: string
  close: () => Promise<void>
}> {
  const writes: string[] = []
  const registry = createSessionsRegistry({
    persist: false,
    spawnPty: makeCapturingPtyFactory(writes),
  })
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })

  registerSessionTools(server, {
    registry,
    ptyEnabled: true,
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0" })
  await client.connect(clientTransport)

  const desc = registry.spawnPty({
    workspaceSlug: "default",
    cwd: process.cwd(),
    argv: ["bash"],
    cols: 80,
    rows: 24,
  })

  return {
    client,
    registry,
    writes,
    sessionId: desc.id,
    close: () => client.close(),
  }
}

describe("terminal_input (enter / b64 affordances)", () => {
  it("`enter` alone writes a bare carriage return", async () => {
    const { client, registry, writes, sessionId, close } = await buildHarness()

    const result = await client.callTool({
      name: "terminal_input",
      arguments: { sessionId, enter: true },
    })
    expect(result.isError).toBeFalsy()
    expect(writes).toEqual(["\r"])

    await close()
    registry.shutdown()
  })

  it("`text` + `enter` appends the carriage return after the text", async () => {
    const { client, registry, writes, sessionId, close } = await buildHarness()

    const result = await client.callTool({
      name: "terminal_input",
      arguments: { sessionId, text: "foo", enter: true },
    })
    expect(result.isError).toBeFalsy()
    expect(writes).toEqual(["foo\r"])

    await close()
    registry.shutdown()
  })

  it("`b64` decodes to the exact byte sequence (Esc + arrow-up)", async () => {
    const { client, registry, writes, sessionId, close } = await buildHarness()

    // Esc [ A  →  the ANSI cursor-up sequence.
    const seq = "\x1b[A"
    const b64 = Buffer.from(seq, "latin1").toString("base64")
    const result = await client.callTool({
      name: "terminal_input",
      arguments: { sessionId, b64 },
    })
    expect(result.isError).toBeFalsy()
    expect(writes).toEqual([seq])

    await close()
    registry.shutdown()
  })

  it("returns isError and writes nothing when no payload field is provided", async () => {
    const { client, registry, writes, sessionId, close } = await buildHarness()

    const result = await client.callTool({
      name: "terminal_input",
      arguments: { sessionId },
    })
    expect(result.isError).toBe(true)
    expect(writes).toEqual([])

    await close()
    registry.shutdown()
  })
})
