/**
 * BOX-LOGIN BRIDGE — boot path (`bootSandboxAgentSession`): the redacted copy
 * of a FILE-BASEED (external) subscription login is uploaded into the box
 * BEFORE the box's own `agent_start` verifies one, and ONLY a copy that
 * actually landed gets the forwarded `auth` block stamped `loginFile: true`.
 * Every guard that cannot hold (no `writeFile`, no `defaultCwd`, an unreadable
 * host login) degrades to today's behaviour: no copy, no stamp, the box
 * verifies its own login and fails loud exactly as it does now.
 *
 * Harness mirrors `agent-start-sandbox.test.ts`: a fake `SandboxProvider`
 * boots a REAL in-process daemon (`createGateway`) whose own fake adapter
 * records the auth block it receives, so what is asserted is the auth block
 * that actually crossed the wire — not an intermediate local object.
 * `@agentproto/secrets/provision/recipe` is MOCKED the same way
 * `claude-code-oauth-source.test.ts` mocks it, so no real login file or
 * Keychain is ever read.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import type { SandboxProvider } from "@agentproto/sandbox"

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

const getRecipe = vi.fn()
const resolveRecipeMethod = vi.fn()
const resolveSourceSpec = vi.fn()
const readRecipeLoginJson = vi.fn()
vi.mock("@agentproto/secrets/provision/recipe", () => ({
  getRecipe: (...args: unknown[]) => getRecipe(...args),
  resolveRecipeMethod: (...args: unknown[]) => resolveRecipeMethod(...args),
  resolveSourceSpec: (...args: unknown[]) => resolveSourceSpec(...args),
  readRecipeLoginJson: (...args: unknown[]) => readRecipeLoginJson(...args),
}))

/** The adapter under test — a file-based (external) subscription surface that
 *  declares HOW the host re-creates its login inside a box. Codex's shape. */
const BOX_LOGIN_AUTH: AdapterAuthDescriptor = {
  provider: "openai",
  authSubscription: {
    external: true,
    boxLogin: {
      recipe: "codex",
      file: ".codex/auth.json",
      keep: ["tokens.access_token", "tokens.id_token", "tokens.account_id", "last_refresh"],
    },
  },
  gatewayAuth: { setEnv: "OPENAI_API_KEY" },
}

/** The host's FULL login file — everything the keep-list must NOT let out. */
const HOST_LOGIN_JSON = JSON.stringify(
  {
    OPENAI_API_KEY: "sk-host-should-never-cross",
    expires_at: "2099-01-01T00:00:00.000Z",
    tokens: {
      access_token: "host-access-token",
      id_token: "host-id-token",
      refresh_token: "host-refresh-secret",
      account_id: "acct_123",
    },
    last_refresh: "2026-10-14T00:00:00.000Z",
  },
  null,
  2,
)

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

/** The BOX's own `agent_start` adapter — records the auth block it receives
 *  (the wire truth of what the host forwarded) and a lifecycle marker so the
 *  upload-before-start ordering is observable. */
function makeBoxCliResolver(
  receivedStarts: Array<Record<string, unknown>>,
  events: string[],
): AgentAdapterResolver {
  return async slug => {
    if (slug !== "fake-cli") return null
    return {
      commandPreview: "fake-cli (test double)",
      authDescriptor: BOX_LOGIN_AUTH,
      async startSession(args): Promise<AgentSessionLike> {
        receivedStarts.push(args as Record<string, unknown>)
        events.push("start")
        return {
          sessionId: "remote_sess_1",
          async *send(): AsyncIterable<AgentStreamEvent> {
            yield { kind: "text-delta", text: "ok" }
            yield { kind: "turn-end", reason: "completed" }
          },
          async cancel() {},
          async close() {},
        }
      },
    }
  }
}

/** The HOST's view of the same adapter — resolved long enough to select the
 *  billing rail (a sandboxed spawn must never START it locally). */
const hostResolver: AgentAdapterResolver = async slug => {
  if (slug !== "fake-cli") return null
  return {
    commandPreview: "fake-cli (host)",
    authDescriptor: BOX_LOGIN_AUTH,
    async startSession(): Promise<AgentSessionLike> {
      throw new Error("a sandboxed spawn must never start the host adapter")
    },
  }
}

async function bootFakeBox(
  receivedStarts: Array<Record<string, unknown>>,
  events: string[],
): Promise<{
  provider: SandboxProvider
  /** The fake's own boot, callable with no arguments — `SandboxProvider.boot`
   *  declares `(spec, opts)` the in-process fake ignores. */
  boot(): Promise<{ mcpUrl: string; sandboxId: string; stop(): Promise<void> }>
  gateway: GatewayHandle
  workspace: string
}> {
  const workspace = await mkdtemp(join(tmpdir(), "agentproto-sandbox-test-"))
  const port = await freePort()
  const gateway = await createGateway({
    workspace,
    specs: [],
    port,
    boot: false,
    persist: false,
    persistPath: join(workspace, "sessions.json"),
    resolveAgentAdapter: makeBoxCliResolver(receivedStarts, events),
  })
  const boot = async () => ({
    mcpUrl: `${gateway.url}/mcp`,
    sandboxId: "sbx_fake_1",
    stop: async () => {
      await gateway.stop()
    },
  })
  const provider: SandboxProvider = {
    async boot() {
      return boot()
    },
  }
  return { provider, boot, gateway, workspace }
}

describe("box login bridge — boot upload before host.start", () => {
  let receivedStarts: Array<Record<string, unknown>>
  let events: string[]
  let box: Awaited<ReturnType<typeof bootFakeBox>>
  let registry: SessionsRegistry
  let workspace: string
  /** The box's login HOME — `defaultCwd` of the provider handle, the base the
   *  home-relative copy path joins onto. */
  let boxHome: string
  let resolveSandboxProviderSpy: (slug: string) => Promise<SandboxProviderHandle | null>
  let deps: SpawnAgentSessionDeps
  /** Provider handle WITHOUT upload capability — the degrade baseline. */
  function plainHandle(overrides: Partial<SandboxProviderHandle> = {}): SandboxProviderHandle {
    return {
      provider: box.provider,
      slug: "fake",
      name: "Fake",
      version: "test",
      description: "test double booting an in-process daemon",
      requiresSetup: false,
      capabilities: { networkEgress: false, mounts: false, lifecyclePause: false, readOnly: false },
      async check() {
        return true
      },
      ...overrides,
    }
  }

  beforeEach(async () => {
    receivedStarts = []
    events = []
    box = await bootFakeBox(receivedStarts, events)
    workspace = await mkdtemp(join(tmpdir(), "agentproto-sandbox-host-"))
    boxHome = await mkdtemp(join(tmpdir(), "agentproto-box-home-"))
    registry = createSessionsRegistry({
      persist: false,
      transcriptDir: join(workspace, "transcripts"),
    })

    resolveSandboxProviderSpy = vi.fn(async (slug: string): Promise<SandboxProviderHandle | null> => {
      if (slug !== "fake") return null
      return plainHandle()
    })

    deps = {
      registry,
      resolveAgentAdapter: hostResolver,
      resolveSandboxProvider: resolveSandboxProviderSpy,
      loadDefaultsConfig: async () => ({
        // The config-default wallet is what forces the HOST to resolve its own
        // adapter descriptor for a sandboxed spawn (`resolveHostAuth`) — the
        // only way the `boxLogin` declaration can be known before the box runs.
        adapters: { "fake-cli": { auth: { mode: "subscription" as const } } },
      }),
      loadRoleRegistry: async () => ({}),
    }

    getRecipe.mockReset()
    getRecipe.mockReturnValue({ id: "codex" })
    resolveRecipeMethod.mockReset()
    resolveRecipeMethod.mockReturnValue({
      recipe: { id: "codex" },
      method: { source: { file: "~/.codex/auth.json", jsonPath: "tokens.access_token" } },
    })
    resolveSourceSpec.mockReset()
    resolveSourceSpec.mockResolvedValue("  host-access-token\n")
    readRecipeLoginJson.mockReset()
    readRecipeLoginJson.mockResolvedValue(HOST_LOGIN_JSON)
  })

  afterEach(async () => {
    registry.shutdown()
    await box.gateway.stop()
    await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    await rm(box.workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    await rm(boxHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  it("writes the redacted copy BEFORE host.start and stamps loginFile on the forwarded auth", async () => {
    const writes: Array<{ path: string; body: string }> = []
    const writeFile = vi.fn(async (path: string, data: Uint8Array) => {
      writes.push({ path, body: new TextDecoder().decode(data) })
      events.push("write")
    })
    deps.resolveSandboxProvider = vi.fn(async (slug: string): Promise<SandboxProviderHandle | null> => {
      if (slug !== "fake") return null
      const booted = await box.boot()
      return plainHandle({
        defaultCwd: boxHome,
        provider: {
          async boot() {
            return { ...booted, writeFile }
          },
        },
      })
    })

    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: workspace,
      sandbox: "fake",
    })

    expect(result.ok).toBe(true)

    // One upload, at the recipe's home-relative path inside the box home.
    expect(writeFile).toHaveBeenCalledTimes(1)
    expect(writes[0]!.path).toBe(join(boxHome, ".codex/auth.json"))

    // Keep-list only: the host's API key and refresh material never cross.
    const copy = JSON.parse(writes[0]!.body) as Record<string, any>
    expect(copy.tokens).toEqual({
      access_token: "host-access-token",
      id_token: "host-id-token",
      account_id: "acct_123",
    })
    expect(copy.last_refresh).toBe("2026-10-14T00:00:00.000Z")
    expect(copy.OPENAI_API_KEY).toBeUndefined()
    expect(writes[0]!.body).not.toContain("host-refresh-secret")
    expect(writes[0]!.body).not.toContain("sk-host-should-never-cross")

    // The copy landed BEFORE the box's own agent_start ran, and the auth block
    // the box received carries the marker with NO token value.
    expect(events).toEqual(["write", "start"])
    const boxAuth = receivedStarts[0]!.auth as Record<string, unknown>
    expect(boxAuth.loginFile).toBe(true)
    expect(boxAuth.mode).toBe("subscription")
    expect(boxAuth.credential).toBeUndefined()
    expect(boxAuth.token).toBeUndefined()
    expect(JSON.stringify(boxAuth)).not.toContain("host-access-token")
  })

  it("degrades to today's behavior when the provider cannot take a file upload (no writeFile)", async () => {
    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: workspace,
      sandbox: "fake",
    })

    expect(result.ok).toBe(true)
    // No upload capability ⇒ no copy, no stamp — the box verifies its OWN
    // login exactly as it does today (the source resolved on the box too).
    expect(receivedStarts[0]!.auth).not.toHaveProperty("loginFile")
    expect(resolveSourceSpec).toHaveBeenCalled()
    expect(readRecipeLoginJson).not.toHaveBeenCalled()
  })

  it("degrades to today's behavior when the provider declares no defaultCwd", async () => {
    const writeFile = vi.fn(async () => {})
    deps.resolveSandboxProvider = vi.fn(async (slug: string): Promise<SandboxProviderHandle | null> => {
      if (slug !== "fake") return null
      const booted = await box.boot()
      return plainHandle({
        // Capability present, but no box home to join a home-relative path onto.
        provider: {
          async boot() {
            return { ...booted, writeFile }
          },
        },
      })
    })

    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: workspace,
      sandbox: "fake",
    })

    expect(result.ok).toBe(true)
    expect(writeFile).not.toHaveBeenCalled()
    expect(receivedStarts[0]!.auth).not.toHaveProperty("loginFile")
    expect(readRecipeLoginJson).not.toHaveBeenCalled()
  })

  it("fails LOUD (never spawns unauthenticated) when the host cannot verify the login", async () => {
    resolveSourceSpec.mockRejectedValue(new Error("no credential source resolved"))

    const result = await spawnAgentSession(deps, {
      adapter: "fake-cli",
      cwd: workspace,
      sandbox: "fake",
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("auth_source_unresolved")
    expect(result.message).toContain("login")
    // Refused before any box was booted — nothing to tear down.
    expect(resolveSandboxProviderSpy).not.toHaveBeenCalled()
    expect(registry.list()).toHaveLength(0)
    expect(receivedStarts).toHaveLength(0)
  })
})
