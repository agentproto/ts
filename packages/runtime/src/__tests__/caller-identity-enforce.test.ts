/**
 * `defaults.identity.sessionTokens: "enforce"` (AIP-46 §Session principals,
 * rules 3, 4, 7 and 8) and the operator-only configuration rule
 * (AIP-46 §Operator-only configuration).
 *
 * Enforce refuses, before the handler acts, a request whose session token is
 * malformed, unknown or revoked (`identity_unverified`), whose token names
 * another session than its claim (`identity_mismatch`), and a claim without a
 * token naming a host-spawned session the daemon delivered a token to
 * (`identity_unverified`). It never refuses an anonymous caller, a verified
 * one, an external identifier, or a claim naming a session the daemon could
 * not deliver a token to (rule 8: enforcement never outruns delivery).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createMcpServer } from "@agentproto/mcp-server"

import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent, type SessionsRegistry } from "../sessions.js"
import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { startHttpServer, type AgentAdapterResolver } from "../http-server.js"
import { createRuntimeEvents } from "../events.js"
import { cdContractLine } from "../agents-md.js"
import { configSet, registerConfigTools, type ConfigToolsDeps, type ConfigWriteCaller } from "../config-tools.js"
import { loadConfig, saveConfig, type AgentprotoConfig } from "../config.js"
import { validateConfig } from "../config-schema.js"
import {
  attachSessionCredentialStore,
  clearSessionCredentials,
  mintSessionToken,
} from "../session-credentials.js"
import type { ConversationStore } from "../conversations.js"
import type { HeartbeatRunner } from "../heartbeat.js"
import type { AcpMcpServer } from "@agentproto/acp"

const TOKEN_HEADER = "x-agentproto-session-token"
const DAEMON_MCP_URL = "http://127.0.0.1:18790/mcp"

type Mode = "off" | "shadow" | "enforce"

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
  return {
    start() {},
    stop() {},
    async fireNow() {},
  }
}

let acpCounter = 0
function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: `acp_enforce_${acpCounter++}`,
    async *send(): AsyncIterable<AgentStreamEvent> {
      yield { kind: "turn-end", reason: "completed" } as AgentStreamEvent
    },
    async cancel() {},
    async close() {},
  }
}

function recordingResolver(): { resolver: AgentAdapterResolver; calls: Array<{ mcpServers?: AcpMcpServer[] }> } {
  const calls: Array<{ mcpServers?: AcpMcpServer[] }> = []
  const resolver: AgentAdapterResolver = async () => ({
    async startSession(o: { mcpServers?: AcpMcpServer[] }) {
      calls.push({ mcpServers: o.mcpServers })
      return fakeAgentSession()
    },
    commandPreview: "mock-adapter",
  })
  return { resolver, calls }
}

function tokenOf(mcpServers: readonly AcpMcpServer[] | undefined): string | undefined {
  for (const entry of mcpServers ?? []) {
    const found = Object.entries(entry.headers ?? {}).find(([k]) => k.toLowerCase() === TOKEN_HEADER)
    if (found) return found[1]
  }
  return undefined
}

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "identity-enforce-"))
  clearSessionCredentials()
  attachSessionCredentialStore({ path: join(tmp, "creds.json") })
})
afterEach(() => {
  clearSessionCredentials()
  rmSync(tmp, { recursive: true, force: true })
})

interface Fixture {
  registry: SessionsRegistry
  claude: string
  claudeToken: string
  claude2: string
  codex: string
  boxed: string
}

/** A registry with a claude-code row (token delivered and minted through the
 *  real store), a second claude-code row, a codex row (no token: the adapter
 *  is not token-delivered) and a sandboxed claude-code row. */
async function fixture(spawnMode: Mode = "shadow"): Promise<Fixture & { spawnCalls: Array<{ mcpServers?: AcpMcpServer[] }> }> {
  const registry = createSessionsRegistry({ persist: false })
  const rec = recordingResolver()
  const deps: SpawnAgentSessionDeps = {
    registry,
    resolveAgentAdapter: rec.resolver,
    resolveAgentsMd: async () => ({ mode: "absent", contractLine: cdContractLine }),
    resolveWorkspaceRules: async () => ({}),
    daemonMcpUrl: DAEMON_MCP_URL,
    loadDefaultsConfig: async () => ({ identity: { sessionTokens: spawnMode } }) as never,
  }
  const spawn = async (adapter: string): Promise<string> => {
    const r = await spawnAgentSession(deps, { adapter, cwd: tmp })
    if (!r.ok) throw new Error(`spawn failed: ${r.message}`)
    return r.descriptor.id
  }
  const claude = await spawn("claude-code")
  const claudeToken = tokenOf(rec.calls[0]?.mcpServers)
  const claude2 = await spawn("claude-code")
  const codex = await spawn("codex")
  const boxed = await spawn("claude-code")
  // A sandboxed placement: the box daemon persists its mounts, so no token
  // is delivered there (rule 8), even if one was minted for the id.
  const boxedDesc = registry.get(boxed)
  if (boxedDesc) boxedDesc.remote = true
  mintSessionToken(boxed)
  return { registry, claude, claudeToken: claudeToken ?? "apst_none", claude2, codex, boxed, spawnCalls: rec.calls }
}

async function startServer(
  mode: Mode,
  registry: SessionsRegistry,
  configTools?: ConfigToolsDeps,
): Promise<{ base: string; stop: () => Promise<void> }> {
  const port = await freePort()
  const http = await startHttpServer({
    port,
    auth: { mode: "none" },
    mcpServerFactory: async () => {
      const { server } = await createMcpServer({ specs: [], name: "main", version: "0" })
      server.tool("probe", "probe", {}, async () => ({ content: [{ type: "text" as const, text: "ok" }] }))
      return server
    },
    conversations: noopConversations(),
    events: createRuntimeEvents(),
    heartbeat: noopHeartbeat(),
    meta: { workspace: process.cwd(), registered: [] },
    sessions: registry,
    identity: { mode: () => mode },
    ...(configTools ? { configTools } : {}),
  } as never)
  return { base: `http://127.0.0.1:${port}`, stop: () => http.stop() }
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "enforce", version: "0" } },
})

async function mcp(
  base: string,
  query: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${base}/mcp${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: INITIALIZE,
  })
  const text = await res.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: res.status, json, text }
}

async function identity(base: string): Promise<any> {
  return (await fetch(`${base}/identity`)).json()
}

/** Wait until `n` requests are counted (the shadow observer may run after
 *  the response on older code). */
async function identityAfter(base: string, n: number): Promise<any> {
  let id: any
  await vi.waitFor(
    async () => {
      id = await identity(base)
      const total = Object.values((id?.counters ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0)
      expect(total).toBe(n)
    },
    { timeout: 3_000 },
  )
  return id
}

describe("identity enforce mode", () => {
  it("T1 shadow: a claim without token naming a delivered claude-code row passes and is counted delivered", async () => {
    const f = await fixture()
    const srv = await startServer("shadow", f.registry)
    try {
      const r = await mcp(srv.base, `?callerSessionId=${f.claude}`)
      expect(r.status).toBe(200)
      const id = await identityAfter(srv.base, 1)
      expect(id.counters.claim_only).toBe(1)
      expect(id.claimOnlyByClass).toEqual({ external: 0, delivered: 1, undelivered: 0, unknown: 0 })
    } finally {
      await srv.stop()
    }
  })

  it("T2 config_set accepts defaults.identity.sessionTokens enforce, and validateConfig does too", async () => {
    const configPath = join(tmp, "config.json")
    await saveConfig({} as AgentprotoConfig, configPath)
    const deps: ConfigToolsDeps = {
      loadCfg: () => loadConfig(configPath),
      saveCfg: next => saveConfig(next, configPath),
      configPath: () => configPath,
      bootConfig: {} as AgentprotoConfig,
      events: createRuntimeEvents(),
    }
    const r = await configSet({ key: "defaults.identity.sessionTokens", value: "enforce" }, deps)
    expect(r.ok).toBe(true)
    expect(validateConfig({ defaults: { identity: { sessionTokens: "enforce" } } } as never).ok).toBe(true)
  })

  it("T3 enforce: the T1 request is refused 403 identity_unverified, on /mcp and on a session route", async () => {
    const f = await fixture()
    const srv = await startServer("enforce", f.registry)
    try {
      const r = await mcp(srv.base, `?callerSessionId=${f.claude}`)
      expect(r.status).toBe(403)
      expect(r.json?.error).toBe("identity_unverified")
      expect(typeof r.json?.message).toBe("string")
      expect(r.text).not.toContain(f.claudeToken)
      const spawn = await fetch(`${srv.base}/sessions/agent?callerSessionId=${f.claude}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adapter: "claude-code", cwd: tmp }),
      })
      expect(spawn.status).toBe(403)
      expect(((await spawn.json()) as { error?: string }).error).toBe("identity_unverified")
      const id = await identity(srv.base)
      expect(id.counters.claim_only).toBe(2)
      expect(id.refused.claim_only).toBe(2)
    } finally {
      await srv.stop()
    }
  })

  it("T4 enforce: token of A with a claim naming B is refused 403 identity_mismatch; T4b a bogus token is identity_unverified", async () => {
    const f = await fixture()
    const srv = await startServer("enforce", f.registry)
    try {
      const r = await mcp(srv.base, `?callerSessionId=${f.claude2}`, { [TOKEN_HEADER]: f.claudeToken })
      expect(r.status).toBe(403)
      expect(r.json?.error).toBe("identity_mismatch")
      expect(r.text).not.toContain(f.claudeToken)
      const bogus = await mcp(srv.base, "", { [TOKEN_HEADER]: "apst_bogus" })
      expect(bogus.status).toBe(403)
      expect(bogus.json?.error).toBe("identity_unverified")
      expect(bogus.text).not.toContain("apst_bogus")
    } finally {
      await srv.stop()
    }
  })

  it("T5 enforce: an external identifier without token passes (rule 7)", async () => {
    const f = await fixture()
    const srv = await startServer("enforce", f.registry)
    try {
      const first = await mcp(srv.base, "?callerSessionId=desk&host=claude-desktop")
      expect(first.status).toBe(200)
      expect(f.registry.get("desk")?.kind).toBe("external")
      const again = await mcp(srv.base, "?callerSessionId=desk&host=claude-desktop")
      expect(again.status).toBe(200)
      const id = await identity(srv.base)
      expect(id.claimOnlyByClass.external).toBe(1)
    } finally {
      await srv.stop()
    }
  })

  it("T6 enforce: a claim naming a codex, a sandboxed or an unknown session passes (rule 8)", async () => {
    const f = await fixture()
    const srv = await startServer("enforce", f.registry)
    try {
      expect((await mcp(srv.base, `?callerSessionId=${f.codex}`)).status).toBe(200)
      expect((await mcp(srv.base, `?callerSessionId=${f.boxed}`)).status).toBe(200)
      expect((await mcp(srv.base, "?callerSessionId=sess_nobody")).status).toBe(200)
      const id = await identity(srv.base)
      expect(id.claimOnlyByClass).toEqual({ external: 0, delivered: 0, undelivered: 2, unknown: 1 })
      expect(id.refused.claim_only).toBe(0)
    } finally {
      await srv.stop()
    }
  })

  it("T8 GET /identity reports claimOnlyByClass and what it enforces", async () => {
    const { SESSION_TOKEN_ADAPTERS } = (await import("../identity-defaults.js")) as unknown as {
      SESSION_TOKEN_ADAPTERS?: ReadonlySet<string>
    }
    const f = await fixture()
    for (const mode of ["shadow", "enforce"] as const) {
      const srv = await startServer(mode, f.registry)
      try {
        const id = await identity(srv.base)
        expect(id.mode).toBe(mode)
        expect(id.claimOnlyByClass).toEqual({ external: 0, delivered: 0, undelivered: 0, unknown: 0 })
        expect(id.enforces?.mode).toBe(mode)
        expect(id.enforces?.sandboxed).toBe(false)
        expect(Array.isArray(id.enforces?.surfaces)).toBe(true)
        expect(id.enforces.surfaces).toContain("/mcp")
        expect([...(id.enforces?.adapters ?? [])].sort()).toEqual([...(SESSION_TOKEN_ADAPTERS ?? [])].sort())
      } finally {
        await srv.stop()
      }
    }
  })

  it("T9 enforce: an anonymous request and a verified request pass, neither counted as refused", async () => {
    const f = await fixture()
    const srv = await startServer("enforce", f.registry)
    try {
      expect((await mcp(srv.base, "")).status).toBe(200)
      expect((await mcp(srv.base, `?callerSessionId=${f.claude}`, { [TOKEN_HEADER]: f.claudeToken })).status).toBe(200)
      expect((await mcp(srv.base, "", { [TOKEN_HEADER]: f.claudeToken })).status).toBe(200)
      const id = await identity(srv.base)
      expect(id.counters).toMatchObject({ anonymous: 1, verified: 2 })
      expect(id.refused).toEqual({ verified: 0, mismatch: 0, invalid_token: 0, claim_only: 0, anonymous: 0 })
    } finally {
      await srv.stop()
    }
  })

  it("T9b enforce: an anonymous POST on a gated session route (the native hook callback shape) is not refused", async () => {
    const f = await fixture()
    const srv = await startServer("enforce", f.registry)
    try {
      const res = await fetch(`${srv.base}/sessions/${f.claude}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      })
      expect(res.status).not.toBe(403)
    } finally {
      await srv.stop()
    }
  })

  it("T10 a spawn in enforce mode mints and injects the credential like shadow; off mints nothing", async () => {
    const enforce = await fixture("enforce")
    expect(tokenOf(enforce.spawnCalls[0]?.mcpServers)).toBeDefined()
    const off = await fixture("off")
    expect(tokenOf(off.spawnCalls[0]?.mcpServers)).toBeUndefined()
  })
})

describe("operator-only configuration", () => {
  async function configFixture(): Promise<{ deps: ConfigToolsDeps; configPath: string; read: () => string }> {
    const configPath = join(tmp, "config.json")
    await saveConfig({ defaults: { messaging: { allowSiblings: false } } } as AgentprotoConfig, configPath)
    return {
      configPath,
      deps: {
        loadCfg: () => loadConfig(configPath),
        saveCfg: next => saveConfig(next, configPath),
        configPath: () => configPath,
        bootConfig: {} as AgentprotoConfig,
        events: createRuntimeEvents(),
      },
      read: () => readFileSync(configPath, "utf8"),
    }
  }

  async function mcpConfigClient(deps: ConfigToolsDeps, caller: ConfigWriteCaller): Promise<Client> {
    const server = new McpServer({ name: "operator-only", version: "0" })
    registerConfigTools(server, deps, caller)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "operator-only-client", version: "0" })
    await client.connect(clientTransport)
    return client
  }

  for (const mode of ["shadow", "enforce"] as const) {
    it(`T7 ${mode}: a session caller cannot write a messaging or identity key, over MCP or PATCH /config; the operator can`, async () => {
      const f = await fixture()
      const cfg = await configFixture()
      const before = cfg.read()
      const isHostSpawned = (id: string): boolean => {
        const d = f.registry.get(id)
        return d !== undefined && d.kind !== "external"
      }

      // MCP: the caller the /mcp factory knows (its trusted claim).
      const session = await mcpConfigClient(cfg.deps, { claimedSessionId: f.claude, isHostSpawned })
      const refused = await session.callTool({ name: "config_set", arguments: { key: "defaults.messaging.allowSiblings", value: true } })
      expect(refused.isError).toBe(true)
      expect(JSON.stringify(refused.content)).toContain("operator_only")
      expect(JSON.stringify(refused.content)).toContain("defaults.messaging.allowSiblings")
      const byToken = await mcpConfigClient(cfg.deps, { credentialSessionId: f.claude, isHostSpawned })
      expect((await byToken.callTool({ name: "config_set", arguments: { key: "defaults.identity.sessionTokens", value: "off" } })).isError).toBe(true)
      expect(cfg.read()).toBe(before)

      // REST: PATCH /config, a session caller by token, by trusted claim, an ancestor key, an unset.
      const srv = await startServer(mode, f.registry, cfg.deps)
      try {
        const patch = (body: unknown, headers: Record<string, string> = {}, query = ""): Promise<Response> =>
          fetch(`${srv.base}/config${query}`, {
            method: "PATCH",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify(body),
          })
        const asSession = { [TOKEN_HEADER]: f.claudeToken }
        const r1 = await patch({ key: "defaults.messaging.allowSiblings", value: true }, asSession)
        expect(r1.status).toBe(403)
        const j1 = (await r1.json()) as { error?: string; message?: string }
        expect(j1.error).toBe("operator_only")
        expect(j1.message).toContain("defaults.messaging.allowSiblings")
        expect(JSON.stringify(j1)).not.toContain(f.claudeToken)
        expect((await patch({ key: "defaults.messaging", value: { allowSiblings: true } }, asSession)).status).toBe(403)
        expect((await patch({ key: "defaults.messaging.allowSiblings", unset: true }, asSession)).status).toBe(403)
        expect((await patch({ key: "defaults.tasks.operatorDelegates", value: [] }, asSession)).status).toBe(403)
        const claimOnly = await patch({ key: "defaults.messaging.allowSiblings", value: true }, {}, `?callerSessionId=${f.claude}`)
        expect(claimOnly.status).toBe(403)
        expect(cfg.read()).toBe(before)

        // Every key under defaults.messaging is protected, the staleness knob
        // included; a key outside the protected set is accepted.
        expect((await patch({ key: "defaults.messaging.pendingPromptStaleMinutes", value: 7 }, asSession)).status).toBe(403)
        expect((await patch({ key: "defaults.agentPromptInterrupt", value: true }, asSession)).status).toBe(200)

        // The operator (anonymous loopback) and an external identifier are accepted.
        expect((await patch({ key: "defaults.messaging.allowSiblings", value: true })).status).toBe(200)
        expect((await patch({ key: "defaults.messaging.allowSiblings", value: false }, {}, "?callerSessionId=sess_ext")).status).toBe(200)
      } finally {
        await srv.stop()
      }

      // MCP from the operator: accepted.
      const operator = await mcpConfigClient(cfg.deps, { isHostSpawned })
      expect((await operator.callTool({ name: "config_set", arguments: { key: "defaults.messaging.allowSiblings", value: true } })).isError).toBeFalsy()
    })
  }
})
