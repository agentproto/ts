/**
 * PLAN-C — `env.autoPassthrough` (opt-in) on sandbox specs. A fresh box has
 * no `~/.agentproto/config.json`, so its adapter auth must come from the box
 * env; today the caller has to NAME the vars (`env.passthrough: [...]`) or
 * the spawn dies with an opaque auth error. When the flag is set AND the
 * host-side billing-credential resolution produced a credential, the runtime
 * injects that credential's env-var NAME into `spec.env.passthrough` before
 * the box boots — the value itself travels via the existing passthrough
 * mechanism (host secrets broker → box env) and NEVER appears in the spec.
 *
 * Exercised on the real `spawnAgentSession` path with a fake sandbox
 * provider that RECORDS the spec handed to `boot()` (same shape as
 * `sandbox-adapter-autoinstall.test.ts` / `agent-start-sandbox.test.ts`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import type { SandboxProvider, SandboxSpec } from "@agentproto/sandbox"
import { SandboxSpecSchema } from "@agentproto/sandbox"

import { createGateway, type GatewayHandle } from "../index.js"
import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { createSessionsRegistry, type SessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"
import { setMcpCredentialDeps, getMcpCredentialDeps } from "../mcp-credential-deps.js"
import type { AdapterAuthDescriptor, SpawnDefaultsConfig } from "../spawn-defaults.js"

const CONFIG_CREDENTIAL = "sk-ant-config-0001"
const BROKER_CREDENTIAL = "sk-ant-broker-0001"

function portOf(address: string | AddressInfo | null): number {
  if (address === null || typeof address === "string") {
    throw new Error("test server exposed no TCP port")
  }
  return address.port
}

describe("SandboxSpecSchema — env.autoPassthrough", () => {
  it("accepts the opt-in flag and defaults it strictly absent", () => {
    const withFlag = SandboxSpecSchema.safeParse({
      provider: "fake",
      config: {},
      env: { autoPassthrough: true },
    })
    expect(withFlag.success).toBe(true)
    if (withFlag.success) expect(withFlag.data.env?.autoPassthrough).toBe(true)
    const bare = SandboxSpecSchema.safeParse({ provider: "fake", config: {} })
    expect(bare.success).toBe(true)
    if (bare.success) expect(bare.data.env?.autoPassthrough).toBeUndefined()
  })
})

describe("spawnAgentSession sandbox — env.autoPassthrough", () => {
  let bootSpecs: SandboxSpec[]
  let registry: SessionsRegistry
  let workspace: string
  let boxWorkspace: string
  let gateway: GatewayHandle
  let deps: SpawnAgentSessionDeps
  let originalDeps: ReturnType<typeof getMcpCredentialDeps>
  let brokerEnv: Record<string, string>
  let defaultsConfig: SpawnDefaultsConfig | undefined

  beforeEach(async () => {
    bootSpecs = []
    workspace = await mkdtemp(join(tmpdir(), "agentproto-sbx-autopass-host-"))
    boxWorkspace = await mkdtemp(join(tmpdir(), "agentproto-sbx-autopass-box-"))
    originalDeps = getMcpCredentialDeps()
    brokerEnv = { ANTHROPIC_API_KEY: BROKER_CREDENTIAL }
    defaultsConfig = undefined

    // A fake CLI adapter that accepts ANY slug, so a `claude-code` spawn also
    // reaches a successful agent_start on the box.
    const fakeSession = async (): Promise<AgentSessionLike> => ({
      sessionId: "remote_sess_1",
      async *send(): AsyncIterable<AgentStreamEvent> {
        yield { kind: "turn-end", reason: "completed" }
      },
      async cancel() {},
      async close() {},
    })
    const resolveCliAdapter: AgentAdapterResolver = async () => ({
      commandPreview: "fake-cli (test double)",
      async startSession(): Promise<AgentSessionLike> {
        return fakeSession()
      },
    })
    // Host auth resolution (the config-default wallet path) needs a descriptor.
    const resolveHostAdapter: AgentAdapterResolver = async () => ({
      commandPreview: "fake-cli (test double)",
      authDescriptor: {
        provider: "anthropic",
        authEnforce: "when-configured",
      } satisfies AdapterAuthDescriptor,
      async startSession(): Promise<AgentSessionLike> {
        return fakeSession()
      },
    })

    gateway = await createGateway({
      workspace: boxWorkspace,
      specs: [],
      port: await new Promise<number>((resolve, reject) => {
        const srv = createServer()
        srv.once("error", reject)
        srv.listen(0, "127.0.0.1", () => {
          const port = portOf(srv.address())
          srv.close(() => resolve(port))
        })
      }),
      boot: false,
      persist: false,
      persistPath: join(boxWorkspace, "sessions.json"),
      resolveAgentAdapter: resolveCliAdapter,
    })

    const provider: SandboxProvider = {
      async boot(spec) {
        bootSpecs.push(spec)
        return {
          mcpUrl: `${gateway.url}/mcp`,
          sandboxId: "sbx_autopass_1",
          stop: async () => undefined,
        }
      },
    }

    registry = createSessionsRegistry({
      persist: false,
      transcriptDir: join(workspace, "transcripts"),
    })

    const resolveSandboxProvider = vi.fn(
      async (slug: string): Promise<SandboxProviderHandle | null> => {
        if (slug !== "fake") return null
        return {
          provider,
          slug: "fake",
          name: "Fake",
          version: "test",
          description: "records the spec handed to boot()",
          requiresSetup: false,
          capabilities: {
            networkEgress: false,
            mounts: false,
            lifecyclePause: false,
            readOnly: false,
          },
          async check() {
            return true
          },
        }
      },
    )

    deps = {
      registry,
      resolveAgentAdapter: resolveHostAdapter,
      resolveSandboxProvider,
      loadDefaultsConfig: async () => defaultsConfig,
      loadRoleRegistry: async () => ({}),
    }
  })

  afterEach(async () => {
    setMcpCredentialDeps(originalDeps)
    registry.shutdown()
    await gateway.stop()
    await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    await rm(boxWorkspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  it("injects the resolved credential's env-var NAME into env.passthrough when the flag is set", async () => {
    defaultsConfig = {
      adapters: { "claude-code": { auth: { mode: "api-key", apiKey: CONFIG_CREDENTIAL } } },
    }
    setMcpCredentialDeps({
      resolveSandboxSecret: async slug => brokerEnv[slug] ?? null,
    })
    const result = await spawnAgentSession(deps, {
      adapter: "claude-code",
      cwd: workspace,
      sandbox: { provider: "fake", config: {}, env: { autoPassthrough: true } },
    })
    expect(result.ok).toBe(true)
    expect(bootSpecs).toHaveLength(1)
    expect(bootSpecs[0]?.env?.passthrough).toContain("ANTHROPIC_API_KEY")
  })

  it("never places a credential VALUE in the boot spec", async () => {
    defaultsConfig = {
      adapters: { "claude-code": { auth: { mode: "api-key", apiKey: CONFIG_CREDENTIAL } } },
    }
    setMcpCredentialDeps({
      resolveSandboxSecret: async slug => brokerEnv[slug] ?? null,
    })
    const result = await spawnAgentSession(deps, {
      adapter: "claude-code",
      cwd: workspace,
      sandbox: { provider: "fake", config: {}, env: { autoPassthrough: true } },
    })
    expect(result.ok).toBe(true)
    const serialized = JSON.stringify(bootSpecs)
    expect(serialized).not.toContain(CONFIG_CREDENTIAL)
    expect(serialized).not.toContain(BROKER_CREDENTIAL)
  })

  it("unions with (and dedupes against) the caller's explicit passthrough", async () => {
    defaultsConfig = {
      adapters: { "claude-code": { auth: { mode: "api-key", apiKey: CONFIG_CREDENTIAL } } },
    }
    setMcpCredentialDeps({
      resolveSandboxSecret: async slug =>
        slug === "GITHUB_TOKEN" ? "gh-test-0001" : (brokerEnv[slug] ?? null),
    })
    const result = await spawnAgentSession(deps, {
      adapter: "claude-code",
      cwd: workspace,
      sandbox: {
        provider: "fake",
        config: {},
        env: { autoPassthrough: true, passthrough: ["GITHUB_TOKEN", "ANTHROPIC_API_KEY"] },
      },
    })
    expect(result.ok).toBe(true)
    expect(bootSpecs[0]?.env?.passthrough?.filter(n => n === "ANTHROPIC_API_KEY")).toHaveLength(1)
    expect(bootSpecs[0]?.env?.passthrough).toContain("GITHUB_TOKEN")
    expect(bootSpecs[0]?.env?.passthrough).toContain("ANTHROPIC_API_KEY")
  })

  it("injects nothing (and still boots) when no credential resolved", async () => {
    defaultsConfig = undefined
    setMcpCredentialDeps({
      resolveSandboxSecret: async slug => brokerEnv[slug] ?? null,
    })
    const result = await spawnAgentSession(deps, {
      adapter: "claude-code",
      cwd: workspace,
      sandbox: { provider: "fake", config: {}, env: { autoPassthrough: true } },
    })
    expect(result.ok).toBe(true)
    expect(bootSpecs[0]?.env?.passthrough ?? []).not.toContain("ANTHROPIC_API_KEY")
  })

  it("degrades to a warning (no boot failure) when the host cannot resolve the var", async () => {
    defaultsConfig = {
      adapters: { "claude-code": { auth: { mode: "api-key", apiKey: CONFIG_CREDENTIAL } } },
    }
    setMcpCredentialDeps({
      resolveSandboxSecret: async () => null,
    })
    const result = await spawnAgentSession(deps, {
      adapter: "claude-code",
      cwd: workspace,
      sandbox: { provider: "fake", config: {}, env: { autoPassthrough: true } },
    })
    expect(result.ok).toBe(true)
    expect(bootSpecs[0]?.env?.passthrough ?? []).not.toContain("ANTHROPIC_API_KEY")
  })

  it("without the flag, a resolved credential changes nothing (zero diff)", async () => {
    defaultsConfig = {
      adapters: { "claude-code": { auth: { mode: "api-key", apiKey: CONFIG_CREDENTIAL } } },
    }
    setMcpCredentialDeps({
      resolveSandboxSecret: async slug => brokerEnv[slug] ?? null,
    })
    const result = await spawnAgentSession(deps, {
      adapter: "claude-code",
      cwd: workspace,
      sandbox: { provider: "fake", config: {} },
    })
    expect(result.ok).toBe(true)
    expect(bootSpecs[0]?.env?.passthrough ?? []).not.toContain("ANTHROPIC_API_KEY")
  })
})
