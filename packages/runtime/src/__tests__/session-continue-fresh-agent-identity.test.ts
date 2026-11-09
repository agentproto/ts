/**
 * A fresh continuation of a manifest agent keeps the agent's identity
 * (`agentId`, `agentManifestPath`, `agentRoleHash`, `agentToolsHash`) and has
 * it staged while its driver starts. Claude Code lists the /mcp gateway's
 * tools inside `startSession`, before the descriptor exists
 * (spawning-caller-context.ts), so an identity applied only after the spawn
 * hides the agent's `requires.apps` grants and AGENT.md opt-in tools from the
 * one `tools/list` the client keeps. Same hole `session_restart` had (#2674).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { continueAgentSessionFresh, resetContinueFreshMemoForTests } from "../session-continue-fresh.js"
import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import { cdContractLine } from "../agents-md.js"
import { spawningCallerContext, type SpawningCallerContext } from "../spawning-caller-context.js"

const fakeSession = (): AgentSessionLike => ({
  sessionId: "acp_continue_fresh_identity",
  // eslint-disable-next-line require-yield
  async *send(): AsyncIterable<AgentStreamEvent> {
    return
  },
  async cancel() {},
  async close() {},
})

/** The minted session id, read from the per-session config dir the spawn passes the driver. */
const mintedIdOf = (args: unknown): string => {
  const m = /sess_[0-9a-z]+/.exec(JSON.stringify(args))
  if (!m) throw new Error("no minted session id in the start args")
  return m[0]
}

let dir: string
let baseDir: string

beforeEach(() => {
  resetContinueFreshMemoForTests()
  dir = mkdtempSync(join(tmpdir(), "agp-continue-fresh-identity-"))
  baseDir = mkdtempSync(join(tmpdir(), "agp-continue-fresh-identity-ckpt-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(baseDir, { recursive: true, force: true })
})

function writeManifest(): string {
  const agentDir = join(dir, ".agents", "emploi")
  mkdirSync(agentDir, { recursive: true })
  const path = join(agentDir, "AGENT.md")
  writeFileSync(
    path,
    [
      "---",
      "schema: agent/v1",
      "id: emploi",
      "description: probe",
      "model: test-model",
      "tools:",
      "  - kind: mcp",
      "    server: agentproto",
      "    allow: [bureau_click]",
      "    deny: [cron_create]",
      "---",
      "",
      "You are a probe.",
    ].join("\n"),
    "utf8",
  )
  return path
}

describe("continueAgentSessionFresh keeps the source's agent identity", () => {
  it("records it on the fresh descriptor and stages it before the driver lists tools", async () => {
    const agentPath = writeManifest()
    const registry = createSessionsRegistry({ persist: false })
    const starts: Array<{ id: string; registered: boolean; ctx: SpawningCallerContext | undefined }> = []
    const startSession = vi.fn(async (args: unknown) => {
      const id = mintedIdOf(args)
      starts.push({ id, registered: registry.get(id) !== undefined, ctx: spawningCallerContext(id) })
      return fakeSession()
    })
    const deps: SpawnAgentSessionDeps = {
      registry,
      resolveAgentAdapter: async () => ({ startSession: startSession as never, commandPreview: "mock-adapter" }),
      resolveAgentsMd: async () => ({ mode: "absent", contractLine: cdContractLine }),
      resolveWorkspaceRules: async () => ({}),
      loadDefaultsConfig: async () => ({}),
      daemonMcpUrl: "http://127.0.0.1:18790/mcp",
    }

    const spawned = await spawnAgentSession(deps, { adapter: "mock", cwd: dir, agentPath })
    if (!spawned.ok) throw new Error(`source spawn failed: ${spawned.code} ${spawned.message}`)
    const source = registry.get(spawned.descriptor.id)!
    expect(source.meta?.agentManifestPath).toBe(agentPath)
    expect(source.meta?.agentRoleHash).toBeDefined()

    const result = await continueAgentSessionFresh(deps, source, { baseDir, askSource: false })
    const fresh = registry.get(result.descriptor.id)!

    // (a) the identity is on the fresh descriptor, verbatim.
    for (const key of ["agentId", "agentManifestPath", "agentRoleHash", "agentToolsHash"] as const) {
      expect(fresh.meta?.[key], key).toBe(source.meta?.[key])
    }
    expect(fresh.exposedToolOptIn).toEqual(["bureau_click"])

    // (b) it is staged while the fresh driver starts, before registration.
    const freshStart = starts.find(s => s.id === fresh.id)
    expect(freshStart?.registered).toBe(false)
    expect(freshStart?.ctx?.meta?.agentManifestPath).toBe(agentPath)
    expect(freshStart?.ctx?.meta?.agentId).toBe("emploi")
    expect(freshStart?.ctx?.exposedToolOptIn).toEqual(["bureau_click"])
    expect(freshStart?.ctx?.toolDenyGrants).toHaveLength(1)
    expect(spawningCallerContext(fresh.id)).toBeUndefined()
  })

  it("stages the source's frozen opt-in, not what AGENT.md says now", async () => {
    const agentPath = writeManifest()
    const registry = createSessionsRegistry({ persist: false })
    const starts: Array<{ id: string; ctx: SpawningCallerContext | undefined }> = []
    const deps: SpawnAgentSessionDeps = {
      registry,
      resolveAgentAdapter: async () => ({
        startSession: (async (args: unknown) => {
          const id = mintedIdOf(args)
          starts.push({ id, ctx: spawningCallerContext(id) })
          return fakeSession()
        }) as never,
        commandPreview: "mock-adapter",
      }),
      resolveAgentsMd: async () => ({ mode: "absent", contractLine: cdContractLine }),
      resolveWorkspaceRules: async () => ({}),
      loadDefaultsConfig: async () => ({}),
      daemonMcpUrl: "http://127.0.0.1:18790/mcp",
    }
    const spawned = await spawnAgentSession(deps, { adapter: "mock", cwd: dir, agentPath })
    if (!spawned.ok) throw new Error(`source spawn failed: ${spawned.code}`)
    // The session widens its own manifest after spawn (AIP-46 "No self-widening").
    writeFileSync(
      agentPath,
      [
        "---",
        "schema: agent/v1",
        "id: emploi",
        "description: probe",
        "model: test-model",
        "tools:",
        "  - kind: mcp",
        "    server: agentproto",
        "    allow: [bureau_click, cron_create]",
        "---",
        "",
        "You are a probe.",
      ].join("\n"),
      "utf8",
    )

    const result = await continueAgentSessionFresh(deps, registry.get(spawned.descriptor.id)!, {
      baseDir,
      askSource: false,
    })

    const freshStart = starts.find(s => s.id === result.descriptor.id)
    expect(freshStart?.ctx?.exposedToolOptIn).toEqual(["bureau_click"])
    expect(registry.get(result.descriptor.id)?.exposedToolOptIn).toEqual(["bureau_click"])
  })
})
