/**
 * Terminal gate tests — `terminal_start` argv[0] must pass the SAME
 * allowlist check `command_execute` applies, per the workspace's
 * three-valued `terminalGate` mode ("allowlist" | "all" | "off").
 *
 * A three-valued mode resolved per workspace with a global default:
 *   - "allowlist" (shipped default) — gate through the allowlist;
 *   - "all" — no check (a deliberate operator decision);
 *   - "off" — refused outright (the door is CLOSED, not the gate).
 * Resolution: workspace file > AGENTPROTO_TERMINAL_GATE env > default.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { loadTerminalGateMode, TERMINAL_GATE_ENV } from "../command-allowlist.js"
import { registerSessionTools } from "../session-tools.js"
import { createSessionsRegistry, type PtyFactory, type PtyProcess } from "../sessions.js"

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

let workspace: string

async function harness(): Promise<{ client: Client; close: () => Promise<void> }> {
  const registry = createSessionsRegistry({ persist: false, spawnPty: fakePtyFactory() })
  const { server } = await createMcpServer({ specs: [], name: "test", version: "0" })
  registerSessionTools(server, { registry, workspace, ptyEnabled: true })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0" })
  await client.connect(clientTransport)
  return { client, close: () => client.close() }
}

async function writeAllowlist(body: Record<string, unknown>): Promise<void> {
  await mkdir(join(workspace, ".agentproto"), { recursive: true })
  await writeFile(join(workspace, ".agentproto", "allowed-commands.json"), JSON.stringify(body))
}

async function callTerminalStart(client: Client, argv: string[]): Promise<CallResult> {
  const result = (await client.callTool({
    name: "terminal_start",
    arguments: { argv, cwd: workspace },
  })) as CallResult
  return result
}

interface CallResult {
  isError?: boolean
  content?: Array<{ type: string; text?: string }>
}

function text(result: CallResult): string {
  return result.content?.map(c => c.text ?? "").join("\n") ?? ""
}

beforeEach(async () => {
  delete process.env[TERMINAL_GATE_ENV]
  workspace = await mkdtemp(join(tmpdir(), "terminal-gate-"))
})

afterEach(async () => {
  delete process.env[TERMINAL_GATE_ENV]
  await rm(workspace, { recursive: true, force: true })
})

describe("loadTerminalGateMode", () => {
  it("defaults to allowlist when neither the file nor the env sets a mode", async () => {
    expect(await loadTerminalGateMode(workspace)).toBe("allowlist")
  })

  it("the workspace file's setting wins over the env global default", async () => {
    await writeAllowlist({ version: 1, commands: [], terminalGate: "off" })
    process.env[TERMINAL_GATE_ENV] = "all"
    // Deliberate precedence: the env var is the GLOBAL DEFAULT, so an
    // explicit workspace setting beats it (opposite of loadSandboxConfig).
    expect(await loadTerminalGateMode(workspace)).toBe("off")
  })

  it("falls back to the env var when the file has no terminalGate", async () => {
    await writeAllowlist({ version: 1, commands: [] })
    process.env[TERMINAL_GATE_ENV] = "all"
    expect(await loadTerminalGateMode(workspace)).toBe("all")
  })

  it("an unrecognised value resolves to allowlist, not all", async () => {
    await writeAllowlist({ version: 1, commands: [], terminalGate: "yes please" })
    expect(await loadTerminalGateMode(workspace)).toBe("allowlist")
    process.env[TERMINAL_GATE_ENV] = "open sesame"
    expect(await loadTerminalGateMode(workspace)).toBe("allowlist")
  })
})

describe("terminal_start — terminal gate", () => {
  it("under the default allowlist mode, a non-allowlisted argv[0] is refused and the message names the file and the escape", async () => {
    await writeAllowlist({ version: 1, commands: ["git"] })
    const { client, close } = await harness()
    const result = await callTerminalStart(client, ["not-allowed-bin", "-x"])
    expect(result.isError).toBe(true)
    const msg = text(result)
    expect(msg).toContain("not-allowed-bin")
    expect(msg).toContain(join(workspace, ".agentproto", "allowed-commands.json"))
    expect(msg).toContain('"terminalGate": "all"')
    expect(msg).toContain(TERMINAL_GATE_ENV)
    await close()
  })

  it("under allowlist, an allowlisted argv[0] spawns", async () => {
    await writeAllowlist({ version: 1, commands: ["bash"] })
    const { client, close } = await harness()
    const result = await callTerminalStart(client, ["bash", "-l"])
    expect(result.isError).toBeFalsy()
    expect(text(result)).toContain('"pid"')
    await close()
  })

  it("under allowlist, an argv-constrained entry is honoured (prefix match)", async () => {
    await writeAllowlist({
      version: 1,
      commands: [{ command: "git", args: ["status"] }],
    })
    const { client, close } = await harness()
    const ok = await callTerminalStart(client, ["git", "status", "--short"])
    expect(ok.isError).toBeFalsy()
    const refused = await callTerminalStart(client, ["git", "push"])
    expect(refused.isError).toBe(true)
    await close()
  })

  it('"terminalGate": "all" in the workspace file lets a non-allowlisted argv through', async () => {
    await writeAllowlist({ version: 1, commands: [], terminalGate: "all" })
    const { client, close } = await harness()
    const result = await callTerminalStart(client, ["totally-unknown-bin"])
    expect(result.isError).toBeFalsy()
    await close()
  })

  it('"terminalGate": "off" refuses even an allowlisted argv', async () => {
    await writeAllowlist({ version: 1, commands: ["bash"], terminalGate: "off" })
    const { client, close } = await harness()
    const result = await callTerminalStart(client, ["bash"])
    expect(result.isError).toBe(true)
    const msg = text(result)
    expect(msg).toContain("terminal_start is disabled")
    expect(msg).toContain('"terminalGate"')
    await close()
  })

  it("the env var applies when the workspace file is silent", async () => {
    await writeAllowlist({ version: 1, commands: [] })
    process.env[TERMINAL_GATE_ENV] = "all"
    const { client, close } = await harness()
    const result = await callTerminalStart(client, ["env-only-bin"])
    expect(result.isError).toBeFalsy()
    await close()
  })

  it("with no allowlist file at all, the default mode refuses (fail toward the gate)", async () => {
    const { client, close } = await harness()
    const result = await callTerminalStart(client, ["bash"])
    expect(result.isError).toBe(true)
    await close()
  })
})
