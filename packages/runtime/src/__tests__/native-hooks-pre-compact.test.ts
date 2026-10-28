/**
 * `defaults.nativeHooks.preCompactCheckpoint` (off by default) hands a local
 * claude-code spawn `preCompactCommand: "<defaults.nativeHooks.command> hook
 * pre-compact"`, which the harness projects as a PreCompact hook. Off, unset,
 * another adapter or a sandbox spawn: no command. Restart follows the rule.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { restartAgentSession } from "../session-restart-core.js"
import { cdContractLine } from "../agents-md.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { WorktreeProvisionOutcome } from "../worktree-isolation.js"
import { findConfigKey, validateConfig, validateConfigKeyValue } from "../config-schema.js"
import { registerConfigTools } from "../config-tools.js"
import { loadConfig, saveConfig } from "../config.js"
import { createRuntimeEvents } from "../events.js"

type NativeHooksModule = {
  preCompactCommandFor(
    defaults: Record<string, unknown> | undefined,
    target: { adapter: string | undefined; sandbox?: unknown },
  ): string | undefined
}

/** A variable specifier keeps the type checker out of the module's absence
 *  (red run on main): each test then fails on its own assertion. */
async function nativeHooks(): Promise<NativeHooksModule | undefined> {
  const spec = "../native-hooks-defaults.js"
  try {
    return (await import(/* @vite-ignore */ spec)) as NativeHooksModule
  } catch {
    return undefined
  }
}

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "native-hooks-pre-compact-"))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: `acp_${Math.random().toString(36).slice(2)}`,
    async *send(): AsyncIterable<AgentStreamEvent> {
      yield { kind: "turn-end", reason: "completed" } as AgentStreamEvent
    },
    async cancel() {},
    async close() {},
  }
}

function recordingResolver(): { resolver: AgentAdapterResolver; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = []
  const resolver: AgentAdapterResolver = async () => ({
    async startSession(o: Record<string, unknown>) {
      calls.push(o)
      return fakeAgentSession()
    },
    commandPreview: "mock-adapter",
  })
  return { resolver, calls }
}

function spawnDeps(defaults: Record<string, unknown>, overrides: Partial<SpawnAgentSessionDeps> = {}): SpawnAgentSessionDeps {
  return {
    registry: createSessionsRegistry({ persist: false }),
    resolveAgentAdapter: recordingResolver().resolver,
    resolveAgentsMd: async () => ({ mode: "absent", contractLine: cdContractLine }),
    resolveWorkspaceRules: async () => ({}),
    loadDefaultsConfig: async () => defaults as never,
    ...overrides,
  }
}

async function spawnWith(defaults: Record<string, unknown>, adapter = "claude-code"): Promise<Record<string, unknown>> {
  const { resolver, calls } = recordingResolver()
  const res = await spawnAgentSession(spawnDeps(defaults, { resolveAgentAdapter: resolver }), { adapter, cwd: tmp })
  if (!res.ok) throw new Error(`spawn failed: ${res.message}`)
  expect(calls).toHaveLength(1)
  return calls[0]!
}

const ON = { nativeHooks: { preCompactCheckpoint: "on" } }

describe("W1 spawn wiring", () => {
  it('"on" hands startSession the default command', async () => {
    expect((await spawnWith(ON)).preCompactCommand).toBe("agentproto hook pre-compact")
  })

  it("defaults.nativeHooks.command changes the command", async () => {
    const call = await spawnWith({
      nativeHooks: { preCompactCheckpoint: "on", command: "/usr/local/bin/agentproto" },
    })
    expect(call.preCompactCommand).toBe("/usr/local/bin/agentproto hook pre-compact")
  })

  it('"off" and unset: absent', async () => {
    expect(await spawnWith({ nativeHooks: { preCompactCheckpoint: "off" } })).not.toHaveProperty("preCompactCommand")
    expect(await spawnWith({})).not.toHaveProperty("preCompactCommand")
  })

  it("another adapter: absent", async () => {
    expect(await spawnWith(ON, "codex")).not.toHaveProperty("preCompactCommand")
  })

  it("the async worktree branch reaches the same start options", async () => {
    const { resolver, calls } = recordingResolver()
    let release!: (outcome: WorktreeProvisionOutcome) => void
    const provisioned = new Promise<WorktreeProvisionOutcome>(r => (release = r))
    const registry = createSessionsRegistry({ persist: false })
    const res = await spawnAgentSession(
      spawnDeps(ON, {
        registry,
        resolveAgentAdapter: resolver,
        provisionWorktree: () => provisioned,
        resolveWorktreeIsolation: async () => "always",
      }),
      { adapter: "claude-code", cwd: tmp },
    )
    if (!res.ok) throw new Error(`spawn failed: ${res.message}`)
    expect(calls).toHaveLength(0)
    release({ isolated: true, cwd: tmp, branch: "wt/pre-compact" })
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 5_000 })
    expect(calls[0]!.preCompactCommand).toBe("agentproto hook pre-compact")
    registry.shutdown()
  })

  it("the resolver: a sandbox spawn, another adapter, off or unset get nothing", async () => {
    const mod = await nativeHooks()
    expect(mod).toBeDefined()
    const f = mod!.preCompactCommandFor
    expect(f(ON, { adapter: "claude-code" })).toBe("agentproto hook pre-compact")
    expect(f(ON, { adapter: "claude-code", sandbox: "e2b" })).toBeUndefined()
    expect(f(ON, { adapter: "claude-code", sandbox: { provider: "e2b" } })).toBeUndefined()
    expect(f(ON, { adapter: "hermes" })).toBeUndefined()
    expect(f(ON, { adapter: undefined })).toBeUndefined()
    expect(f({ nativeHooks: { preCompactCheckpoint: "off" } }, { adapter: "claude-code" })).toBeUndefined()
    expect(f(undefined, { adapter: "claude-code" })).toBeUndefined()
    expect(f({ nativeHooks: { preCompactCheckpoint: "yes" } }, { adapter: "claude-code" })).toBeUndefined()
    // A blank command falls back to the default rather than a bare " hook pre-compact".
    expect(f({ nativeHooks: { preCompactCheckpoint: "on", command: "  " } }, { adapter: "claude-code" })).toBe(
      "agentproto hook pre-compact",
    )
  })
})

describe("W1 restart wiring", () => {
  async function restartWith(defaults: Record<string, unknown>): Promise<Record<string, unknown>> {
    const registry = createSessionsRegistry({ persist: false })
    try {
      const first = recordingResolver()
      const spawned = await spawnAgentSession(spawnDeps({}, { registry, resolveAgentAdapter: first.resolver }), {
        adapter: "claude-code",
        cwd: tmp,
      })
      if (!spawned.ok) throw new Error(`spawn failed: ${spawned.message}`)
      const second = recordingResolver()
      await restartAgentSession(registry, second.resolver, registry.get(spawned.descriptor.id)!, {
        forceAgentResume: true,
        loadDefaultsConfig: async () => defaults as never,
      })
      expect(second.calls).toHaveLength(1)
      return second.calls[0]!
    } finally {
      registry.shutdown()
    }
  }

  it('"on": the restarted session gets the command', async () => {
    expect((await restartWith(ON)).preCompactCommand).toBe("agentproto hook pre-compact")
  })

  it('"off": absent', async () => {
    expect(await restartWith({ nativeHooks: { preCompactCheckpoint: "off" } })).not.toHaveProperty("preCompactCommand")
  })
})

describe("C1 config keys", () => {
  it("are registered hot and writable, off and agentproto by default", () => {
    expect(findConfigKey("defaults.nativeHooks.preCompactCheckpoint")).toMatchObject({
      apply: "hot",
      writable: true,
      default: "off",
    })
    expect(findConfigKey("defaults.nativeHooks.command")).toMatchObject({
      apply: "hot",
      writable: true,
      default: "agentproto",
    })
  })

  it("validate in a whole config, and refuse bad values", () => {
    expect(validateConfig({ defaults: { nativeHooks: { preCompactCheckpoint: "on", command: "/opt/bin/agentproto" } } }).ok).toBe(true)
    expect(validateConfig({ defaults: { nativeHooks: { preCompactCheckpoint: "yes" } } }).ok).toBe(false)
    expect(validateConfig({ defaults: { nativeHooks: { command: "" } } }).ok).toBe(false)
    expect(validateConfigKeyValue("defaults.nativeHooks.preCompactCheckpoint", "on").ok).toBe(true)
    expect(validateConfigKeyValue("defaults.nativeHooks.preCompactCheckpoint", true).ok).toBe(false)
    expect(validateConfigKeyValue("defaults.nativeHooks.command", 3).ok).toBe(false)
  })

  it("config_set refuses an invalid value and accepts a valid one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "native-hooks-config-"))
    const configPath = join(dir, "config.json")
    try {
      await saveConfig({}, configPath)
      const server = new McpServer({ name: "t", version: "0" })
      registerConfigTools(server, {
        loadCfg: () => loadConfig(configPath),
        saveCfg: next => saveConfig(next, configPath),
        configPath: () => configPath,
        bootConfig: {},
        events: createRuntimeEvents(),
      })
      const [c, s] = InMemoryTransport.createLinkedPair()
      await server.connect(s)
      const client = new Client({ name: "t-client", version: "0" })
      await client.connect(c)
      const bad = await client.callTool({
        name: "config_set",
        arguments: { key: "defaults.nativeHooks.preCompactCheckpoint", value: "always" },
      })
      expect((bad as { isError?: boolean }).isError).toBe(true)
      expect((await loadConfig(configPath)).defaults).toBeUndefined()
      const good = await client.callTool({
        name: "config_set",
        arguments: { key: "defaults.nativeHooks.preCompactCheckpoint", value: "on" },
      })
      expect((good as { isError?: boolean }).isError).toBeFalsy()
      expect(((await loadConfig(configPath)).defaults as Record<string, unknown> | undefined)?.nativeHooks).toEqual({
        preCompactCheckpoint: "on",
      })
      await client.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
