/**
 * `DAEMON_TOOL_NAMES` (daemon-tool-names.generated.ts) must be EXACTLY the
 * tool surface a daemon registers: `agentproto app validate` checks an app's
 * `ui.tools` against it, so a missing name rejects a valid app (every
 * session-chat tool beyond the old hand-kept list did) and a stale one lets
 * a typo through.
 *
 * Boots a real gateway (isolated HOME, nothing persisted) with every
 * conditional surface wired: a pairing + host registry stub (pair_*,
 * device_*) and the llm-endpoint tools, which the daemon only registers when
 * `features.llmEndpoint` is on (registered here on a scratch server, so no
 * sidecar starts). Then compares `tools/list` to the generated list.
 *
 * Regenerate after adding, renaming or removing a daemon tool:
 *   pnpm --filter @agentproto/runtime gen:daemon-tool-names
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createMcpServer } from "@agentproto/mcp-server"
import { DAEMON_TOOL_NAMES } from "../daemon-tool-names.generated.js"

const GENERATED = join(dirname(fileURLToPath(import.meta.url)), "..", "daemon-tool-names.generated.ts")
const UPDATE = process.env.UPDATE_DAEMON_TOOL_NAMES === "1"

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

/** An object whose every method resolves to undefined. */
function noopStub(): never {
  return new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : async () => undefined) }) as never
}

const noopFn = (): never => (async () => undefined) as never
const listFn = (): never => (async () => []) as never

let home = ""

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "daemon-tool-names-"))
  vi.stubEnv("HOME", home)
  vi.stubEnv("AGENTPROTO_HOME", join(home, ".agentproto"))
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

async function registeredToolNames(): Promise<string[]> {
  // Imported after HOME is stubbed: some modules resolve ~/.agentproto at load.
  const { createGateway } = await import("../index.js")
  const { registerLlmEndpointTools } = await import("../llm-endpoint-tools.js")
  const workspace = await mkdtemp(join(home, "ws-"))
  const gateway = await createGateway({
    workspace,
    specs: [],
    port: await freePort(),
    boot: false,
    persist: false,
    persistPath: join(workspace, "sessions.json"),
    // Every optional dependency `agentproto serve` wires, stubbed: several
    // tool families only register when theirs is present (workflow_* needs
    // an agent resolver, pair_*/device_* the pairing registry, ...). The
    // tools close over these; listing them calls nothing beyond lifecycle
    // hooks (shutdown on stop), so every method is a no-op.
    pairingRegistry: noopStub(),
    hostRegistry: noopStub(),
    joinTokens: noopStub(),
    resolveAgentAdapter: noopFn(),
    installAgentAdapter: noopFn(),
    listAgentAdapters: listFn(),
    listBrowserAdapters: listFn(),
    resolveBrowserAdapter: noopFn(),
    listCatalogModels: listFn(),
    listHarnessCapabilities: listFn(),
    listWorktreeStatuses: listFn(),
    provisionWorktree: noopFn(),
    readBranchGcVerdict: noopFn(),
    recordBranchGcVerdict: noopFn(),
    resolveOpenPr: noopFn(),
    resolvePrState: noopFn(),
    runBranchGc: noopFn(),
    runWorktreeAutoReclaim: noopFn(),
    runWorktreeGc: noopFn(),
    listSandboxProviders: listFn(),
    resolveSandboxProvider: noopFn(),
  })
  const names = new Set<string>()
  try {
    const client = new Client({ name: "daemon-tool-names", version: "0" }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway.url}/mcp`)))
    for (const t of (await client.listTools()).tools) names.add(t.name)
    await client.close()
  } finally {
    await gateway.stop()
  }

  const { server: scratch } = await createMcpServer({ specs: [], name: "llm-endpoint-scratch", version: "0" })
  registerLlmEndpointTools(scratch, { registry: {} as never })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await scratch.connect(b)
  const c = new Client({ name: "scratch", version: "0" }, { capabilities: {} })
  await c.connect(a)
  for (const t of (await c.listTools()).tools) names.add(t.name)
  await c.close()

  return [...names].sort()
}

function render(names: readonly string[]): string {
  return [
    "// GENERATED by src/__tests__/daemon-tool-names.test.ts, do not edit.",
    "// Regenerate: pnpm --filter @agentproto/runtime gen:daemon-tool-names",
    "",
    "/** Every MCP tool a daemon's gateway can register (conditional surfaces",
    " *  included: pairing/devices, llm-endpoint). Read by `agentproto app",
    " *  validate` to check an app's `ui.tools`. */",
    "export const DAEMON_TOOL_NAMES: readonly string[] = [",
    ...names.map(n => `  ${JSON.stringify(n)},`),
    "]",
    "",
  ].join("\n")
}

describe("DAEMON_TOOL_NAMES", () => {
  it("is exactly the daemon's registered tool surface", async () => {
    const actual = await registeredToolNames()
    expect(actual.length).toBeGreaterThan(100)
    if (UPDATE) {
      await writeFile(GENERATED, render(actual), "utf8")
      return
    }
    const missing = actual.filter(n => !DAEMON_TOOL_NAMES.includes(n))
    const stale = DAEMON_TOOL_NAMES.filter(n => !actual.includes(n))
    expect(
      { missing, stale },
      "daemon-tool-names.generated.ts is out of date: run pnpm --filter @agentproto/runtime gen:daemon-tool-names",
    ).toEqual({ missing: [], stale: [] })
    expect(await readFile(GENERATED, "utf8")).toBe(render(actual))
  }, 60_000)
})
