/**
 * CREDENTIAL RELAY: a session running INSIDE a box that orchestrates children
 * on the same box bills a profile the HOST owns, without the host keychain
 * being copied into the box.
 *
 * The box daemon holds no auth profiles, so a nested
 * `agent_start { access: { profileRef } }` used to fail with
 * `no auth profile "<id>" found.` Here:
 *
 *  1. HOST boots a box orchestrator: the boot mints a grant carrying a profile
 *     allowlist and forwards `credentialRelay` into the box's `agent_start`.
 *  2. BOX: a nested spawn finds no local profile, asks the host relay (a real
 *     HTTP gateway) to resolve it, and launches the child with that spec.
 *  3. A profile outside the grant, a missing/expired grant and an insecure
 *     relay URL are all refused, and every refusal names the fix.
 *
 * The box side has NO profiles: `getAuthProfile` only sees them while a
 * request is being served by the host gateway. Credential values are fakes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import {
  registerSubaccountProvider,
  unregisterSubaccountProvider,
  type AuthProfile,
} from "@agentproto/auth"

const state = vi.hoisted(() => ({
  profiles: {} as Record<string, import("@agentproto/auth").AuthProfile>,
  hostScope: false,
  hostStarts: [] as Array<Record<string, unknown>>,
}))
vi.mock("@agentproto/auth", async importOriginal => {
  const actual = await importOriginal<typeof import("@agentproto/auth")>()
  return {
    ...actual,
    getAuthProfile: vi.fn(async (id: string) => (state.hostScope ? state.profiles[id] : undefined)),
  }
})
vi.mock("@agentproto/sandbox", async importOriginal => {
  const actual = await importOriginal<typeof import("@agentproto/sandbox")>()
  const fakeHost: Record<string, unknown> = {
    sandboxId: "sbx_cred_relay",
    start: async (args: Record<string, unknown>) => {
      state.hostStarts.push(args)
      return { id: "sess_box_sup", status: "idle", startedAt: "2026-01-01T00:00:00.000Z" }
    },
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
    stop: async () => {},
    close: async () => {},
  }
  return { ...actual, createSandboxAgentSessionHost: vi.fn(async () => fakeHost) }
})

import { createGateway, type GatewayHandle } from "../index.js"
import { bootSandboxAgentSession, spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { createSessionsRegistry, type AgentSessionLike, type AgentStreamEvent, type SessionsRegistry } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { AdapterAuthDescriptor } from "../spawn-defaults.js"
import { clearCredentialRelays, clearParentRelayGrants, revokeParentRelayGrantsForSession } from "../parent-relay.js"
import { requestRelayedCredential } from "../credential-relay.js"

const DESCRIPTOR: AdapterAuthDescriptor = {
  provider: "anthropic",
  authSubscription: { setEnv: "ANTHROPIC_AUTH_TOKEN" },
  gatewayAuth: { setEnv: "ANTHROPIC_AUTH_TOKEN" },
}
const SCOPED_TOKEN = "host-owned-token-fake-0001"

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

function adapterResolver(starts: Array<Record<string, unknown>>): AgentAdapterResolver {
  return async slug => {
    if (slug !== "fake-cli") return null
    return {
      commandPreview: "fake-cli (test double)",
      authDescriptor: DESCRIPTOR,
      async startSession(args): Promise<AgentSessionLike> {
        starts.push(args as Record<string, unknown>)
        return {
          sessionId: "child_sess_1",
          async *send(): AsyncIterable<AgentStreamEvent> {
            yield { kind: "turn-end", reason: "completed" }
          },
          async cancel() {},
          async close() {},
        }
      },
    }
  }
}

const sandboxHandle = {
  provider: {
    async connect() {
      throw new Error("not expected")
    },
    async boot() {
      throw new Error("not expected")
    },
  },
  slug: "fake",
  name: "Fake",
  version: "test",
  description: "test double",
  requiresSetup: false,
  capabilities: { networkEgress: false, mounts: false, lifecyclePause: false, readOnly: false },
  async check() {
    return true
  },
} as unknown as Awaited<ReturnType<NonNullable<Parameters<typeof bootSandboxAgentSession>[0]["resolveSandboxProvider"]>>>

describe("box credential relay: a box-side nested spawn bills a host-owned profile", () => {
  const savedEnv = process.env.AGENTPROTO_PARENT_RELAY_URL
  const realFetch = globalThis.fetch
  let hostGateway: GatewayHandle
  let hostWorkspace: string
  let boxDir: string
  let boxStarts: Array<Record<string, unknown>>
  let boxRegistry: SessionsRegistry
  let boxDeps: SpawnAgentSessionDeps
  let supervisorId: string

  function pinProfile(id: string): void {
    const profile: AuthProfile = { id, endpoint: "anthropic", method: "api-key", subaccount: { kind: "org", id: "org_1" } }
    state.profiles[id] = profile
  }

  /** Boot a host-side box orchestrator and seat the relay it forwarded into
   *  a box-side supervisor row, the same wiring the box daemon performs. */
  async function seatSupervisor(profileRefs: string[]): Promise<void> {
    state.hostStarts.length = 0
    const booted = await bootSandboxAgentSession({
      sandbox: "fake",
      adapter: "fake-cli",
      cwd: boxDir,
      explicitCwd: true,
      orchestrator: true,
      parentRelay: { boxSessionId: "sess_host_row", profileRefs },
      resolveSandboxProvider: vi.fn(async () => sandboxHandle),
    })
    expect(booted.ok).toBe(true)
    const credentialRelay = state.hostStarts[0]?.credentialRelay as { url: string; token: string } | undefined
    expect(credentialRelay).toBeDefined()
    supervisorId = boxRegistry.spawnAgent({
      workspaceSlug: "w",
      cwd: boxDir,
      agentSession: {
        sessionId: "sup_acp",
        // eslint-disable-next-line require-yield
        async *send(): AsyncIterable<AgentStreamEvent> {
          return
        },
        async cancel() {},
        async close() {},
      },
      adapterSlug: "fake-cli",
      depth: 0,
      ...(credentialRelay ? { credentialRelay } : {}),
    }).id
  }

  function nestedSpawn(profileRef: string) {
    return spawnAgentSession(boxDeps, {
      adapter: "fake-cli",
      cwd: boxDir,
      callerSessionId: supervisorId,
      access: { profileRef },
    })
  }

  beforeEach(async () => {
    state.profiles = {}
    state.hostScope = false
    boxStarts = []
    boxDir = await mkdtemp(join(tmpdir(), "agentproto-cred-relay-box-"))
    hostWorkspace = await mkdtemp(join(tmpdir(), "agentproto-cred-relay-host-"))
    hostGateway = await createGateway({
      workspace: hostWorkspace,
      specs: [],
      port: await freePort(),
      boot: false,
      persist: false,
      persistPath: join(hostWorkspace, "sessions.json"),
      resolveAgentAdapter: adapterResolver([]),
    })
    process.env.AGENTPROTO_PARENT_RELAY_URL = hostGateway.url
    clearParentRelayGrants()
    clearCredentialRelays()
    // The host serves relay requests with its own profile store; everything
    // else (the box's local lookup) sees none.
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      state.hostScope = true
      try {
        return await realFetch(input, init)
      } finally {
        state.hostScope = false
      }
    })
    registerSubaccountProvider({
      id: "fake-vendor",
      endpoints: ["anthropic"],
      kinds: ["org"],
      list: async () => ({ account: { id: "acct" }, subaccounts: [] }),
      resolve: async () => ({ credential: SCOPED_TOKEN, credentialEnvOverride: "FAKE_CONSOLE_TOKEN" }),
    })
    boxRegistry = createSessionsRegistry({ persist: false, transcriptDir: join(boxDir, "transcripts") })
    boxDeps = {
      registry: boxRegistry,
      resolveAgentAdapter: adapterResolver(boxStarts),
      resolveSandboxProvider: vi.fn(async () => null),
      loadDefaultsConfig: async () => undefined,
      loadRoleRegistry: async () => ({}),
    }
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    unregisterSubaccountProvider("fake-vendor")
    clearParentRelayGrants()
    clearCredentialRelays()
    if (savedEnv === undefined) delete process.env.AGENTPROTO_PARENT_RELAY_URL
    else process.env.AGENTPROTO_PARENT_RELAY_URL = savedEnv
    boxRegistry.shutdown()
    await hostGateway.stop()
    await rm(boxDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    await rm(hostWorkspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  it("resolves the profile on the host and launches the nested child with its credential", async () => {
    pinProfile("opencode-api-zen-ws00")
    await seatSupervisor(["opencode-api-zen-ws00"])

    const result = await nestedSpawn("opencode-api-zen-ws00")

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(boxStarts[0]?.auth).toMatchObject({ mode: "api-key", credential: SCOPED_TOKEN, setEnv: "FAKE_CONSOLE_TOKEN" })
    // The descriptor carries the non-secret echo only.
    expect(result.descriptor.accessProfile?.profileRef).toBe("opencode-api-zen-ws00")
    expect(JSON.stringify(result.descriptor)).not.toContain(SCOPED_TOKEN)
  })

  it("refuses a host profile outside the grant, and never resolves it", async () => {
    pinProfile("granted")
    pinProfile("not-granted")
    await seatSupervisor(["granted"])

    const result = await nestedSpawn("not-granted")

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("auth_profile_denied")
    expect(result.message).toContain('"not-granted"')
    expect(result.message).toContain('reuse: "<boxId>"')
    expect(JSON.stringify(result)).not.toContain(SCOPED_TOKEN)
    expect(boxStarts).toHaveLength(0)
  })

  it("refuses a candidate ladder with one profile outside the grant (no silent trimming)", async () => {
    pinProfile("granted")
    pinProfile("not-granted")
    await seatSupervisor(["granted"])

    const result = await spawnAgentSession(boxDeps, {
      adapter: "fake-cli",
      cwd: boxDir,
      callerSessionId: supervisorId,
      access: { profileRefs: ["granted", "not-granted"] },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("auth_profile_denied")
    expect(boxStarts).toHaveLength(0)
  })

  it("a box supervisor with no relay still gets the plain error plus the fix", async () => {
    pinProfile("opencode-api-zen-ws00")
    supervisorId = boxRegistry.spawnAgent({
      workspaceSlug: "w",
      cwd: boxDir,
      agentSession: {
        sessionId: "sup_acp",
        // eslint-disable-next-line require-yield
        async *send(): AsyncIterable<AgentStreamEvent> {
          return
        },
        async cancel() {},
        async close() {},
      },
      adapterSlug: "fake-cli",
      depth: 0,
    }).id

    const result = await nestedSpawn("opencode-api-zen-ws00")

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("access_profile_not_found")
    expect(result.message).toContain('no auth profile "opencode-api-zen-ws00" found')
    expect(result.message).toContain('reuse: "<boxId>"')
    expect(boxStarts).toHaveLength(0)
  })

  it("a revoked grant is refused by the host and names the fix", async () => {
    pinProfile("granted")
    await seatSupervisor(["granted"])
    revokeParentRelayGrantsForSession("sess_host_row")

    const result = await nestedSpawn("granted")

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('reuse: "<boxId>"')
    expect(boxStarts).toHaveLength(0)
  })

  it("never requests a credential over a non-https, non-loopback relay", async () => {
    const fetchSpy = vi.fn()
    const result = await requestRelayedCredential(
      { url: "http://host.example", token: "tok" },
      { adapter: "fake-cli", profileRef: "granted" },
      { fetchImpl: fetchSpy as unknown as typeof fetch },
    )
    expect(result.ok).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("box credential relay: the host boot decides what to grant", () => {
  const savedEnv = process.env.AGENTPROTO_PARENT_RELAY_URL

  beforeEach(() => {
    state.hostStarts.length = 0
    clearParentRelayGrants()
    process.env.AGENTPROTO_PARENT_RELAY_URL = "https://host.example"
  })
  afterEach(() => {
    clearParentRelayGrants()
    if (savedEnv === undefined) delete process.env.AGENTPROTO_PARENT_RELAY_URL
    else process.env.AGENTPROTO_PARENT_RELAY_URL = savedEnv
  })

  const boot = (parentRelay: Parameters<typeof bootSandboxAgentSession>[0]["parentRelay"]) =>
    bootSandboxAgentSession({
      sandbox: "fake",
      adapter: "fake-cli",
      cwd: "/tmp",
      explicitCwd: true,
      parentRelay,
      resolveSandboxProvider: vi.fn(async () => sandboxHandle),
    })

  it("a parent-less orchestrator gets a credential relay but no remote parent", async () => {
    expect((await boot({ boxSessionId: "b1", profileRefs: ["p1"] })).ok).toBe(true)
    expect(state.hostStarts[0]?.credentialRelay).toMatchObject({ url: "https://host.example" })
    expect(state.hostStarts[0]?.remoteParent).toBeUndefined()
  })

  it("nothing is forwarded when no profile is delegated and there is no parent", async () => {
    expect((await boot({ boxSessionId: "b1" })).ok).toBe(true)
    expect(state.hostStarts[0]?.credentialRelay).toBeUndefined()
    expect(state.hostStarts[0]?.remoteParent).toBeUndefined()
  })

  it("a session with a host parent keeps its remote parent on the same token", async () => {
    expect((await boot({ parentSessionId: "p", boxSessionId: "b1", profileRefs: ["p1"] })).ok).toBe(true)
    const rp = state.hostStarts[0]?.remoteParent as { token: string } | undefined
    const cr = state.hostStarts[0]?.credentialRelay as { token: string } | undefined
    expect(rp?.token).toBeDefined()
    expect(cr?.token).toBe(rp?.token)
  })
})
