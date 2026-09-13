/**
 * Regression tests for cwd → workspaceSlug reverse-mapping on `terminal_start`.
 *
 * A SessionDescriptor carries only `workspaceSlug`, and for a long time only
 * POST /sessions/agent (spawnAgentSession) derived it from `cwd`. Every other
 * spawn path — terminal_start, POST /sessions/terminal, POST /sessions — dumped
 * the session into "default" even when its cwd sat squarely inside a registered
 * workspace. Measured on one real daemon: 160 of 209 sessions carried
 * "default", which makes the slug useless as a grouping key for any client
 * (the VS Code extension had to re-derive it from cwd itself).
 *
 * These pin the terminal_start arm: an explicit slug still wins, a cwd inside a
 * registered workspace resolves to that workspace, an unregistered cwd stays
 * "default", and an unreadable registry never breaks the spawn.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import type { WorkspacesConfig } from "../workspaces-config.js"

/** Stubbed registry contents + failure toggle, controlled per test. */
const wsState = vi.hoisted(() => ({
  config: { version: 1, workspaces: [] } as WorkspacesConfig,
  throws: false,
}))

vi.mock("../workspaces-config.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../workspaces-config.js")>()
  return {
    ...actual,
    // findWorkspaceByPath stays REAL — the longest-prefix rule under test.
    loadWorkspacesConfig: vi.fn(async () => {
      if (wsState.throws) throw new Error("registry unreadable")
      return wsState.config
    }),
  }
})

const { registerSessionTools } = await import("../session-tools.js")
const { createSessionsRegistry } = await import("../sessions.js")
import type { PtyFactory, PtyProcess } from "../sessions.js"

function fakePtyFactory(): PtyFactory {
  return (): PtyProcess => ({
    pid: 4242,
    write: () => {},
    resize: () => {},
    kill: () => {},
    onData: () => {},
    onExit: () => {},
  })
}

async function harness(): Promise<{ client: Client; close: () => Promise<void> }> {
  const registry = createSessionsRegistry({ persist: false, spawnPty: fakePtyFactory() })
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
  registerSessionTools(server, { registry, workspace: process.cwd(), ptyEnabled: true })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0" })
  await client.connect(clientTransport)
  return { client, close: () => client.close() }
}

/** Start a terminal and read back the slug the daemon actually assigned. */
async function startAndReadSlug(
  client: Client,
  args: Record<string, unknown>,
): Promise<string | undefined> {
  const result = await client.callTool({ name: "terminal_start", arguments: args })
  expect(result.isError).toBeFalsy()
  const content = result.content as Array<{ type: string; text?: string }>
  const text = content.find(c => c.type === "text")?.text ?? "{}"
  return (JSON.parse(text) as { workspaceSlug?: string }).workspaceSlug
}

beforeEach(() => {
  // This file tests cwd → workspaceSlug reverse-mapping, not the terminal
  // gate — opt out explicitly rather than weakening the default.
  process.env.AGENTPROTO_TERMINAL_GATE = "all"
  wsState.throws = false
  wsState.config = {
    version: 1,
    active: "studio",
    workspaces: [
      { slug: "studio", path: "/Code/studio", addedAt: "", updatedAt: "" },
      { slug: "ts", path: "/Code/studio/projects/ts", addedAt: "", updatedAt: "" },
    ],
  }
})

afterEach(() => {
  delete process.env.AGENTPROTO_TERMINAL_GATE
})

describe("terminal_start — cwd → workspaceSlug", () => {
  it("resolves a cwd inside a registered workspace instead of defaulting", async () => {
    const { client, close } = await harness()
    // THE BUG: this used to come back "default".
    expect(await startAndReadSlug(client, { argv: ["bash"], cwd: "/Code/studio/apps/web" })).toBe(
      "studio",
    )
    await close()
  })

  it("prefers the most specific registered workspace", async () => {
    const { client, close } = await harness()
    expect(
      await startAndReadSlug(client, { argv: ["bash"], cwd: "/Code/studio/projects/ts/packages/x" }),
    ).toBe("ts")
    await close()
  })

  it("an explicit workspaceSlug still wins over the cwd", async () => {
    const { client, close } = await harness()
    expect(
      await startAndReadSlug(client, {
        argv: ["bash"],
        cwd: "/Code/studio/apps/web",
        workspaceSlug: "ts",
      }),
    ).toBe("ts")
    await close()
  })

  it("stays 'default' for a cwd outside every registered workspace", async () => {
    const { client, close } = await harness()
    expect(await startAndReadSlug(client, { argv: ["bash"], cwd: "/tmp/scratch" })).toBe("default")
    await close()
  })

  it("does not match across a segment boundary", async () => {
    const { client, close } = await harness()
    // "/Code/studio-old" must not be swallowed by workspace "/Code/studio".
    expect(await startAndReadSlug(client, { argv: ["bash"], cwd: "/Code/studio-old/src" })).toBe(
      "default",
    )
    await close()
  })

  it("an unreadable registry degrades to 'default' rather than failing the spawn", async () => {
    const { client, close } = await harness()
    wsState.throws = true
    expect(await startAndReadSlug(client, { argv: ["bash"], cwd: "/Code/studio/apps/web" })).toBe(
      "default",
    )
    await close()
  })
})
