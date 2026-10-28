/**
 * Per-session identity tokens, shadow mode (ts#2165 step 5).
 *
 * The daemon mints a token per spawned session, keeps only its SHA-256 hash
 * (`session-credentials.json`), hands the raw token to the adapter on the
 * daemon self-mount, and OBSERVES on the receiving side whether a caller's
 * `callerSessionId` claim is backed by a token. Nothing is refused yet.
 *
 * The contract names below (header, route, store module) are spelled out as
 * literals where possible so the test states the wire contract, not the
 * implementation's constants. The store module is imported dynamically so a
 * missing module fails each test on its own assertion line.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import {
  buildDaemonSelfMountEntry,
  spawnAgentSession,
  stampDaemonCallerSessionId,
  type SpawnAgentSessionDeps,
} from "../session-spawn.js"
import { restartAgentSession } from "../session-restart-core.js"
import { continueAgentSessionFresh } from "../session-continue-fresh.js"
import { cdContractLine } from "../agents-md.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { AcpMcpServer } from "@agentproto/acp"

const TOKEN_HEADER = "x-agentproto-session-token"
const CALLER_HEADER = "x-agentproto-caller-session-id"
const DAEMON_MCP_URL = "http://127.0.0.1:18790/mcp"

type CredentialsModule = {
  attachSessionCredentialStore(opts: { path: string }): () => void
  mintSessionToken(sessionId: string): string
  verifySessionToken(raw: string | undefined): string | undefined
  revokeSessionTokens(sessionId: string): number
  clearSessionCredentials(): void
}

async function credentials(): Promise<CredentialsModule> {
  // A variable specifier keeps the type checker out of the module's absence.
  const spec = "../session-credentials.js"
  return (await import(/* @vite-ignore */ spec)) as CredentialsModule
}

/** The store module when it exists, else undefined (red run on main): the
 *  injection, leak and observation tests then fail on their own assertion
 *  instead of on the import. */
async function maybeCredentials(): Promise<CredentialsModule | undefined> {
  try {
    return await credentials()
  } catch {
    return undefined
  }
}

let tmp: string
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "session-credentials-"))
  try {
    ;(await credentials()).clearSessionCredentials()
  } catch {
    // Module absent (red run on main): each test reports its own failure.
  }
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

let acpCounter = 0
function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: `acp_${acpCounter++}`,
    async *send(): AsyncIterable<AgentStreamEvent> {
      yield { kind: "text-delta", text: "hello from the fake adapter" } as AgentStreamEvent
      yield { kind: "turn-end", reason: "completed" } as AgentStreamEvent
    },
    async cancel() {},
    async close() {},
  }
}

/** Records every `startSession` call's `mcpServers` (the ADAPTER copy). */
function recordingResolver(): {
  resolver: AgentAdapterResolver
  calls: Array<{ mcpServers?: AcpMcpServer[] }>
} {
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

function spawnDeps(
  overrides: Partial<SpawnAgentSessionDeps> & { mode?: "off" | "shadow" } = {},
): SpawnAgentSessionDeps {
  const { mode, ...rest } = overrides
  return {
    registry: createSessionsRegistry({ persist: false }),
    resolveAgentAdapter: recordingResolver().resolver,
    resolveAgentsMd: async () => ({ mode: "absent", contractLine: cdContractLine }),
    resolveWorkspaceRules: async () => ({}),
    daemonMcpUrl: DAEMON_MCP_URL,
    loadDefaultsConfig: async () =>
      (mode ? { identity: { sessionTokens: mode } } : {}) as never,
    ...rest,
  }
}

function tokenOf(mcpServers: readonly AcpMcpServer[] | undefined): string | undefined {
  for (const entry of mcpServers ?? []) {
    const found = Object.entries(entry.headers ?? {}).find(([k]) => k.toLowerCase() === TOKEN_HEADER)
    if (found) return found[1]
  }
  return undefined
}

/** Every file under `dir`, recursively, as text. */
function readTree(dir: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...readTree(p))
    else out.push({ path: p, text: readFileSync(p, "utf8") })
  }
  return out
}

describe("C1 session credential store", () => {
  it("persists only the hash, verifies, refuses wrong/revoked tokens, survives a re-attach", async () => {
    const creds = await credentials()
    const path = join(tmp, "session-credentials.json")
    creds.attachSessionCredentialStore({ path })
    const raw = creds.mintSessionToken("sess_c1")
    expect(raw).toMatch(/^apst_[A-Za-z0-9_-]{43}$/)

    const file = readFileSync(path, "utf8")
    expect(file).not.toContain(raw)
    expect(file).not.toContain(raw.slice("apst_".length))
    expect(file).toContain("sess_c1")
    expect(statSync(path).mode & 0o777).toBe(0o600)

    expect(creds.verifySessionToken(raw)).toBe("sess_c1")
    expect(creds.verifySessionToken(`${raw}x`)).toBeUndefined()
    expect(creds.verifySessionToken("apst_not-a-real-token")).toBeUndefined()
    expect(creds.verifySessionToken("anything")).toBeUndefined()
    expect(creds.verifySessionToken("")).toBeUndefined()

    // Simulated daemon restart: drop memory, re-attach from the same file.
    creds.clearSessionCredentials()
    expect(creds.verifySessionToken(raw)).toBeUndefined()
    creds.attachSessionCredentialStore({ path })
    expect(creds.verifySessionToken(raw)).toBe("sess_c1")

    expect(creds.revokeSessionTokens("sess_c1")).toBe(1)
    expect(creds.verifySessionToken(raw)).toBeUndefined()
    creds.clearSessionCredentials()
    creds.attachSessionCredentialStore({ path })
    expect(creds.verifySessionToken(raw)).toBeUndefined()
  })
})

describe("C2 token injection on the daemon self-mount", () => {
  it("shadow: the adapter's self-mount carries the token header; off: it does not", async () => {
    ;(await maybeCredentials())?.attachSessionCredentialStore({ path: join(tmp, "creds.json") })

    const shadow = recordingResolver()
    const ok = await spawnAgentSession(
      spawnDeps({ resolveAgentAdapter: shadow.resolver, mode: "shadow" }),
      { adapter: "claude-code", cwd: tmp },
    )
    if (!ok.ok) throw new Error(`spawn failed: ${ok.message}`)
    const token = tokenOf(shadow.calls[0]?.mcpServers)
    expect(token).toBeDefined()
    const creds = await credentials()
    expect(creds.verifySessionToken(token)).toBe(ok.descriptor.id)
    const selfMount = shadow.calls[0]?.mcpServers?.find(e => e.name === "agentproto")
    expect(selfMount?.headers?.[CALLER_HEADER]).toBe(ok.descriptor.id)

    const off = recordingResolver()
    const offRes = await spawnAgentSession(
      spawnDeps({ resolveAgentAdapter: off.resolver, mode: "off" }),
      { adapter: "claude-code", cwd: tmp },
    )
    if (!offRes.ok) throw new Error(`spawn failed: ${offRes.message}`)
    expect(off.calls[0]?.mcpServers?.some(e => e.name === "agentproto")).toBe(true)
    expect(tokenOf(off.calls[0]?.mcpServers)).toBeUndefined()
  })

  it("buildDaemonSelfMountEntry and stampDaemonCallerSessionId add the header and never overwrite one", () => {
    const built = buildDaemonSelfMountEntry(DAEMON_MCP_URL, {
      delegationDenied: false,
      callerSessionId: "sess_a",
      sessionToken: "apst_built",
    } as never)
    expect(built.headers?.[TOKEN_HEADER]).toBe("apst_built")

    const stamped = stampDaemonCallerSessionId(
      [
        { name: "agentproto", transport: "http", ref: "http://localhost:18790/mcp" },
        {
          name: "pinned",
          transport: "http",
          ref: `${DAEMON_MCP_URL}?callerSessionId=sess_a`,
          headers: { [TOKEN_HEADER]: "apst_existing" },
        },
      ],
      { daemonMcpUrl: DAEMON_MCP_URL, callerSessionId: "sess_a", sessionToken: "apst_new" } as never,
    )
    expect(stamped?.[0]?.headers?.[TOKEN_HEADER]).toBe("apst_new")
    expect(stamped?.[0]?.headers?.[CALLER_HEADER]).toBe("sess_a")
    expect(stamped?.[1]?.headers?.[TOKEN_HEADER]).toBe("apst_existing")
  })
})

describe("C3 the raw token never leaks into a read surface or a persisted file", () => {
  it("descriptor, persisted sessions file and transcript events do not contain the raw token", async () => {
    const credsDir = mkdtempSync(join(tmpdir(), "session-credentials-store-"))
    try {
      ;(await maybeCredentials())?.attachSessionCredentialStore({ path: join(credsDir, "session-credentials.json") })
      const persistPath = join(tmp, "sessions.json")
      const registry = createSessionsRegistry({ persistPath, transcriptDir: join(tmp, "sessions") } as never)
      const { resolver, calls } = recordingResolver()
      const res = await spawnAgentSession(
        spawnDeps({ registry, resolveAgentAdapter: resolver, mode: "shadow" }),
        { adapter: "claude-code", cwd: tmp, prompt: "say hello" },
      )
      if (!res.ok) throw new Error(`spawn failed: ${res.message}`)
      const token = tokenOf(calls[0]?.mcpServers)
      expect(token).toBeDefined()
      const raw = token as string

      // Let the initial turn run and the transcript record it.
      await vi.waitFor(
        () => {
          const files = readTree(tmp).filter(f => f.path.endsWith("events.jsonl"))
          expect(files.some(f => f.text.includes("hello from the fake adapter"))).toBe(true)
        },
        { timeout: 5_000 },
      )
      const desc = registry.get(res.descriptor.id)
      expect(desc?.mcpServers?.some(e => e.name === "agentproto")).toBe(true)
      expect(JSON.stringify(desc)).not.toContain(raw)
      expect(JSON.stringify(registry.list())).not.toContain(raw)
      expect(JSON.stringify(res)).not.toContain(raw)
      registry.shutdown()

      const files = readTree(tmp)
      expect(files.some(f => f.path === persistPath)).toBe(true)
      expect(files.some(f => f.path.endsWith("events.jsonl"))).toBe(true)
      for (const f of files) expect({ path: f.path, leaked: f.text.includes(raw) }).toEqual({ path: f.path, leaked: false })
      // The credential store itself holds only the hash.
      expect(readFileSync(join(credsDir, "session-credentials.json"), "utf8")).not.toContain(raw)
    } finally {
      rmSync(credsDir, { recursive: true, force: true })
    }
  })
})

describe("C4 restart and continue-fresh get a fresh token; the old one dies on retire", () => {
  it("restart: the successor's token differs and the old one is revoked once the old row retires", async () => {
    const creds = await credentials()
    creds.attachSessionCredentialStore({ path: join(tmp, "creds.json") })
    const registry = createSessionsRegistry({ persist: false })
    const unsubscribe = registry.onSessionRetired(ev => creds.revokeSessionTokens(ev.sessionId))
    try {
      const first = recordingResolver()
      const spawned = await spawnAgentSession(
        spawnDeps({ registry, resolveAgentAdapter: first.resolver, mode: "shadow" }),
        { adapter: "claude-code", cwd: tmp },
      )
      if (!spawned.ok) throw new Error(`spawn failed: ${spawned.message}`)
      const oldToken = tokenOf(first.calls[0]?.mcpServers)
      expect(creds.verifySessionToken(oldToken)).toBe(spawned.descriptor.id)

      const second = recordingResolver()
      const restarted = await restartAgentSession(registry, second.resolver, registry.get(spawned.descriptor.id)!, {
        forceAgentResume: true,
        daemonMcpUrl: DAEMON_MCP_URL,
        loadDefaultsConfig: async () => ({ identity: { sessionTokens: "shadow" } }) as never,
      })
      const newToken = tokenOf(second.calls[0]?.mcpServers)
      expect(newToken).toBeDefined()
      expect(newToken).not.toBe(oldToken)
      expect(creds.verifySessionToken(newToken)).toBe(restarted.desc.id)
      expect(JSON.stringify(registry.get(restarted.desc.id))).not.toContain(newToken as string)

      registry.markRetired(spawned.descriptor.id, { continuedTo: restarted.desc.id })
      expect(creds.verifySessionToken(oldToken)).toBeUndefined()
      expect(creds.verifySessionToken(newToken)).toBe(restarted.desc.id)
    } finally {
      unsubscribe()
    }
  })

  it("continue-fresh: the successor gets its own token and the source's token is revoked", async () => {
    const creds = await credentials()
    creds.attachSessionCredentialStore({ path: join(tmp, "creds.json") })
    const registry = createSessionsRegistry({ persist: false })
    const unsubscribe = registry.onSessionRetired(ev => creds.revokeSessionTokens(ev.sessionId))
    try {
      const { resolver, calls } = recordingResolver()
      const deps = spawnDeps({ registry, resolveAgentAdapter: resolver, mode: "shadow" })
      const spawned = await spawnAgentSession(deps, { adapter: "claude-code", cwd: tmp })
      if (!spawned.ok) throw new Error(`spawn failed: ${spawned.message}`)
      const oldToken = tokenOf(calls[0]?.mcpServers)
      expect(creds.verifySessionToken(oldToken)).toBe(spawned.descriptor.id)

      const continued = await continueAgentSessionFresh(deps, registry.get(spawned.descriptor.id)!, {
        baseDir: join(tmp, "checkpoints"),
        askSource: false,
      })
      const successorId = (continued as { descriptor?: { id: string } }).descriptor?.id
      expect(successorId).toBeDefined()
      const newToken = tokenOf(calls[calls.length - 1]?.mcpServers)
      expect(newToken).toBeDefined()
      expect(newToken).not.toBe(oldToken)
      expect(creds.verifySessionToken(newToken)).toBe(successorId)
      expect(creds.verifySessionToken(oldToken)).toBeUndefined()
    } finally {
      unsubscribe()
    }
  })
})
