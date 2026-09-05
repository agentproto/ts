/**
 * Unit tests for two terminal-session DX fixes (session-tools.ts):
 *
 * 1. Parent attribution on `terminal_start` — a PTY spawned through a
 *    scoped sub-gateway (callerScope present) must carry
 *    `parentSessionId = ownerSessionId` / `depth = depth + 1`, exactly
 *    like `agent_start` does, so `session_tree` shows it under its
 *    spawning orchestrator instead of as a depth-0 root. A root spawn
 *    (no callerScope) and an unbound scope (no ownerSessionId yet)
 *    stay parentless at depth 0.
 *
 * 2. `terminal_output { clean: true }` — returns the ring buffer as
 *    ANSI-stripped UTF-8 `text` instead of raw base64 `b64`, so a
 *    supervisor tracking a TUI agent doesn't have to decode escape
 *    walls. Default stays base64 (back-compat).
 */

import { describe, it, expect } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry } from "../sessions.js"
import type { PtyFactory, PtyProcess, SessionsRegistry } from "../sessions.js"
import type { OrchestratorScope } from "../orchestrator-gateway.js"

/** Fake PTY that exposes the registry's onData callback so tests can
 *  feed bytes into the ring buffer as if the child process wrote them. */
function makeFeedablePtyFactory(sink: { feed?: (chunk: string) => void }): PtyFactory {
  return (): PtyProcess => ({
    pid: 7777,
    write: () => {},
    resize: () => {},
    kill: () => {},
    onData: (cb: (chunk: string) => void) => {
      sink.feed = cb
    },
    onExit: () => {},
  })
}

function makeScope(overrides?: Partial<OrchestratorScope>): OrchestratorScope {
  return {
    token: "tok_test",
    tools: new Set(["terminal_start"]),
    ownerSessionId: "sess_parent1",
    depth: 0,
    maxDepth: 3,
    maxChildren: 5,
    role: "supervisor",
    ...overrides,
  }
}

async function buildHarness(opts?: { callerScope?: OrchestratorScope }): Promise<{
  client: Client
  registry: SessionsRegistry
  sink: { feed?: (chunk: string) => void }
  close: () => Promise<void>
}> {
  const sink: { feed?: (chunk: string) => void } = {}
  const registry = createSessionsRegistry({
    persist: false,
    spawnPty: makeFeedablePtyFactory(sink),
  })
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
  registerSessionTools(server, {
    registry,
    ptyEnabled: true,
    ...(opts?.callerScope ? { callerScope: opts.callerScope } : {}),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0" })
  await client.connect(clientTransport)
  return { client, registry, sink, close: () => client.close() }
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args })
  expect(result.isError).toBeFalsy()
  const content = result.content as Array<{ type: string; text?: string }>
  return JSON.parse(content.find(c => c.type === "text")?.text ?? "{}") as Record<
    string,
    unknown
  >
}

describe("terminal_start — parent attribution (orchestrator WP4)", () => {
  it("attributes a scoped spawn to the owning orchestrator at depth+1", async () => {
    const { client, registry, close } = await buildHarness({
      callerScope: makeScope({ ownerSessionId: "sess_parent1", depth: 1 }),
    })
    const desc = await callTool(client, "terminal_start", {
      argv: ["bash"],
      cwd: "/tmp",
    })
    expect(desc.parentSessionId).toBe("sess_parent1")
    expect(desc.depth).toBe(2)
    // The registry's own descriptor agrees (what session_tree reads).
    const stored = registry.get(desc.id as string)
    expect(stored?.parentSessionId).toBe("sess_parent1")
    expect(stored?.depth).toBe(2)
    await close()
  })

  it("a root spawn (no callerScope) stays parentless at depth 0", async () => {
    const { client, close } = await buildHarness()
    const desc = await callTool(client, "terminal_start", {
      argv: ["bash"],
      cwd: "/tmp",
    })
    expect(desc.parentSessionId).toBeUndefined()
    expect(desc.depth).toBe(0)
    await close()
  })

  it("an unbound scope (no ownerSessionId yet) degrades to no parent", async () => {
    const { client, close } = await buildHarness({
      callerScope: makeScope({ ownerSessionId: undefined, depth: 1 }),
    })
    const desc = await callTool(client, "terminal_start", {
      argv: ["bash"],
      cwd: "/tmp",
    })
    expect(desc.parentSessionId).toBeUndefined()
    expect(desc.depth).toBe(0)
    await close()
  })
})

describe("terminal_output — clean plaintext mode", () => {
  const ANSI_CHUNK = "\x1b[2J\x1b[1;32mhello\x1b[0m world\r\n\x1b[?25lspinner"

  it("default stays raw base64 (back-compat)", async () => {
    const { client, sink, close } = await buildHarness()
    const desc = await callTool(client, "terminal_start", {
      argv: ["bash"],
      cwd: "/tmp",
    })
    sink.feed?.(ANSI_CHUNK)
    const out = await callTool(client, "terminal_output", {
      sessionId: desc.id as string,
    })
    expect(out.text).toBeUndefined()
    expect(typeof out.b64).toBe("string")
    expect(Buffer.from(out.b64 as string, "base64").toString("utf8")).toContain(
      "\x1b[1;32mhello",
    )
    await close()
  })

  it("clean: true returns ANSI-stripped UTF-8 text instead of b64", async () => {
    const { client, sink, close } = await buildHarness()
    const desc = await callTool(client, "terminal_start", {
      argv: ["bash"],
      cwd: "/tmp",
    })
    sink.feed?.(ANSI_CHUNK)
    const out = await callTool(client, "terminal_output", {
      sessionId: desc.id as string,
      clean: true,
    })
    expect(out.b64).toBeUndefined()
    expect(out.text).toContain("hello world")
    expect(out.text).toContain("spinner")
    expect(out.text as string).not.toMatch(/\x1b/)
    await close()
  })

  it("clean respects lastBytes tail capping", async () => {
    const { client, sink, close } = await buildHarness()
    const desc = await callTool(client, "terminal_start", {
      argv: ["bash"],
      cwd: "/tmp",
    })
    sink.feed?.("aaaa-tail-marker")
    const out = await callTool(client, "terminal_output", {
      sessionId: desc.id as string,
      clean: true,
      lastBytes: 11,
    })
    expect(out.text).toBe("tail-marker")
    await close()
  })
})

describe("terminal_output — truncated companion flag (PR-4, additive)", () => {
  it("truncated: true appears only when a lastBytes window is applied and filled", async () => {
    const { client, sink, close } = await buildHarness()
    const desc = await callTool(client, "terminal_start", {
      argv: ["bash"],
      cwd: "/tmp",
    })
    sink.feed?.("0123456789abcdef")
    const out = await callTool(client, "terminal_output", {
      sessionId: desc.id as string,
      clean: true,
      lastBytes: 4,
    })
    expect(out.text).toBe("cdef")
    expect(out.truncated).toBe(true)
    await close()
  })

  it("truncated: false when the window is larger than the buffer", async () => {
    const { client, sink, close } = await buildHarness()
    const desc = await callTool(client, "terminal_start", {
      argv: ["bash"],
      cwd: "/tmp",
    })
    sink.feed?.("small")
    const out = await callTool(client, "terminal_output", {
      sessionId: desc.id as string,
      clean: true,
      lastBytes: 4096,
    })
    expect(out.text).toBe("small")
    expect(out.truncated).toBe(false)
    await close()
  })

  it("default (no lastBytes) carries no truncated flag — output shape unchanged", async () => {
    const { client, sink, close } = await buildHarness()
    const desc = await callTool(client, "terminal_start", {
      argv: ["bash"],
      cwd: "/tmp",
    })
    sink.feed?.("plain-chunk")
    const out = await callTool(client, "terminal_output", {
      sessionId: desc.id as string,
    })
    expect(out.truncated).toBeUndefined()
    expect(typeof out.b64).toBe("string")
    await close()
  })
})
