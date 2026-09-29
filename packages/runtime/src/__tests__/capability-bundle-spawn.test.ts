/**
 * Integration coverage for capability-bundle expansion in `spawnAgentSession`
 * (PLAN D phase 1) — precedence, explicit-mcpServers-wins collisions, a
 * dangling `mcpImports` id skipped with a warning, the sandbox skip (skills
 * still apply), `includeDaemon`, and the redaction guarantee that an
 * imported-MCP snapshot's secret-bearing fields (command/args/env/headers)
 * never reach the spawned session's `mcpServers`/argv.
 *
 * `loadBundlesConfig`/`loadImportedMcpsConfig` are injected (see
 * `SpawnAgentSessionDeps`) so these tests never touch the real
 * `~/.agentproto/{bundles,imported-mcps}.json` — same discipline as
 * `loadDefaultsConfig` elsewhere in session-spawn.test.ts.
 */

import { describe, it, expect, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import type { AcpMcpServer } from "@agentproto/acp"
import type { SandboxProvider } from "@agentproto/sandbox"
import { createGateway, type GatewayHandle } from "../index.js"
import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"
import { cdContractLine } from "../agents-md.js"
import type { BundlesFile } from "../bundles.js"
import type { ImportedMcpsConfig } from "../mcp-imports.js"

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

function fakeAgentSession(): AgentSessionLike {
  return {
    sessionId: "acp_test",
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

interface Captured {
  mcpServers?: AcpMcpServer[]
  options?: Record<string, unknown>
}

function makeResolver(captured: Captured[]): AgentAdapterResolver {
  return async () => ({
    startSession: (async (opts: { mcpServers?: AcpMcpServer[]; options?: Record<string, unknown> }) => {
      captured.push({ mcpServers: opts.mcpServers, options: opts.options })
      return fakeAgentSession()
    }) as any,
    commandPreview: "mock-adapter",
    // Declares a string-typed `skills` option so `normalizeSkillsOption`
    // folds the resolved skill list into `config.options.skills` — lets the
    // bundle-skills-union tests observe it the same way the real hermes/
    // opencode adapters do.
    declaredOptions: [{ id: "skills", type: "string" }],
  })
}

function baseDeps(overrides: Partial<SpawnAgentSessionDeps> = {}): {
  registry: ReturnType<typeof createSessionsRegistry>
  captured: Captured[]
  deps: SpawnAgentSessionDeps
} {
  const registry = createSessionsRegistry({ persist: false })
  const captured: Captured[] = []
  const deps: SpawnAgentSessionDeps = {
    registry,
    resolveAgentAdapter: makeResolver(captured),
    resolveAgentsMd: async () => ({ mode: "absent", contractLine: cdContractLine }),
    resolveWorkspaceRules: async () => ({}),
    daemonMcpUrl: "http://127.0.0.1:18790/mcp",
    ...overrides,
  }
  return { registry, captured, deps }
}

const SNAPSHOT_SECRET_ENV = "sk-super-secret-value"
const SNAPSHOT_SECRET_HEADER = "Bearer super-secret-bearer"

function importedMcps(entries: Array<{ id: string; alias: string }>): ImportedMcpsConfig {
  return {
    version: 1,
    imports: entries.map(e => ({
      id: e.id,
      alias: e.alias,
      addedAt: "2026-01-01T00:00:00.000Z",
      snapshot: {
        id: e.id,
        source: "claude-code",
        scope: "global",
        name: e.alias,
        type: "stdio",
        command: "npx",
        args: ["-y", "some-secret-mcp-package"],
        env: { SECRET_KEY: SNAPSHOT_SECRET_ENV },
        headers: { Authorization: SNAPSHOT_SECRET_HEADER },
      },
    })),
  }
}

function bundlesFile(bundles: BundlesFile["bundles"]): BundlesFile {
  return { version: 1, bundles }
}

describe("spawnAgentSession — capability bundles (PLAN D phase 1)", () => {
  it("expands mcpImports + includeDaemon + skills for an adapter outside the default self-mount set (opencode)", async () => {
    const { deps, captured } = baseDeps({
      loadBundlesConfig: async () =>
        bundlesFile([
          {
            id: "research",
            label: "Research",
            mcpImports: ["imp1"],
            includeDaemon: true,
            skills: ["dataviz"],
          },
        ]),
      loadImportedMcpsConfig: async () => importedMcps([{ id: "imp1", alias: "Chrome DevTools!" }]),
    })

    const result = await spawnAgentSession(deps, {
      adapter: "opencode",
      cwd: "/tmp",
      bundles: ["research"],
    })
    expect(result.ok).toBe(true)
    const ownId = result.ok ? result.descriptor.id : "(failed)"

    const daemonUrl = "http://127.0.0.1:18790/mcp"
    expect(captured[0]?.mcpServers).toEqual([
      {
        name: "chrome-devtools",
        transport: "http",
        ref: `${daemonUrl}/imported/imp1?callerSessionId=${ownId}`,
      },
      { name: "agentproto", transport: "http", ref: `${daemonUrl}?callerSessionId=${ownId}` },
    ])
    expect(captured[0]?.options).toEqual({ skills: "dataviz" })
    expect(result.ok && result.descriptor.bundles).toEqual(["research"])

    // Redaction: none of the imported snapshot's secret-bearing fields
    // (command/args/env/headers) ever reach the spawn's mcpServers, argv, or
    // the descriptor — only the reference-only proxy URL does.
    const serialized = JSON.stringify({ captured, descriptor: result.ok ? result.descriptor : null })
    expect(serialized).not.toContain(SNAPSHOT_SECRET_ENV)
    expect(serialized).not.toContain(SNAPSHOT_SECRET_HEADER)
    expect(serialized).not.toContain("some-secret-mcp-package")
    expect(serialized).not.toContain("SECRET_KEY")
  })

  it("precedence: an explicit agent_start.bundles REPLACES config defaults.bundles / defaults.adapters.<slug>.bundles", async () => {
    const files = bundlesFile([
      { id: "global-bundle", label: "Global", mcpImports: [], skills: ["from-global"] },
      { id: "adapter-bundle", label: "Adapter", mcpImports: [], skills: ["from-adapter"] },
      { id: "explicit-bundle", label: "Explicit", mcpImports: [], skills: ["from-explicit"] },
    ])
    const { deps, captured } = baseDeps({
      loadBundlesConfig: async () => files,
      loadImportedMcpsConfig: async () => ({ version: 1, imports: [] }),
      loadDefaultsConfig: async () => ({
        bundles: ["global-bundle"],
        adapters: { opencode: { bundles: ["adapter-bundle"] } },
      }),
    })

    // No explicit `bundles` — global ∪ per-adapter applies.
    const noExplicit = await spawnAgentSession(deps, { adapter: "opencode", cwd: "/tmp" })
    expect(noExplicit.ok).toBe(true)
    expect(new Set((captured[0]?.options?.skills as string).split(","))).toEqual(
      new Set(["from-global", "from-adapter"]),
    )

    // Explicit `bundles` replaces the union outright.
    const explicit = await spawnAgentSession(deps, {
      adapter: "opencode",
      cwd: "/tmp",
      bundles: ["explicit-bundle"],
    })
    expect(explicit.ok).toBe(true)
    expect(captured[1]?.options?.skills).toBe("from-explicit")
  })

  it("preset bundles apply when the call omits `bundles`, but an explicit call still wins over the preset", async () => {
    const files = bundlesFile([
      { id: "preset-bundle", label: "Preset", mcpImports: [], skills: ["from-preset"] },
      { id: "explicit-bundle", label: "Explicit", mcpImports: [], skills: ["from-explicit"] },
    ])
    const { deps, captured } = baseDeps({
      loadBundlesConfig: async () => files,
      loadImportedMcpsConfig: async () => ({ version: 1, imports: [] }),
    })

    const viaPreset = await spawnAgentSession(deps, {
      adapter: "opencode",
      cwd: "/tmp",
      preset: { id: "p", label: "P", bundles: ["preset-bundle"] },
    })
    expect(viaPreset.ok).toBe(true)
    expect(captured[0]?.options?.skills).toBe("from-preset")

    const explicitWins = await spawnAgentSession(deps, {
      adapter: "opencode",
      cwd: "/tmp",
      bundles: ["explicit-bundle"],
      preset: { id: "p", label: "P", bundles: ["preset-bundle"] },
    })
    expect(explicitWins.ok).toBe(true)
    expect(captured[1]?.options?.skills).toBe("from-explicit")
  })

  it("skips a dangling mcpImports id (import removed since the bundle was saved) with a warning, keeps spawning", async () => {
    const { deps, captured } = baseDeps({
      loadBundlesConfig: async () =>
        bundlesFile([{ id: "research", label: "Research", mcpImports: ["ghost-import"], skills: [] }]),
      loadImportedMcpsConfig: async () => ({ version: 1, imports: [] }),
    })

    const result = await spawnAgentSession(deps, { adapter: "opencode", cwd: "/tmp", bundles: ["research"] })
    expect(result.ok).toBe(true)
    expect(result.ok && result.warnings?.some(w => w.includes("ghost-import"))).toBe(true)
    expect(captured[0]?.mcpServers).toBeUndefined()
  })

  it("skips an unknown bundle id with a warning, keeps spawning", async () => {
    const { deps } = baseDeps({
      loadBundlesConfig: async () => bundlesFile([]),
      loadImportedMcpsConfig: async () => ({ version: 1, imports: [] }),
    })

    const result = await spawnAgentSession(deps, { adapter: "opencode", cwd: "/tmp", bundles: ["nope"] })
    expect(result.ok).toBe(true)
    expect(result.ok && result.warnings?.some(w => w.includes('"nope" not found'))).toBe(true)
  })

  it("an explicit caller mcpServers entry wins a name collision with a bundle's import — warning, not a crash", async () => {
    const { deps, captured } = baseDeps({
      loadBundlesConfig: async () =>
        bundlesFile([{ id: "research", label: "Research", mcpImports: ["imp1"], skills: [] }]),
      loadImportedMcpsConfig: async () => importedMcps([{ id: "imp1", alias: "chrome-devtools" }]),
    })

    const explicitEntry: AcpMcpServer = { name: "chrome-devtools", transport: "stdio", ref: "own-server" }
    const result = await spawnAgentSession(deps, {
      adapter: "opencode",
      cwd: "/tmp",
      bundles: ["research"],
      mcpServers: [explicitEntry],
    })
    expect(result.ok).toBe(true)
    expect(captured[0]?.mcpServers).toEqual([explicitEntry])
    expect(result.ok && result.warnings?.some(w => w.includes("collides"))).toBe(true)
  })

  describe("sandbox spawn", () => {
    // A sandbox spawn needs a REAL round trip to prove anything (the box's
    // own `agent_start` is a separate process/gateway) — same fixture shape
    // as agent-start-sandbox-cwd.test.ts: a fake `SandboxProvider` boots a
    // real in-process daemon standing in for the box, and `receivedStarts`
    // captures exactly what reached ITS `agent_start`.
    async function bootFakeBox(receivedStarts: Array<Record<string, unknown>>): Promise<{
      provider: SandboxProvider
      gateway: GatewayHandle
      workspace: string
    }> {
      const workspace = await mkdtemp(join(tmpdir(), "agentproto-bundle-sandbox-box-"))
      const port = await freePort()
      const gateway = await createGateway({
        workspace,
        specs: [],
        port,
        boot: false,
        persist: false,
        persistPath: join(workspace, "sessions.json"),
        resolveAgentAdapter: async slug => {
          if (slug !== "fake-cli") return null
          return {
            commandPreview: "fake-cli (test double)",
            async startSession(args): Promise<AgentSessionLike> {
              receivedStarts.push(args as Record<string, unknown>)
              return {
                sessionId: "remote_sess_1",
                async *send(): AsyncIterable<AgentStreamEvent> {
                  yield { kind: "turn-end", reason: "completed" }
                },
                async cancel() {},
                async close() {},
              }
            },
          }
        },
      })
      const provider: SandboxProvider = {
        boot: async () => ({
          mcpUrl: `${gateway.url}/mcp`,
          sandboxId: "sbx_fake_1",
          async stop() {},
        }),
      }
      return { provider, gateway, workspace }
    }

    it("skips bundle MCP mounts with a warning — the box can't reach this daemon's loopback /mcp", async () => {
      const receivedStarts: Array<Record<string, unknown>> = []
      const box = await bootFakeBox(receivedStarts)
      const hostWorkspace = await mkdtemp(join(tmpdir(), "agentproto-bundle-sandbox-host-"))
      const registry = createSessionsRegistry({ persist: false, transcriptDir: join(hostWorkspace, "transcripts") })
      try {
        const resolveSandboxProvider = vi.fn(async (slug: string): Promise<SandboxProviderHandle | null> => {
          if (slug !== "fake") return null
          return {
            provider: box.provider,
            slug: "fake",
            name: "Fake",
            version: "test",
            description: "test double booting an in-process daemon",
            requiresSetup: false,
            capabilities: { networkEgress: false, mounts: false, lifecyclePause: false, readOnly: false },
            defaultCwd: "/home/user",
            async check() {
              return true
            },
          }
        })
        const deps: SpawnAgentSessionDeps = {
          registry,
          resolveAgentAdapter: vi.fn(async () => null),
          resolveSandboxProvider,
          loadDefaultsConfig: async () => undefined,
          loadRoleRegistry: async () => ({}),
          daemonMcpUrl: "http://127.0.0.1:18790/mcp",
          loadBundlesConfig: async () =>
            bundlesFile([
              {
                id: "research",
                label: "Research",
                mcpImports: ["imp1"],
                includeDaemon: true,
                skills: ["dataviz"],
              },
            ]),
          loadImportedMcpsConfig: async () => importedMcps([{ id: "imp1", alias: "chrome-devtools" }]),
        }

        const result = await spawnAgentSession(deps, {
          adapter: "fake-cli",
          cwd: "/home/user/project",
          sandbox: "fake",
          bundles: ["research"],
        })
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.warnings?.some(w => w.includes("skipped for a sandbox spawn"))).toBe(true)
        // Neither the imported-MCP mount nor the daemon self-mount ever
        // reached the box — a sandboxed box cannot dial back to this
        // daemon's loopback `/mcp`.
        const startedMcpServers = (receivedStarts[0]?.mcpServers ?? []) as AcpMcpServer[]
        expect(startedMcpServers.some(e => e.name === "chrome-devtools" || e.name === "agentproto")).toBe(false)
      } finally {
        registry.shutdown()
        await box.gateway.stop()
        await rm(hostWorkspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
        await rm(box.workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      }
    }, 20_000)
  })
})
