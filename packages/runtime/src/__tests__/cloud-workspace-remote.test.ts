/**
 * AIP-66 cloud spawn on a workspace with a declared `remote`
 * (`workspaces.json`): the runtime hands the relay the remote's url, branch,
 * a checkout dir inside the session's isolated config dir, and — for a
 * `credentialRef` — the keychain-resolved git token, so the relay clones the
 * repo itself (no local clone needed). Same declared-repo shape a sandbox
 * spawn uses. No network: adapter, keychain and workspaces config are mocks.
 */

import { describe, expect, it, vi, beforeEach } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerAgentTools } from "../agent-tools.js"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { restartAgentSession } from "../session-restart-core.js"
import type { AgentAdapterResolver } from "../http-server.js"
import {
  CLOUD_REPO_BRANCH_ENV,
  CLOUD_REPO_DIR_ENV,
  CLOUD_REPO_URL_ENV,
  CLOUD_SESSION_META_FILE_ENV,
  CloudSpawnError,
  cloudRepoCheckoutDir,
  cloudRepoSpawnEnv,
  encodeCloudSessionMeta,
} from "../cloud-vendors.js"
import { GIT_TOKEN_ENV } from "../sandbox-workspace-remote.js"
import type { WorkspacesConfig } from "../workspaces-config.js"

const FAKE_TOKEN = "ghp_fake_cloud_token_0001"
const REMOTE_URL = "https://github.com/acme/repo"

const keychain = vi.hoisted(() => ({ values: {} as Record<string, string> }))
vi.mock("@agentproto/auth", async importOriginal => {
  const actual = await importOriginal<typeof import("@agentproto/auth")>()
  class FakeKeychainStore {
    async read(ref: { path: string }) {
      const value = keychain.values[ref.path]
      return value === undefined ? undefined : { value, kind: "pat" }
    }
  }
  return { ...actual, KeychainStore: FakeKeychainStore }
})

const wsConfigState = vi.hoisted(() => ({
  value: { version: 1, workspaces: [] } as WorkspacesConfig,
}))
vi.mock("../workspaces-config.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../workspaces-config.js")>()
  return { ...actual, loadWorkspacesConfig: vi.fn(async () => wsConfigState.value) }
})

function mockSession(id: string): AgentSessionLike {
  return {
    sessionId: id,
    send: async function* () {},
    cancel: async () => {},
    close: async () => {},
  } as unknown as AgentSessionLike
}

function workspace(remote?: WorkspacesConfig["workspaces"][number]["remote"]) {
  wsConfigState.value = {
    version: 1,
    workspaces: [
      {
        slug: "acme",
        path: "/host/acme-no-clone",
        addedAt: "2026-10-20T00:00:00.000Z",
        updatedAt: "2026-10-20T00:00:00.000Z",
        ...(remote ? { remote } : {}),
      },
    ],
  }
}

async function setup(startSession: (...args: any[]) => Promise<AgentSessionLike>) {
  const registry = createSessionsRegistry({ persist: false })
  const resolveAgentAdapter = vi.fn<AgentAdapterResolver>(async () => ({
    startSession: startSession as any,
    commandPreview: "mock-adapter",
  }))
  const server = new McpServer({ name: "cloud-remote-server", version: "0.0.0" })
  registerAgentTools(server, { registry, resolveAgentAdapter })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "cloud-remote-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return { client, registry }
}

beforeEach(() => {
  keychain.values = {}
  wsConfigState.value = { version: 1, workspaces: [] }
})

describe("cloudRepoSpawnEnv", () => {
  it("is empty when the workspace declares no remote", async () => {
    expect(await cloudRepoSpawnEnv(undefined, "/cfg", async () => undefined)).toEqual({})
  })

  it("carries url, default branch and the checkout dir inside the config dir", async () => {
    expect(await cloudRepoSpawnEnv({ url: REMOTE_URL }, "/cfg", async () => undefined)).toEqual({
      [CLOUD_REPO_URL_ENV]: REMOTE_URL,
      [CLOUD_REPO_BRANCH_ENV]: "main",
      [CLOUD_REPO_DIR_ENV]: cloudRepoCheckoutDir("/cfg"),
    })
  })

  it("resolves a credentialRef into the git token, and refuses one that resolves to nothing", async () => {
    const env = await cloudRepoSpawnEnv(
      { url: REMOTE_URL, defaultBranch: "develop", credentialRef: "git/acme" },
      "/cfg",
      async ref => (ref === "git/acme" ? FAKE_TOKEN : undefined),
    )
    expect(env[GIT_TOKEN_ENV]).toBe(FAKE_TOKEN)
    expect(env[CLOUD_REPO_BRANCH_ENV]).toBe("develop")

    await expect(
      cloudRepoSpawnEnv({ url: REMOTE_URL, credentialRef: "git/gone" }, "/cfg", async () => undefined),
    ).rejects.toBeInstanceOf(CloudSpawnError)
  })
})

describe("agent_start — cloud on a declared workspace remote", () => {
  it("hands the relay the declared remote + keychain token, no local clone required", async () => {
    workspace({ url: REMOTE_URL, defaultBranch: "main", credentialRef: "git/acme" })
    keychain.values["git/acme"] = FAKE_TOKEN
    const startSession = vi.fn(async (_opts: Record<string, any>) => mockSession("acp_uuid"))
    const { client, registry } = await setup(startSession)

    const res = (await client.callTool({
      name: "agent_start",
      arguments: { cloud: "anthropic", workspaceSlug: "acme", prompt: "hi" },
    })) as { isError?: boolean; content?: Array<{ text?: string }> }
    expect(res.isError).not.toBe(true)

    const env = (startSession.mock.calls[0]![0] as Record<string, any>).env as Record<string, string>
    expect(env[CLOUD_REPO_URL_ENV]).toBe(REMOTE_URL)
    expect(env[CLOUD_REPO_BRANCH_ENV]).toBe("main")
    // Checkout dir sits next to the relay's meta file, in the isolated config dir.
    expect(env[CLOUD_REPO_DIR_ENV]).toBe(
      cloudRepoCheckoutDir(env[CLOUD_SESSION_META_FILE_ENV]!.replace(/\/cloud-session\.json$/, "")),
    )
    expect(env[GIT_TOKEN_ENV]).toBe(FAKE_TOKEN)
    // The token never lands on the descriptor.
    expect(JSON.stringify(registry.list())).not.toContain(FAKE_TOKEN)
  })

  it("refuses the spawn when the remote's credentialRef resolves to nothing", async () => {
    workspace({ url: REMOTE_URL, credentialRef: "git/missing" })
    const startSession = vi.fn(async () => mockSession("never"))
    const { client, registry } = await setup(startSession)

    const res = (await client.callTool({
      name: "agent_start",
      arguments: { cloud: "anthropic", workspaceSlug: "acme", prompt: "hi" },
    })) as { isError?: boolean; content?: Array<{ text?: string }> }
    expect(res.isError).toBe(true)
    expect(res.content?.[0]?.text).toContain("workspace.remote.credentialRef")
    expect(startSession).not.toHaveBeenCalled()
    expect(registry.list()).toHaveLength(0)
  })

  it("a workspace without a remote keeps the local-checkout path (no repo env)", async () => {
    workspace()
    const startSession = vi.fn(async (_opts: Record<string, any>) => mockSession("acp_uuid"))
    const { client } = await setup(startSession)

    await client.callTool({
      name: "agent_start",
      arguments: { cloud: "anthropic", workspaceSlug: "acme", prompt: "hi" },
    })
    const opts = startSession.mock.calls[0]![0] as Record<string, any>
    expect(opts.cwd).toBe("/host/acme-no-clone")
    expect(opts.env[CLOUD_REPO_URL_ENV]).toBeUndefined()
    expect(opts.env[GIT_TOKEN_ENV]).toBeUndefined()
  })

  it("a non-cloud spawn on the same workspace never gets the repo env", async () => {
    workspace({ url: REMOTE_URL, credentialRef: "git/acme" })
    keychain.values["git/acme"] = FAKE_TOKEN
    const startSession = vi.fn(async (_opts: Record<string, any>) => mockSession("acp_uuid"))
    const { client } = await setup(startSession)

    await client.callTool({
      name: "agent_start",
      arguments: { adapter: "claude-code", workspaceSlug: "acme", prompt: "hi" },
    })
    const env = (startSession.mock.calls[0]![0] as Record<string, any>).env as Record<string, string>
    expect(env[CLOUD_REPO_URL_ENV]).toBeUndefined()
    expect(env[GIT_TOKEN_ENV]).toBeUndefined()
  })
})

describe("restartAgentSession — cloud on a declared workspace remote", () => {
  it("re-hands the relay the meta file and the same clone source in the same config dir", async () => {
    workspace({ url: REMOTE_URL, credentialRef: "git/acme" })
    keychain.values["git/acme"] = FAKE_TOKEN
    const registry = createSessionsRegistry({ persist: false })
    const prev = registry.spawnAgent({
      workspaceSlug: "acme",
      cwd: "/host/acme-no-clone",
      agentSession: mockSession("acp_uuid_prev"),
      adapterSlug: "claude-code-cloud",
      harness: "claude-code",
      adapterConfigDir: "/cfg/prev",
      meta: { cloud: encodeCloudSessionMeta({ vendor: "anthropic", sessionId: "session_live" }) },
    })
    registry.kill(prev.id)

    const starts: Array<Record<string, any>> = []
    const resolver: AgentAdapterResolver = async () => ({
      async startSession(opts: Record<string, any>) {
        starts.push(opts)
        return mockSession("acp_uuid_restarted")
      },
      commandPreview: "mock-claude-code-cloud",
    })
    await restartAgentSession(registry, resolver, prev, {
      forceAgentResume: true,
      loadDefaultsConfig: async () => ({}),
    })
    const env = starts[0]!.env as Record<string, string>
    expect(env[CLOUD_SESSION_META_FILE_ENV]).toBe("/cfg/prev/cloud-session.json")
    expect(env[CLOUD_REPO_URL_ENV]).toBe(REMOTE_URL)
    expect(env[CLOUD_REPO_DIR_ENV]).toBe(cloudRepoCheckoutDir("/cfg/prev"))
    expect(env[GIT_TOKEN_ENV]).toBe(FAKE_TOKEN)
  })
})
