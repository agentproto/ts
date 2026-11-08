/**
 * `harness` is the canonical name of the agent CLI a session runs; `adapter`
 * is its deprecated alias. Additive and non-breaking: every new name works,
 * every old name still works and returns a dated warning.
 *
 * Covers: `harness_models` / `harness_install` (and their `adapter_*`
 * twins), `agent_start({ harness })` vs `agent_start({ adapter })`, the
 * descriptor always carrying `harness`, `defaults.harnesses` over
 * `defaults.adapters`, `daemon.harnessCacheRetentionDays`, and the
 * `GET /harnesses` + `POST /harnesses/:slug/install` HTTP routes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { registerAgentTools } from "../agent-tools.js"
import { createSessionsRegistry, stampHarness, type AgentSessionLike } from "../sessions.js"
import { startHttpServer } from "../http-server.js"
import type {
  AdapterInstallResult,
  AdapterListEntry,
  AgentAdapterResolver,
} from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import { harnessDefaultsFor, harnessDefaultsMap, resolveSpawnDefaults } from "../spawn-defaults.js"
import { harnessCacheRetentionDays, harnessConfigDeprecations, loadConfig } from "../config.js"
import { CONFIG_KEYS } from "../config-schema.js"
import { configGet } from "../config-tools.js"
import { ADAPTER_FIELD_DEPRECATION, adapterDeprecation, resolveHarnessAlias } from "../harness-alias.js"

const DEPRECATION = (oldName: string, newName: string) =>
  `\`${oldName}\` is deprecated and will be removed in the next major of @agentproto/runtime; use \`${newName}\``

function body(result: unknown): Record<string, any> {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text) as Record<string, any>
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true
}

const HERMES: AdapterListEntry = {
  slug: "hermes",
  name: "Hermes",
  version: "1.2.3",
  description: "Hermes harness.",
  protocol: "acp",
  streaming: true,
  packageName: "@agentproto/harness-hermes",
  modes: [],
  models: ["z-ai/glm-5.2", "gpt-5"],
  modelDetails: [
    { id: "z-ai/glm-5.2", provider: "openrouter" },
    { id: "gpt-5", provider: "openai" },
  ],
}

const INSTALL_RESULT = { ok: true, slug: "hermes", status: "ready", message: "installed" } as AdapterInstallResult

async function mcpClient(opts: {
  startSession?: (...args: any[]) => Promise<AgentSessionLike>
} = {}) {
  const registry = createSessionsRegistry({ persist: false })
  const resolveAgentAdapter: AgentAdapterResolver = async () => ({
    startSession: (opts.startSession ?? fakeStartSession()) as any,
    commandPreview: "mock-adapter",
  })
  const installAgentAdapter = vi.fn(async () => INSTALL_RESULT)
  const server = new McpServer({ name: "harness-canonical-names", version: "0.0.0" })
  registerAgentTools(server, {
    registry,
    resolveAgentAdapter,
    listAgentAdapters: async () => [HERMES],
    installAgentAdapter,
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "harness-canonical-names-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return { client, registry, installAgentAdapter }
}

function fakeStartSession() {
  return vi.fn(async () => ({
    sessionId: "harness_canonical_test",
    send: async function* () {},
    cancel: async () => {},
    close: async () => {},
  }))
}

let previousHome: string | undefined
let home: string

beforeEach(async () => {
  previousHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-harness-canonical-"))
  process.env.HOME = home
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

describe("harness_models / adapter_models", () => {
  it("harness_models exists and lists the same rows adapter_models does", async () => {
    const { client } = await mcpClient()
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(["harness_models", "harness_install"]))

    const canonical = body(await client.callTool({ name: "harness_models", arguments: { harness: "hermes" } }))
    const legacy = body(await client.callTool({ name: "adapter_models", arguments: { adapter: "hermes" } }))
    expect(canonical.models).toEqual(HERMES.modelDetails)
    expect(legacy.models).toEqual(canonical.models)
    expect(canonical.warnings).toBeUndefined()
    expect(legacy.warnings).toEqual([DEPRECATION("adapter_models", "harness_models")])
  })

  it("harness_models pages like adapter_models and accepts the deprecated `adapter` argument with a warning", async () => {
    const { client } = await mcpClient()
    const page = body(await client.callTool({ name: "harness_models", arguments: { harness: "hermes", limit: 1 } }))
    expect(page.items).toEqual([HERMES.modelDetails![0]])
    expect(page.total).toBe(2)

    const viaAlias = body(await client.callTool({ name: "harness_models", arguments: { adapter: "hermes" } }))
    expect(viaAlias.models).toEqual(HERMES.modelDetails)
    expect(viaAlias.warnings).toEqual([DEPRECATION("adapter", "harness")])
  })

  it("harness_models names an unknown harness and refuses a missing one", async () => {
    const { client } = await mcpClient()
    const unknown = await client.callTool({ name: "harness_models", arguments: { harness: "nope" } })
    expect(isError(unknown)).toBe(true)
    expect((unknown as { content: Array<{ text: string }> }).content[0]!.text).toBe(
      'harness_models: harness "nope" was not found.',
    )
    const missing = await client.callTool({ name: "harness_models", arguments: {} })
    expect(isError(missing)).toBe(true)
  })
})

describe("harness_install / adapter_install", () => {
  it("harness_install installs by slug and returns the installer's result verbatim", async () => {
    const { client, installAgentAdapter } = await mcpClient()
    const result = body(await client.callTool({ name: "harness_install", arguments: { slug: "hermes" } }))
    expect(result).toEqual(INSTALL_RESULT)
    expect(installAgentAdapter).toHaveBeenCalledWith("hermes")
  })

  it("adapter_install still installs, with a dated warning", async () => {
    const { client, installAgentAdapter } = await mcpClient()
    const result = body(await client.callTool({ name: "adapter_install", arguments: { slug: "hermes" } }))
    expect(result).toEqual({
      ...INSTALL_RESULT,
      warnings: [DEPRECATION("adapter_install", "harness_install")],
    })
    expect(installAgentAdapter).toHaveBeenCalledWith("hermes")
  })
})

describe("harness_list", () => {
  it("returns its rows under `harnesses`, mirrored under the deprecated `adapters`", async () => {
    const { client } = await mcpClient()
    const listed = body(await client.callTool({ name: "harness_list", arguments: {} }))
    expect(listed.harnesses.map((h: { slug: string }) => h.slug)).toEqual(["hermes"])
    expect(listed.adapters).toEqual(listed.harnesses)
  })
})

describe("agent_start: harness is the field, adapter the deprecated alias", () => {
  it("agent_start({ harness }) spawns on that harness with no warning", async () => {
    const { client } = await mcpClient()
    const result = body(await client.callTool({ name: "agent_start", arguments: { harness: "hermes", cwd: "/tmp" } }))
    expect(result.id).toMatch(/^sess_/)
    expect(result.harness).toBe("hermes")
    expect(result.adapterSlug).toBe("hermes")
    expect(result.warnings ?? []).not.toContain(`agent_start: ${ADAPTER_FIELD_DEPRECATION}`)
  })

  it("agent_start({ adapter }) still spawns, with a dated warning", async () => {
    const { client } = await mcpClient()
    const result = body(await client.callTool({ name: "agent_start", arguments: { adapter: "hermes", cwd: "/tmp" } }))
    expect(result.id).toMatch(/^sess_/)
    expect(result.harness).toBe("hermes")
    expect(result.warnings).toContain(`agent_start: ${DEPRECATION("adapter", "harness")}`)
  })

  it("harness wins over adapter when both are given", async () => {
    const { client } = await mcpClient()
    const result = body(
      await client.callTool({ name: "agent_start", arguments: { harness: "hermes", adapter: "claude-code", cwd: "/tmp" } }),
    )
    expect(result.harness).toBe("hermes")
    expect(result.adapterSlug).toBe("hermes")
  })

  it("documents harness as the field and adapter as the deprecated alias", async () => {
    const { client } = await mcpClient()
    const { tools } = await client.listTools()
    const props = (tools.find(t => t.name === "agent_start")!.inputSchema as { properties: Record<string, { description?: string }> }).properties
    expect(props.harness!.description).toMatch(/^Harness slug/)
    expect(props.adapter!.description).toMatch(/^Deprecated alias of `harness`/)
  })

  it("resolves harness ?? adapter ?? preset.harness ?? preset.adapter", () => {
    expect(resolveHarnessAlias({ harness: "a", adapter: "b" }, { harness: "c", adapter: "d" }).harness).toBe("a")
    expect(resolveHarnessAlias({ adapter: "b" }, { harness: "c", adapter: "d" }).harness).toBe("b")
    expect(resolveHarnessAlias({}, { harness: "c", adapter: "d" }).harness).toBe("c")
    expect(resolveHarnessAlias({}, { adapter: "d" }).harness).toBe("d")
    expect(resolveHarnessAlias({}, { adapter: "d" }).warnings).toEqual([])
    expect(resolveHarnessAlias({ adapter: "b" }).warnings).toEqual([ADAPTER_FIELD_DEPRECATION])
  })
})

describe("the session descriptor always carries harness", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agp-harness-desc-"))
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it("a persisted row with only `adapterSlug` reads back with `harness` on list(), get() and summaries", () => {
    const persistPath = join(tmp, "sessions.json")
    writeFileSync(
      persistPath,
      JSON.stringify({
        savedAt: "2026-07-23T00:00:00Z",
        sessions: [
          {
            id: "sess_legacy",
            kind: "agent-cli",
            workspaceSlug: "default",
            command: "hermes (agent)",
            pid: null,
            status: "exited",
            exitCode: 0,
            startedAt: "2026-07-23T00:00:00Z",
            adapterSlug: "hermes",
            cwd: "/tmp",
          },
        ],
      }),
    )
    const registry = createSessionsRegistry({ persistPath })
    expect(registry.get("sess_legacy")?.harness).toBe("hermes")
    expect(registry.list().find(s => s.id === "sess_legacy")?.harness).toBe("hermes")
    expect(registry.listSummaries().summaries.find(s => s.id === "sess_legacy")?.harness).toBe("hermes")
  })

  it("stampHarness fills harness from adapterSlug and never overwrites an explicit one", () => {
    const legacy: { adapterSlug?: string; harness?: string } = { adapterSlug: "codex" }
    stampHarness(legacy)
    expect(legacy.harness).toBe("codex")
    const explicit = { adapterSlug: "codex", harness: "opencode" }
    stampHarness(explicit)
    expect(explicit.harness).toBe("opencode")
    const shell: { adapterSlug?: string; harness?: string } = {}
    stampHarness(shell)
    expect(shell.harness).toBeUndefined()
  })
})

describe("config: defaults.harnesses over defaults.adapters", () => {
  it("a field set under defaults.harnesses wins over the same field under defaults.adapters", () => {
    const defaults = {
      adapters: { hermes: { skills: ["old"], contextProfile: "lean" } },
      harnesses: { hermes: { skills: ["new"] } },
    }
    expect(harnessDefaultsFor(defaults, "hermes")).toEqual({ skills: ["new"], contextProfile: "lean" })
    expect(resolveSpawnDefaults(defaults, "hermes", {}).skills).toEqual(["new"])
  })

  it("defaults.adapters alone still works, and reports a deprecation", () => {
    const defaults = { adapters: { hermes: { skills: ["legacy"] } } }
    expect(resolveSpawnDefaults(defaults, "hermes", {}).skills).toEqual(["legacy"])
    expect(harnessDefaultsMap(defaults)).toEqual({ hermes: { skills: ["legacy"] } })
    expect(harnessConfigDeprecations({ defaults })).toEqual([
      DEPRECATION("defaults.adapters", "defaults.harnesses") + " (a field set under defaults.harnesses.<slug> wins)",
    ])
    expect(harnessConfigDeprecations({ defaults: { harnesses: { hermes: { skills: ["x"] } } } })).toEqual([])
  })

  it("loadConfig warns once about the old key and never rewrites the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agp-harness-cfg-"))
    const file = join(dir, "config.json")
    const raw = JSON.stringify({ defaults: { adapters: { hermes: { skills: ["legacy"] } } } })
    writeFileSync(file, raw)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const cfg = await loadConfig(file)
      await loadConfig(file)
      expect(cfg.defaults?.adapters?.hermes?.skills).toEqual(["legacy"])
      expect(cfg.defaults?.harnesses).toBeUndefined()
      const lines = warn.mock.calls.map(c => String(c[0])).filter(l => l.includes("defaults.adapters"))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain(DEPRECATION("defaults.adapters", "defaults.harnesses"))
      const { readFileSync } = await import("node:fs")
      expect(readFileSync(file, "utf8")).toBe(raw)
    } finally {
      warn.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("daemon.harnessCacheRetentionDays wins, the old key alone still works", () => {
    expect(harnessCacheRetentionDays({ daemon: { harnessCacheRetentionDays: 3, adapterCacheRetentionDays: 9 } })).toBe(3)
    expect(harnessCacheRetentionDays({ daemon: { adapterCacheRetentionDays: 9 } })).toBe(9)
    expect(harnessConfigDeprecations({ daemon: { adapterCacheRetentionDays: 9 } })).toEqual([
      DEPRECATION("daemon.adapterCacheRetentionDays", "daemon.harnessCacheRetentionDays"),
    ])
  })

  it("the key registry exposes the new keys and flags the old ones deprecated", async () => {
    const paths = CONFIG_KEYS.map(k => k.path)
    expect(paths).toEqual(expect.arrayContaining([
      "defaults.harnesses.*.skills",
      "defaults.harnesses.*.auth.mode",
      "daemon.harnessCacheRetentionDays",
    ]))
    const legacy = CONFIG_KEYS.find(k => k.path === "defaults.adapters.*.skills")
    expect(legacy?.deprecated).toEqual({
      replacedBy: "defaults.harnesses.*.skills",
      message: adapterDeprecation("defaults.adapters", "defaults.harnesses"),
    })
    expect(CONFIG_KEYS.find(k => k.path === "defaults.harnesses.*.skills")?.deprecated).toBeUndefined()

    const result = await configGet(
      { keys: ["daemon.harnessCacheRetentionDays", "daemon.adapterCacheRetentionDays"] },
      {
        loadCfg: async () => ({ daemon: { adapterCacheRetentionDays: 4 } }),
        configPath: () => join(home, "config.json"),
        bootConfig: { daemon: { adapterCacheRetentionDays: 4 } },
        events: createRuntimeEvents(),
      } as never,
    )
    const canonical = result.keys.find(k => k.path === "daemon.harnessCacheRetentionDays")!
    const old = result.keys.find(k => k.path === "daemon.adapterCacheRetentionDays")!
    expect(canonical.effective).toBe(4)
    expect(canonical.deprecated).toBeUndefined()
    expect(old.deprecated?.replacedBy).toBe("daemon.harnessCacheRetentionDays")
  })
})

// ── HTTP ────────────────────────────────────────────────────────────────

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

function noopConversations(): ConversationStore {
  return {
    async open() {},
    async appendTurn() {},
    async read() {
      return { meta: {} as never, turns: [] }
    },
    async list() {
      return []
    },
    pathFor: (id: string) => id,
  }
}

function noopHeartbeat(): HeartbeatRunner {
  return { start() {}, stop() {}, async fireNow() {} }
}

async function withHttp(fn: (base: string) => Promise<void>): Promise<void> {
  const port = await freePort()
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    mcpServerFactory: async () => (await createMcpServer({ specs: [], name: "main", version: "0" })).server,
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    meta: { workspace: process.cwd(), registered: [] },
    listAgentAdapters: async () => [HERMES],
    installAgentAdapter: async () => INSTALL_RESULT,
  })
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await http.stop()
  }
}

describe("HTTP: /harnesses", () => {
  it("GET /harnesses lists under `harnesses` (and the deprecated `adapters` mirror)", async () => {
    await withHttp(async base => {
      const res = await fetch(`${base}/harnesses`)
      expect(res.status).toBe(200)
      const json = (await res.json()) as { harnesses: AdapterListEntry[]; adapters: AdapterListEntry[]; warnings?: string[] }
      expect(json.harnesses.map(h => h.slug)).toEqual(["hermes"])
      expect(json.adapters).toEqual(json.harnesses)
      expect(json.warnings).toBeUndefined()
    })
  })

  it("GET /adapters still lists, with a dated warning", async () => {
    await withHttp(async base => {
      const json = (await (await fetch(`${base}/adapters`)).json()) as { adapters: AdapterListEntry[]; warnings: string[] }
      expect(json.adapters.map(h => h.slug)).toEqual(["hermes"])
      expect(json.warnings).toEqual([DEPRECATION("GET /adapters", "GET /harnesses")])
    })
  })

  it("POST /harnesses/:slug/install installs; the /adapters spelling warns", async () => {
    await withHttp(async base => {
      const canonical = await (await fetch(`${base}/harnesses/hermes/install`, { method: "POST" })).json()
      expect(canonical).toEqual(INSTALL_RESULT)
      const legacy = await (await fetch(`${base}/adapters/hermes/install`, { method: "POST" })).json()
      expect(legacy).toEqual({
        ...INSTALL_RESULT,
        warnings: [DEPRECATION("POST /adapters/:slug/install", "POST /harnesses/:slug/install")],
      })
    })
  })
})
