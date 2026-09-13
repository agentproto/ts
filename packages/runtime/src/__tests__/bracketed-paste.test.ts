/**
 * Coverage for the bracketed-paste fix in `terminal_input` (session-tools.ts)
 * + its supporting per-session tracker in sessions.ts:
 *
 *   - `scanBracketedPaste`: pure state-machine parsing `\x1b[?2004h`/
 *     `\x1b[?2004l` out of a PTY's OUTPUT byte stream, including the case
 *     where one of those sequences is split across two `onData` chunks.
 *   - `shouldWrapBracketedPaste`: the wrap/no-wrap decision — must stay
 *     `false` for `"unknown"` (never seen either sequence) so a session
 *     that doesn't use bracketed paste at all sees no behavior change.
 *   - End-to-end through the real `terminal_input` MCP tool: once the
 *     fake PTY announces paste mode ON, multi-line `text` gets wrapped in
 *     `\x1b[200~`…`\x1b[201~` before the isolated Enter CR; single-line
 *     text and an "unknown"/off session are never wrapped.
 */

import { describe, it, expect } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerSessionTools } from "../session-tools.js"
import {
  createSessionsRegistry,
  scanBracketedPaste,
  shouldWrapBracketedPaste,
  wrapBracketedPaste,
} from "../sessions.js"
import type {
  BracketedPasteScanState,
  PtyFactory,
  PtyProcess,
  SessionsRegistry,
} from "../sessions.js"

const ON = "\x1b[?2004h"
const OFF = "\x1b[?2004l"

describe("scanBracketedPaste", () => {
  const initial: BracketedPasteScanState = { mode: "unknown", carry: "" }

  it("starts unknown before anything is seen", () => {
    expect(initial.mode).toBe("unknown")
  })

  it("detects an intact ON sequence in one chunk", () => {
    const next = scanBracketedPaste(initial, Buffer.from(`hello${ON}world`, "latin1"))
    expect(next.mode).toBe("on")
    expect(next.carry).toBe("")
  })

  it("detects an intact OFF sequence in one chunk", () => {
    const on = scanBracketedPaste(initial, Buffer.from(ON, "latin1"))
    const off = scanBracketedPaste(on, Buffer.from(`$ ${OFF}`, "latin1"))
    expect(off.mode).toBe("off")
  })

  it("the LAST sequence in a chunk wins when both appear", () => {
    const next = scanBracketedPaste(initial, Buffer.from(`${ON}...${OFF}`, "latin1"))
    expect(next.mode).toBe("off")
  })

  it("detects an ON sequence split across two chunks", () => {
    const splitPoint = 4
    const first = ON.slice(0, splitPoint) // "\x1b[?2"
    const second = ON.slice(splitPoint) // "004h"
    const afterFirst = scanBracketedPaste(initial, Buffer.from(first, "latin1"))
    // Not yet resolved — mode still unknown, but the partial sequence is
    // held in carry rather than discarded or treated as opaque bytes.
    expect(afterFirst.mode).toBe("unknown")
    expect(afterFirst.carry).toBe(first)

    const afterSecond = scanBracketedPaste(afterFirst, Buffer.from(second, "latin1"))
    expect(afterSecond.mode).toBe("on")
    expect(afterSecond.carry).toBe("")
  })

  it("detects an OFF sequence split across two chunks after a prior ON", () => {
    const on = scanBracketedPaste(initial, Buffer.from(ON, "latin1"))
    const splitPoint = 6
    const first = OFF.slice(0, splitPoint)
    const second = OFF.slice(splitPoint)
    const afterFirst = scanBracketedPaste(on, Buffer.from(first, "latin1"))
    expect(afterFirst.mode).toBe("on") // unresolved yet, previous mode sticks
    expect(afterFirst.carry).toBe(first)
    const afterSecond = scanBracketedPaste(afterFirst, Buffer.from(second, "latin1"))
    expect(afterSecond.mode).toBe("off")
  })

  it("a lone trailing ESC byte is carried, not dropped", () => {
    const next = scanBracketedPaste(initial, Buffer.from("prompt$ \x1b", "latin1"))
    expect(next.carry).toBe("\x1b")
    expect(next.mode).toBe("unknown")
  })

  it("an ESC that does NOT lead into either sequence is not carried forever", () => {
    // \x1b[A (cursor-up) is a real escape sequence but not a prefix of
    // either 2004h/2004l past the shared "\x1b[" — once resolved as not a
    // paste sequence, it must not stick around as carry.
    const next = scanBracketedPaste(initial, Buffer.from("\x1b[A", "latin1"))
    expect(next.mode).toBe("unknown")
    expect(next.carry).toBe("")
  })

  it("a chunk with only unrelated bytes after a resolved sequence carries nothing", () => {
    const on = scanBracketedPaste(initial, Buffer.from(ON, "latin1"))
    const next = scanBracketedPaste(on, Buffer.from("$ ls -la\n", "latin1"))
    expect(next.mode).toBe("on")
    expect(next.carry).toBe("")
  })
})

describe("shouldWrapBracketedPaste", () => {
  it("wraps when mode is on AND text is multi-line", () => {
    expect(shouldWrapBracketedPaste("on", "line1\nline2")).toBe(true)
  })

  it("does not wrap when mode is on but text is single-line", () => {
    expect(shouldWrapBracketedPaste("on", "line1")).toBe(false)
  })

  it("does not wrap when mode is off, even if multi-line", () => {
    expect(shouldWrapBracketedPaste("off", "line1\nline2")).toBe(false)
  })

  it("does not wrap when mode is unknown, even if multi-line (no regression)", () => {
    expect(shouldWrapBracketedPaste("unknown", "line1\nline2")).toBe(false)
  })
})

describe("wrapBracketedPaste", () => {
  it("wraps content in the bracketed-paste start/end markers", () => {
    expect(wrapBracketedPaste("abc\ndef")).toBe("\x1b[200~abc\ndef\x1b[201~")
  })
})

/** Fake PTY that records `write` calls and lets the test drive the
 *  `onData` handler sessions.ts registers on it, to simulate the PTY
 *  announcing bracketed-paste mode from its OUTPUT stream. */
function makeControllablePtyFactory(writes: string[]): {
  factory: PtyFactory
  emitOutput: (chunk: string) => void
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
    emitOutput: chunk => handler?.(chunk),
  }
}

async function buildHarness(): Promise<{
  client: Client
  registry: SessionsRegistry
  writes: string[]
  emitOutput: (chunk: string) => void
  sessionId: string
  close: () => Promise<void>
}> {
  const writes: string[] = []
  const { factory, emitOutput } = makeControllablePtyFactory(writes)
  const registry = createSessionsRegistry({ persist: false, spawnPty: factory })
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
    emitOutput,
    sessionId: desc.id,
    close: () => client.close(),
  }
}

describe("terminal_input bracketed-paste wrapping (end-to-end)", () => {
  it("wraps multi-line text once the PTY has announced paste mode ON", async () => {
    const { client, registry, writes, emitOutput, sessionId, close } = await buildHarness()

    emitOutput(ON)
    const result = await client.callTool({
      name: "terminal_input",
      arguments: { sessionId, text: "line1\nline2", enter: true },
    })
    expect(result.isError).toBeFalsy()
    expect(writes).toEqual(["\x1b[200~line1\nline2\x1b[201~", "\r"])

    await close()
    registry.shutdown()
  })

  it("does not wrap single-line text even in paste mode ON", async () => {
    const { client, registry, writes, emitOutput, sessionId, close } = await buildHarness()

    emitOutput(ON)
    const result = await client.callTool({
      name: "terminal_input",
      arguments: { sessionId, text: "line1", enter: true },
    })
    expect(result.isError).toBeFalsy()
    expect(writes).toEqual(["line1", "\r"])

    await close()
    registry.shutdown()
  })

  it("does not wrap multi-line text before any paste-mode announcement (unknown)", async () => {
    const { client, registry, writes, sessionId, close } = await buildHarness()

    const result = await client.callTool({
      name: "terminal_input",
      arguments: { sessionId, text: "line1\nline2", enter: true },
    })
    expect(result.isError).toBeFalsy()
    expect(writes).toEqual(["line1\nline2", "\r"])

    await close()
    registry.shutdown()
  })

  it("does not wrap multi-line text once paste mode has gone OFF again", async () => {
    const { client, registry, writes, emitOutput, sessionId, close } = await buildHarness()

    emitOutput(ON)
    emitOutput(OFF)
    const result = await client.callTool({
      name: "terminal_input",
      arguments: { sessionId, text: "line1\nline2", enter: true },
    })
    expect(result.isError).toBeFalsy()
    expect(writes).toEqual(["line1\nline2", "\r"])

    await close()
    registry.shutdown()
  })

  it("wraps multi-line text even when the ON sequence arrived split across chunks", async () => {
    const { client, registry, writes, emitOutput, sessionId, close } = await buildHarness()

    emitOutput(ON.slice(0, 4))
    emitOutput(ON.slice(4))
    const result = await client.callTool({
      name: "terminal_input",
      arguments: { sessionId, text: "a\nb", enter: true },
    })
    expect(result.isError).toBeFalsy()
    expect(writes).toEqual(["\x1b[200~a\nb\x1b[201~", "\r"])

    await close()
    registry.shutdown()
  })
})
