/**
 * `agent_start({ sandbox, access: { profileRef } })` for a SUB-ACCOUNT profile
 * (org / workspace / project pin) and the AGENTS.md handed to a box.
 *
 * A fresh box has neither the host's profiles nor its sub-account provider, so
 * the host must forward the provider's scoping (the env var the bearer rides
 * in, the extra env such as a console org's inline `provider` config, the
 * login-less data home) beside the credential — otherwise the box bills with a
 * bare key and the upstream rejects it ("Workspace selection is required").
 * The box is an in-process daemon behind a fake provider; nothing leaves the
 * machine, and the credential values are fakes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import type { SandboxProvider } from "@agentproto/sandbox"
import {
  registerSubaccountProvider,
  unregisterSubaccountProvider,
  type AuthProfile,
} from "@agentproto/auth"

import { createGateway, type GatewayHandle } from "../index.js"
import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import {
  createSessionsRegistry,
  type SessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
} from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"
import type { AdapterAuthDescriptor } from "../spawn-defaults.js"

const profiles = vi.hoisted(() => ({ byId: {} as Record<string, import("@agentproto/auth").AuthProfile> }))
vi.mock("@agentproto/auth", async importOriginal => {
  const actual = await importOriginal<typeof import("@agentproto/auth")>()
  return { ...actual, getAuthProfile: vi.fn(async (id: string) => profiles.byId[id]) }
})

const DESCRIPTOR: AdapterAuthDescriptor = {
  provider: "anthropic",
  authSubscription: { setEnv: "ANTHROPIC_AUTH_TOKEN" },
  gatewayAuth: { setEnv: "ANTHROPIC_AUTH_TOKEN" },
}

const SCOPED_TOKEN = "scoped-token-fake-0001"
const ORG_CONFIG = JSON.stringify({ provider: { zen: { options: { headers: { "x-org-id": "org_1" } } } } })

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

function makeBoxResolver(
  receivedPrompts: string[],
  receivedStarts: Array<Record<string, unknown>>,
): AgentAdapterResolver {
  return async slug => {
    if (slug !== "fake-cli") return null
    return {
      commandPreview: "fake-cli (test double)",
      authDescriptor: DESCRIPTOR,
      async startSession(args): Promise<AgentSessionLike> {
        receivedStarts.push(args as Record<string, unknown>)
        return {
          sessionId: "remote_sess_1",
          async *send(message: unknown): AsyncIterable<AgentStreamEvent> {
            receivedPrompts.push(typeof message === "string" ? message : JSON.stringify(message))
            yield { kind: "text-delta", text: "ack" }
            yield { kind: "turn-end", reason: "completed" }
          },
          async cancel() {},
          async close() {},
        }
      },
    }
  }
}

describe("agent_start sandbox — sub-account scope + AGENTS.md", () => {
  let receivedPrompts: string[]
  let receivedStarts: Array<Record<string, unknown>>
  let gateway: GatewayHandle
  let boxWorkspace: string
  let hostDir: string
  let registry: SessionsRegistry
  let deps: SpawnAgentSessionDeps

  beforeEach(async () => {
    receivedPrompts = []
    receivedStarts = []
    profiles.byId = {}
    boxWorkspace = await mkdtemp(join(tmpdir(), "agentproto-sandbox-sub-box-"))
    hostDir = await mkdtemp(join(tmpdir(), "agentproto-sandbox-sub-host-"))
    gateway = await createGateway({
      workspace: boxWorkspace,
      specs: [],
      port: await freePort(),
      boot: false,
      persist: false,
      persistPath: join(boxWorkspace, "sessions.json"),
      resolveAgentAdapter: makeBoxResolver(receivedPrompts, receivedStarts),
    })
    registry = createSessionsRegistry({ persist: false, transcriptDir: join(hostDir, "transcripts") })
    const provider: SandboxProvider = {
      async boot() {
        return { mcpUrl: `${gateway.url}/mcp`, sandboxId: "sbx_sub_1", stop: async () => undefined }
      },
    }
    deps = {
      registry,
      resolveAgentAdapter: vi.fn(async (slug: string) =>
        slug === "fake-cli"
          ? {
              commandPreview: "fake-cli (host)",
              authDescriptor: DESCRIPTOR,
              async startSession(): Promise<AgentSessionLike> {
                throw new Error("a sandboxed spawn must never start the host adapter")
              },
            }
          : null,
      ),
      resolveSandboxProvider: vi.fn(async (slug: string): Promise<SandboxProviderHandle | null> => {
        if (slug !== "fake") return null
        return {
          provider,
          slug: "fake",
          name: "Fake",
          version: "test",
          description: "test double booting an in-process daemon",
          requiresSetup: false,
          capabilities: { networkEgress: false, mounts: false, lifecyclePause: false, readOnly: false },
          async check() {
            return true
          },
        }
      }),
      loadDefaultsConfig: async () => undefined,
      loadRoleRegistry: async () => ({}),
    }
  })

  afterEach(async () => {
    unregisterSubaccountProvider("fake-vendor")
    registry.shutdown()
    await gateway.stop()
    await rm(hostDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    await rm(boxWorkspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  function pinProfile(): void {
    const profile: AuthProfile = {
      id: "ws01",
      endpoint: "anthropic",
      method: "api-key",
      subaccount: { kind: "org", id: "org_1" },
    }
    profiles.byId.ws01 = profile
    registerSubaccountProvider({
      id: "fake-vendor",
      endpoints: ["anthropic"],
      kinds: ["org"],
      list: async () => ({ account: { id: "acct" }, subaccounts: [] }),
      resolve: async () => ({
        credential: SCOPED_TOKEN,
        credentialEnvOverride: "FAKE_CONSOLE_TOKEN",
        env: { FAKE_CONFIG_CONTENT: ORG_CONFIG },
      }),
    })
  }

  it("forwards the provider's extra env and token env var to the box", async () => {
    pinProfile()
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: hostDir,
      sandbox: "fake",
      access: { profileRef: "ws01" },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.descriptor.auth?.credentialSource).toBe("subaccount")
    // The BOX's driver receives the spec its own resolver built from the
    // forwarded scope — same shape the local driver gets.
    expect(receivedStarts[0]?.auth).toMatchObject({
      mode: "api-key",
      credential: SCOPED_TOKEN,
      setEnv: "FAKE_CONSOLE_TOKEN",
      extraEnv: { FAKE_CONFIG_CONTENT: ORG_CONFIG },
    })
  })

  it("a plain-key profile forwards no sub-account scope", async () => {
    profiles.byId.plain = { id: "plain", endpoint: "anthropic", method: "api-key", credentialRef: "slot" }
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: hostDir,
      sandbox: "fake",
      auth: { mode: "api-key", apiKey: "sk-plain-fake" },
    })
    expect(result.ok).toBe(true)
    const auth = receivedStarts[0]?.auth as Record<string, unknown>
    expect(auth.credential).toBe("sk-plain-fake")
    expect(auth.extraEnv).toBeUndefined()
  })

  it("never hands the box a host path to AGENTS.md (pointer mode is dropped)", async () => {
    await writeFile(join(hostDir, "AGENTS.md"), "x".repeat(64 * 1024))
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: hostDir,
      sandbox: "fake",
      prompt: "do the thing",
      wait: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.descriptor.agentsMdMode).toBe("absent")
    expect(receivedPrompts[0]).toContain("do the thing")
    expect(receivedPrompts[0]).not.toContain(hostDir)
    expect(receivedPrompts[0]).not.toContain("read it before your first tool call")
  })

  it("inlines a small AGENTS.md for the box without the host path", async () => {
    await writeFile(join(hostDir, "AGENTS.md"), "BOX_RULE_MARKER: run the gate")
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: hostDir,
      sandbox: "fake",
      prompt: "do the thing",
      wait: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.descriptor.agentsMdMode).toBe("inline")
    expect(receivedPrompts[0]).toContain("BOX_RULE_MARKER: run the gate")
    expect(receivedPrompts[0]).not.toContain(hostDir)
  })
})
