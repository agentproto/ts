/**
 * BOX-LOGIN BRIDGE — restart path (`restartAgentSession`'s box re-attach):
 * reconnecting to an EXISTING box re-uploads the redacted copy of the
 * session's file-based (external) subscription login (the box may predate the
 * bridge, or its copy may be stale), and stamps `loginFile: true` on the
 * forwarded auth block ONLY when that copy actually landed. Degrades exactly
 * like the boot path: no copy → no stamp → the box verifies its own login.
 *
 * Harness mirrors `session-restart-sandbox.test.ts` — a fake
 * `SandboxProvider.connect` wraps a REAL in-process daemon whose fake adapter
 * records the auth block it receives — with `@agentproto/secrets/provision/
 * recipe` MOCKED (as in `claude-code-oauth-source.test.ts`).
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"
import type { SandboxProvider, SandboxSpec } from "@agentproto/sandbox"

import { createGateway, type GatewayHandle } from "../index.js"
import {
  createSessionsRegistry,
  type SessionsRegistry,
  type AgentSessionLike,
  type AgentStreamEvent,
} from "../sessions.js"
import { restartAgentSession } from "../session-restart-core.js"
import type { AgentAdapterResolver } from "../http-server.js"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"
import type { AdapterAuthDescriptor } from "../spawn-defaults.js"

const wsConfigState = vi.hoisted(() => ({
  value: { version: 1, workspaces: [] } as import("../workspaces-config.js").WorkspacesConfig,
}))
vi.mock("../workspaces-config.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../workspaces-config.js")>()
  return { ...actual, loadWorkspacesConfig: vi.fn(async () => wsConfigState.value) }
})

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

/** Codex-shaped file-based subscription surface with a `boxLogin` declaration. */
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

const HOST_LOGIN_JSON = JSON.stringify({
  OPENAI_API_KEY: "sk-host-should-never-cross",
  tokens: {
    access_token: "host-access-token",
    refresh_token: "host-refresh-secret",
    account_id: "acct_123",
  },
  last_refresh: "2026-10-14T00:00:00.000Z",
})

function fakeAgentSession(prefix: string, counter: { n: number }): AgentSessionLike {
  return {
    sessionId: `${prefix}_${counter.n++}`,
    // eslint-disable-next-line require-yield
    async *send(): AsyncIterable<AgentStreamEvent> {
      return
    },
    async cancel() {},
    async close() {},
  }
}

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

/** The HOST's adapter — resolved long enough to re-select the billing rail;
 *  a sandboxed restart must never spawn it locally. */
const hostResolver: AgentAdapterResolver = async slug => {
  if (slug !== "fake-cli") return null
  return {
    commandPreview: "fake-cli (host test double)",
    authDescriptor: BOX_LOGIN_AUTH,
    async startSession(): Promise<AgentSessionLike> {
      throw new Error("LOCAL SPAWN MUST NOT HAPPEN for a sandbox session restart")
    },
  }
}

describe("box login bridge — restart re-attach upload", () => {
  let receivedStarts: Array<Record<string, unknown>>
  let events: string[]
  let writes: Array<{ path: string; body: string }>
  let box: { provider: SandboxProvider; gateway: GatewayHandle; workspace: string }
  let registry: SessionsRegistry
  let hostWorkspace: string
  let boxHome: string
  let counter: { n: number }
  let writeFile: ReturnType<typeof vi.fn>
  let prev: ReturnType<SessionsRegistry["spawnAgent"]>

  afterEach(async () => {
    registry.shutdown()
    await box.gateway.stop()
    await rm(hostWorkspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    await rm(box.workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    await rm(boxHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  async function setup(opts: { withUpload?: boolean } = {}) {
    receivedStarts = []
    events = []
    writes = []
    counter = { n: 0 }
    const withUpload = opts.withUpload ?? true

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

    const workspace = await mkdtemp(join(tmpdir(), "agentproto-sbx-restart-box-"))
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
          commandPreview: "fake-cli (box test double)",
          authDescriptor: BOX_LOGIN_AUTH,
          async startSession(args): Promise<AgentSessionLike> {
            receivedStarts.push(args as Record<string, unknown>)
            events.push("start")
            return fakeAgentSession("box", counter)
          },
        }
      },
    })
    writeFile = vi.fn(async (path: string, data: Uint8Array) => {
      writes.push({ path, body: new TextDecoder().decode(data) })
      events.push("write")
    })
    const connectCalls: string[] = []
    const provider: SandboxProvider = {
      async boot(): Promise<never> {
        throw new Error("boot must never be called — a restart reconnects via connect()")
      },
      async connect(sandboxId: string, _spec: SandboxSpec) {
        connectCalls.push(sandboxId)
        return {
          mcpUrl: `${gateway.url}/mcp`,
          sandboxId,
          ...(withUpload ? { writeFile } : {}),
          async stop() {
            await gateway.stop()
          },
        }
      },
    }
    box = { provider, gateway, workspace }
    hostWorkspace = await mkdtemp(join(tmpdir(), "agentproto-sbx-restart-host-"))
    boxHome = await mkdtemp(join(tmpdir(), "agentproto-box-home-"))
    registry = createSessionsRegistry({
      persist: false,
      transcriptDir: join(hostWorkspace, "transcripts"),
    })
    prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/home/user",
      agentSession: fakeAgentSession("prev", counter),
      adapterSlug: "fake-cli",
      commandPreview: "sandbox:fake → fake-cli",
      remote: true,
      sandboxId: "sbx_prev_1",
      sandboxTeardown: "pause",
      // The prior session billed through its file-based subscription login —
      // the mode echo the restart re-resolves from.
      auth: { mode: "subscription", fingerprint: "none" },
    })
    registry.kill(prev.id)

    const providerResolver = async (slug: string): Promise<SandboxProviderHandle | null> => {
      if (slug !== "fake") return null
      return {
        provider,
        slug: "fake",
        name: "Fake",
        version: "test",
        description: "test double exposing a connect() to an in-process daemon",
        requiresSetup: false,
        capabilities: { networkEgress: false, mounts: false, lifecyclePause: false, readOnly: false },
        async check() {
          return true
        },
        ...(withUpload ? { defaultCwd: boxHome } : {}),
      }
    }
    return { providerResolver, connectCalls }
  }

  it("re-uploads the redacted copy on re-attach and stamps loginFile on the forwarded auth", async () => {
    const { providerResolver, connectCalls } = await setup()

    const result = await restartAgentSession(registry, hostResolver, prev, {
      resolveSandboxProvider: providerResolver,
      loadDefaultsConfig: async () => undefined,
    })

    // Re-attached the EXISTING box — never a fresh boot, never a local spawn.
    expect(connectCalls).toEqual(["sbx_prev_1"])
    expect(result.desc.remote).toBe(true)
    expect(result.desc.sandboxId).toBe("sbx_prev_1")

    // One upload at the recipe's home-relative path inside the box home, with
    // the keep-list only — refresh material and the host's API key stay home.
    expect(writeFile).toHaveBeenCalledTimes(1)
    expect(writes[0]!.path).toBe(join(boxHome, ".codex/auth.json"))
    const copy = JSON.parse(writes[0]!.body) as Record<string, any>
    expect(copy.tokens).toEqual({
      access_token: "host-access-token",
      account_id: "acct_123",
    })
    expect(copy.last_refresh).toBe("2026-10-14T00:00:00.000Z")
    expect(writes[0]!.body).not.toContain("host-refresh-secret")
    expect(writes[0]!.body).not.toContain("sk-host-should-never-cross")

    // The copy landed BEFORE the box's own agent_start, and the auth block it
    // received carries the marker with no token value.
    expect(events).toEqual(["write", "start"])
    const boxAuth = receivedStarts[0]!.auth as Record<string, unknown>
    expect(boxAuth.loginFile).toBe(true)
    expect(boxAuth.mode).toBe("subscription")
    expect(boxAuth.credential).toBeUndefined()
    expect(JSON.stringify(boxAuth)).not.toContain("host-access-token")
  })

  it("degrades to today's behavior when the box cannot take a file upload — the restart still re-attaches", async () => {
    const { providerResolver } = await setup({ withUpload: false })

    const result = await restartAgentSession(registry, hostResolver, prev, {
      resolveSandboxProvider: providerResolver,
      loadDefaultsConfig: async () => undefined,
    })

    expect(result.desc.sandboxId).toBe("sbx_prev_1")
    expect(writeFile).not.toHaveBeenCalled()
    expect(readRecipeLoginJson).not.toHaveBeenCalled()
    // No stamp ⇒ the box verifies its OWN login exactly as it does today.
    expect(receivedStarts).toHaveLength(1)
    expect(receivedStarts[0]!.auth).not.toHaveProperty("loginFile")
  })
})
