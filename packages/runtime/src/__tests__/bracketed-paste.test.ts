/**
 * Unit tests for bracketed-paste (DEC 2004) mode tracking and its use by
 * `terminal_input` to decide whether multi-line `text` needs the
 * `\x1b[200~`…`\x1b[201~` envelope before being written to the PTY.
 *
 * Two layers:
 *   - `scanBracketedPasteChunk` — the pure per-chunk state-machine step,
 *     including a marker split across two chunk boundaries.
 *   - `terminal_input` end-to-end — feeding the fake PTY's `onData` with
 *     `\x1b[?2004h`/`l` before asserting what a subsequent multi-line
 *     `text` write actually contains.
 */

import { describe, it, expect } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry, scanBracketedPasteChunk } from "../sessions.js"
import type { PtyFactory, PtyProcess, SessionsRegistry } from "../sessions.js"

describe("scanBracketedPasteChunk", () => {
  it("starts unknown (undefined) with no marker seen", () => {
    const { mode, tail } = scanBracketedPasteChunk("", "hello$ ", undefined)
    expect(mode).toBeUndefined()
    expect(tail).toBe("")
  })

  it("detects an intact `\\x1b[?2004h` as mode=true", () => {
    const { mode, tail } = scanBracketedPasteChunk("", "\x1b[?2004h", undefined)
    expect(mode).toBe(true)
    expect(tail).toBe("")
  })

  it("detects an intact `\\x1b[?2004l` as mode=false", () => {
    const { mode, tail } = scanBracketedPasteChunk("", "\x1b[?2004l", true)
    expect(mode).toBe(false)
    expect(tail).toBe("")
  })

  it("the LAST marker in a chunk wins when both appear", () => {
    const { mode } = scanBracketedPasteChunk(
      "",
      "\x1b[?2004h" + "some output" + "\x1b[?2004l",
      undefined
    )
    expect(mode).toBe(false)
  })

  it("carries a marker split across chunk boundaries", () => {
    // First chunk ends mid-marker.
    const step1 = scanBracketedPasteChunk("", "prompt$ \x1b[?200", undefined)
    expect(step1.mode).toBeUndefined()
    expect(step1.tail).toBe("\x1b[?200")

    // Second chunk completes it.
    const step2 = scanBracketedPasteChunk(step1.tail, "4h", step1.mode)
    expect(step2.mode).toBe(true)
    expect(step2.tail).toBe("")
  })

  it("carries a split OFF marker too, and a completed match never mis-carries", () => {
    const step1 = scanBracketedPasteChunk("", "\x1b[?2004h ok \x1b[?200", true)
    expect(step1.mode).toBe(true)
    expect(step1.tail).toBe("\x1b[?200")

    const step2 = scanBracketedPasteChunk(step1.tail, "4l", step1.mode)
    expect(step2.mode).toBe(false)
    expect(step2.tail).toBe("")
  })

  it("does not carry a false-positive tail from an unrelated trailing escape", () => {
    // Trailing bytes that resemble the START of an unrelated sequence but
    // aren't a prefix of the 2004 marker must not be carried.
    const { tail } = scanBracketedPasteChunk("", "hi\x1b[A", undefined)
    expect(tail).toBe("")
  })
})

/** Fake PTY that records every `write` payload AND exposes the `onData`
 *  handler so tests can simulate the PTY emitting bracketed-paste
 *  markers, mirroring how sessions.ts wires the real one. */
function makeControllablePtyFactory(writes: string[]): {
  factory: PtyFactory
  feed: (chunk: string) => void
} {
  let handler: ((data: string) => void) | undefined
  const factory: PtyFactory = (): PtyProcess => ({
    pid: 7778,
    write: (data: string) => { writes.push(data) },
    resize: () => {},
    kill: () => {},
    onData: h => { handler = h },
    onExit: () => {},
  })
  return {
    factory,
    feed: chunk => handler?.(chunk),
  }
}

async function buildHarness(): Promise<{
  client: Client
  registry: SessionsRegistry
  writes: string[]
  sessionId: string
  feed: (chunk: string) => void
  close: () => Promise<void>
}> {
  const writes: string[] = []
  const { factory, feed } = makeControllablePtyFactory(writes)
  const registry = createSessionsRegistry({
    persist: false,
    spawnPty: factory,
  })
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })

  registerSessionTools(server, {
    workspace: process.cwd(),
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
    feed,
    close: () => client.close(),
  }
}

describe("terminal_input bracketed-paste wrap decision", () => {
  it("does NOT wrap multi-line text when paste mode is unknown (no 2004h/l ever seen)", async () => {
    const { client, registry, writes, sessionId, close } = await buildHarness()

    const result = await client.callTool({
      name: "terminal_input",
      arguments: { sessionId, text: "line1\nline2\n" },
    })
    expect(result.isError).toBeFalsy()
    expect(writes).toEqual(["line1\nline2\n"])

    await close()
    registry.shutdown()
  })

  it("wraps multi-line text in the paste envelope once the PTY signals paste mode ON", async () => {
    const { client, registry, writes, sessionId, feed, close } = await buildHarness()

    feed("\x1b[?2004h")
    expect(registry.getBracketedPasteMode(sessionId)).toBe(true)

    const result = await client.callTool({
      name: "terminal_input",
      arguments: { sessionId, text: "line1\nline2\n" },
    })
    expect(result.isError).toBeFalsy()
    expect(writes).toEqual(["\x1b[200~line1\nline2\n\x1b[201~"])

    await close()
    registry.shutdown()
  })

  it("does NOT wrap single-line text even when paste mode is ON", async () => {
    const { client, registry, writes, sessionId, feed, close } = await buildHarness()

    feed("\x1b[?2004h")

    const result = await client.callTool({
      name: "terminal_input",
      arguments: { sessionId, text: "no newline here" },
    })
    expect(result.isError).toBeFalsy()
    expect(writes).toEqual(["no newline here"])

    await close()
    registry.shutdown()
  })

  it("stops wrapping once the PTY signals paste mode OFF", async () => {
    const { client, registry, writes, sessionId, feed, close } = await buildHarness()

    feed("\x1b[?2004h")
    feed("\x1b[?2004l")
    expect(registry.getBracketedPasteMode(sessionId)).toBe(false)

    const result = await client.callTool({
      name: "terminal_input",
      arguments: { sessionId, text: "line1\nline2\n" },
    })
    expect(result.isError).toBeFalsy()
    expect(writes).toEqual(["line1\nline2\n"])

    await close()
    registry.shutdown()
  })

  it("wraps content while still sending Enter as an isolated CR after the envelope", async () => {
    const { client, registry, writes, sessionId, feed, close } = await buildHarness()

    feed("\x1b[?2004h")

    const result = await client.callTool({
      name: "terminal_input",
      arguments: { sessionId, text: "line1\nline2", enter: true },
    })
    expect(result.isError).toBeFalsy()
    expect(writes).toEqual(["\x1b[200~line1\nline2\x1b[201~", "\r"])

    await close()
    registry.shutdown()
  })

  it("correctly tracks a paste marker split across two PTY onData chunks", async () => {
    const { registry, sessionId, feed, close, client } = await buildHarness()

    feed("prompt$ \x1b[?200")
    expect(registry.getBracketedPasteMode(sessionId)).toBeUndefined()
    feed("4h")
    expect(registry.getBracketedPasteMode(sessionId)).toBe(true)

    await close()
    registry.shutdown()
  })
})
