/**
 * AIP-36 `join.tokenEnv` — sugar over `env.passthrough` for the auto-join
 * case: forward a single host env var (a join-token URL, e.g.
 * `AGENTPROTO_JOIN`) into the box under the SAME name at boot, so the box
 * can register itself with the daemon that minted the token. Unlike an
 * explicit `env.passthrough` entry, a missing host value must be a no-op
 * (never a boot failure) — a fork's CI run typically has no such secret.
 *
 * Exercised on the real `spawnAgentSession` path with a fake sandbox
 * provider that RECORDS both the spec AND the resolved env handed to
 * `boot()` — same in-process-gateway-as-the-box shape as
 * `sandbox-auth-autopassthrough.test.ts` / `sandbox-adapter-autoinstall.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import type { SandboxProvider, SandboxSpec } from "@agentproto/sandbox"

import { createGateway, type GatewayHandle } from "../index.js"
import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { createSessionsRegistry, type SessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"
import { setMcpCredentialDeps, getMcpCredentialDeps } from "../mcp-credential-deps.js"

function portOf(address: string | AddressInfo | null): number {
  if (address === null || typeof address === "string") {
    throw new Error("test server exposed no TCP port")
  }
  return address.port
}

describe("spawnAgentSession sandbox — join.tokenEnv", () => {
  let bootSpecs: SandboxSpec[]
  let bootEnvs: Record<string, string>[]
  let registry: SessionsRegistry
  let workspace: string
  let boxWorkspace: string
  let gateway: GatewayHandle
  let deps: SpawnAgentSessionDeps
  let originalDeps: ReturnType<typeof getMcpCredentialDeps>

  beforeEach(async () => {
    bootSpecs = []
    bootEnvs = []
    workspace = await mkdtemp(join(tmpdir(), "agentproto-sbx-jointoken-host-"))
    boxWorkspace = await mkdtemp(join(tmpdir(), "agentproto-sbx-jointoken-box-"))
    originalDeps = getMcpCredentialDeps()

    // A fake CLI adapter that accepts ANY slug, so a `claude-code` spawn also
    // reaches a successful agent_start on the box.
    const resolveCliAdapter: AgentAdapterResolver = async () => ({
      commandPreview: "fake-cli (test double)",
      async startSession(): Promise<AgentSessionLike> {
        return {
          sessionId: "remote_sess_1",
          async *send(): AsyncIterable<AgentStreamEvent> {
            yield { kind: "turn-end", reason: "completed" }
          },
          async cancel() {},
          async close() {},
        }
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
      async boot(spec, opts) {
        bootSpecs.push(spec)
        bootEnvs.push(opts.env)
        return {
          mcpUrl: `${gateway.url}/mcp`,
          sandboxId: "sbx_jointoken_1",
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
          description: "records the spec + resolved env handed to boot()",
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
      resolveAgentAdapter: vi.fn(async () => null),
      resolveSandboxProvider,
      loadDefaultsConfig: async () => undefined,
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

  it("forwards the named host env var into the box's resolved env under the same name", async () => {
    setMcpCredentialDeps({
      resolveSandboxSecret: async slug =>
        slug === "AGENTPROTO_JOIN" ? "https://home.example/join?token=abc" : null,
    })
    const result = await spawnAgentSession(deps, {
      adapter: "claude-code",
      cwd: workspace,
      sandbox: { provider: "fake", config: {}, join: { tokenEnv: "AGENTPROTO_JOIN" } },
    })
    expect(result.ok).toBe(true)
    expect(bootEnvs).toHaveLength(1)
    expect(bootEnvs[0]?.AGENTPROTO_JOIN).toBe("https://home.example/join?token=abc")
  })

  it("no-ops (boot still succeeds, var absent from env) when the named host env var isn't set", async () => {
    setMcpCredentialDeps({
      resolveSandboxSecret: async () => null,
    })
    const result = await spawnAgentSession(deps, {
      adapter: "claude-code",
      cwd: workspace,
      sandbox: { provider: "fake", config: {}, join: { tokenEnv: "AGENTPROTO_JOIN" } },
    })
    expect(result.ok).toBe(true)
    expect(bootEnvs).toHaveLength(1)
    expect(bootEnvs[0]?.AGENTPROTO_JOIN).toBeUndefined()
    expect("AGENTPROTO_JOIN" in (bootEnvs[0] ?? {})).toBe(false)
  })

  it("without `join`, nothing changes (regression safety net)", async () => {
    setMcpCredentialDeps({
      resolveSandboxSecret: async slug =>
        slug === "AGENTPROTO_JOIN" ? "https://home.example/join?token=abc" : null,
    })
    const result = await spawnAgentSession(deps, {
      adapter: "claude-code",
      cwd: workspace,
      sandbox: { provider: "fake", config: {} },
    })
    expect(result.ok).toBe(true)
    expect(bootEnvs).toHaveLength(1)
    expect(bootEnvs[0]).toEqual({})
    expect(bootSpecs[0]?.join).toBeUndefined()
  })
})
