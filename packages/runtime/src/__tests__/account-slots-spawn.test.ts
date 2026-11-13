/**
 * `agent_start({ access: { profileRef: "slot:<name>" } })`: the slot is
 * resolved on the HOST, at the access merge point, before host auth
 * resolution. A box has neither the slot map nor the keychain, so it must
 * receive the credential of the profile the slot points at, already resolved.
 *
 * Same in-process box daemon as agent-start-sandbox-subaccount.test.ts; the
 * credential values are fakes and nothing leaves the machine.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import type { SandboxProvider } from "@agentproto/sandbox"
import { registerSubaccountProvider, unregisterSubaccountProvider, type AuthProfile } from "@agentproto/auth"

import { createGateway, type GatewayHandle } from "../index.js"
import { spawnAgentSession, type SpawnAgentSessionDeps } from "../session-spawn.js"
import { createSessionsRegistry, type SessionsRegistry, type AgentSessionLike, type AgentStreamEvent } from "../sessions.js"
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

const TOKEN_A = "token-of-account-a-0001"
const TOKEN_B = "token-of-account-b-0002"

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

function boxResolver(receivedStarts: Array<Record<string, unknown>>): AgentAdapterResolver {
  return async slug => {
    if (slug !== "fake-cli") return null
    return {
      commandPreview: "fake-cli (box)",
      authDescriptor: DESCRIPTOR,
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
  }
}

describe("agent_start with an account slot", () => {
  let receivedStarts: Array<Record<string, unknown>>
  let gateway: GatewayHandle
  let boxWorkspace: string
  let hostDir: string
  let registry: SessionsRegistry
  let deps: SpawnAgentSessionDeps
  let slots: Record<string, string>
  let boots: number

  beforeEach(async () => {
    receivedStarts = []
    boots = 0
    profiles.byId = {}
    slots = { "claude-primary": "acct-a", "claude-secondary": "acct-b", "claude-off": "acct-off" }
    boxWorkspace = await mkdtemp(join(tmpdir(), "agentproto-slot-box-"))
    hostDir = await mkdtemp(join(tmpdir(), "agentproto-slot-host-"))
    gateway = await createGateway({
      workspace: boxWorkspace,
      specs: [],
      port: await freePort(),
      boot: false,
      persist: false,
      persistPath: join(boxWorkspace, "sessions.json"),
      resolveAgentAdapter: boxResolver(receivedStarts),
    })
    registry = createSessionsRegistry({ persist: false, transcriptDir: join(hostDir, "transcripts") })
    const provider: SandboxProvider = {
      async boot() {
        boots++
        return { mcpUrl: `${gateway.url}/mcp`, sandboxId: "sbx_slot_1", stop: async () => undefined }
      },
    }
    // Each account is a sub-account profile whose provider hands out a
    // distinct fake credential, so the box's auth names the billed account.
    const pin = (id: string, token: string) => {
      const profile: AuthProfile = { id, endpoint: "anthropic", method: "api-key", subaccount: { kind: "org", id } }
      profiles.byId[id] = profile
      return token
    }
    const tokens: Record<string, string> = { "acct-a": pin("acct-a", TOKEN_A), "acct-b": pin("acct-b", TOKEN_B) }
    profiles.byId["acct-off"] = { id: "acct-off", endpoint: "anthropic", method: "api-key", disabled: true }
    registerSubaccountProvider({
      id: "fake-vendor",
      endpoints: ["anthropic"],
      kinds: ["org"],
      list: async () => ({ account: { id: "acct" }, subaccounts: [] }),
      resolve: async (profile: AuthProfile) => ({ credential: tokens[profile.id]! }),
    })
    deps = {
      registry,
      loadAccountSlots: async () => slots,
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

  it("a box receives the credential of the profile the slot points at, resolved on the host", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: hostDir,
      sandbox: "fake",
      access: { profileRef: "slot:claude-primary" },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(receivedStarts[0]?.auth).toMatchObject({ mode: "api-key", credential: TOKEN_A })
    // Billing keeps the REAL profile; the requested slot rides beside it.
    expect(result.descriptor.accessProfile?.profileRef).toBe("acct-a")
    expect(result.descriptor.accessSlot).toBe("claude-primary")
  })

  it("after a swap, the next spawn on the same slot gets the other account", async () => {
    slots = { "claude-primary": "acct-b", "claude-secondary": "acct-a" }
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: hostDir,
      sandbox: "fake",
      access: { profileRef: "slot:claude-primary" },
    })
    expect(result.ok).toBe(true)
    expect(receivedStarts[0]?.auth).toMatchObject({ credential: TOKEN_B })
  })

  it("an unknown slot refuses the spawn before any box boots", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: hostDir,
      sandbox: "fake",
      access: { profileRef: "slot:claude-tertiary" },
    })
    expect(result).toMatchObject({ ok: false, code: "account_slot_unresolved" })
    if (!result.ok) expect(result.message).toMatch(/claude-tertiary.*not defined/)
    expect(boots).toBe(0)
  })

  it("a slot on a disabled profile refuses the spawn (no silent fallback)", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: hostDir,
      sandbox: "fake",
      access: { profileRef: "slot:claude-off" },
    })
    expect(result).toMatchObject({ ok: false, code: "account_slot_unresolved", details: { slotCode: "account_slot_profile_disabled" } })
    expect(boots).toBe(0)
  })

  it("profileRefs accepts slots and records the slot of the profile actually billed", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: hostDir,
      sandbox: "fake",
      access: { profileRefs: ["slot:claude-secondary", "slot:claude-primary"] },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.descriptor.accessProfile?.profileRef).toBe("acct-b")
    expect(result.descriptor.accessSlot).toBe("claude-secondary")
    expect(receivedStarts[0]?.auth).toMatchObject({ credential: TOKEN_B })
  })

  it("delegateProfileRefs accepts slots (an unknown one refuses the spawn)", async () => {
    const refused = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: hostDir,
      sandbox: "fake",
      access: { profileRef: "slot:claude-primary", delegateProfileRefs: ["slot:nope"] },
    })
    expect(refused).toMatchObject({ ok: false, code: "account_slot_unresolved" })
  })
})
