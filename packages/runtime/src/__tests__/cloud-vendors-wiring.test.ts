/**
 * AIP-66 cloud spawn wiring - the runtime side: `agent_start.cloud` schema
 * and MCP surface, the refusal-before-side-effects guarantee, meta.cloud
 * persistence and re-attach, and the restart resume-id fallback. The pure
 * resolver and meta helpers live in `@agentproto/cloud-agent`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import {
  CLOUD_SESSION_META_FILE_ENV,
  cloudMetaOf,
  cloudSessionIdOf,
  cloudSessionMetaFilePath,
  encodeCloudSessionMeta,
} from "@agentproto/cloud-agent"
import { registerAgentTools } from "../agent-tools.js"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import { restartAgentSession } from "../session-restart-core.js"
import type { AgentAdapterResolver } from "../http-server.js"
import { agentStartInputSchema } from "../agent-start-schema.js"

// ── agent_start schema ─────────────────────────────────────────────────────

describe("agent_start schema - cloud field", () => {
  it("accepts `cloud` and keeps it on the parsed input", () => {
    const parsed = agentStartInputSchema.parse({
      adapter: "claude-code",
      cloud: "anthropic",
      prompt: "do the thing",
    })
    expect(parsed.cloud).toBe("anthropic")
  })

  it("treats `cloud` as optional - a local spawn parses without it", () => {
    const parsed = agentStartInputSchema.parse({ adapter: "claude-code", prompt: "hi" })
    expect(parsed.cloud).toBeUndefined()
  })
})

// ── agent_start over MCP: refusal before side effects + wiring ─────────────

function parseToolJson(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content
  const text = content?.find(c => c.type === "text")?.text
  if (!text) throw new Error("tool returned no text content")
  return JSON.parse(text)
}

async function setup(startSession: (...args: any[]) => Promise<AgentSessionLike>) {
  const registry = createSessionsRegistry({ persist: false })
  const resolveAgentAdapter = vi.fn<AgentAdapterResolver>(async () => ({
    startSession: startSession as any,
    commandPreview: "mock-adapter",
  }))
  const server = new McpServer({ name: "agent-start-cloud-server", version: "0.0.0" })
  registerAgentTools(server, { registry, resolveAgentAdapter })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "agent-start-cloud-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return { client, registry, resolveAgentAdapter }
}

function mockSession(id: string) {
  return {
    sessionId: id,
    send: async function* () {},
    cancel: async () => {},
    close: async () => {},
  }
}

let previousHome: string | undefined
let home: string

beforeEach(async () => {
  previousHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "agp-agent-start-cloud-"))
  process.env.HOME = home
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

describe("agent_start - cloud spawn", () => {
  it("refuses cloud + sandbox before any side effect (no adapter resolution, no session)", async () => {
    const startSession = vi.fn(async () => mockSession("never"))
    const { client, registry, resolveAgentAdapter } = await setup(startSession)

    const res = (await client.callTool({
      name: "agent_start",
      arguments: { adapter: "claude-code", cloud: "anthropic", sandbox: "e2b" },
    })) as { isError?: boolean; content?: Array<{ text?: string }> }

    expect(res.isError).toBe(true)
    expect(res.content?.[0]?.text).toContain("mutually exclusive")
    // The refusal happens at the very top of the spawn: the adapter resolver
    // is never consulted and no session row exists.
    expect(resolveAgentAdapter).not.toHaveBeenCalled()
    expect(startSession).not.toHaveBeenCalled()
    expect(registry.list()).toHaveLength(0)
  })

  it("refuses each §4 field before any side effect", async () => {
    const startSession = vi.fn(async () => mockSession("never"))
    const { client, registry, resolveAgentAdapter } = await setup(startSession)

    for (const field of ["worktree", "mcpServers", "daemonMount", "bundles", "browser", "appServe", "inference", "commandSandbox"] as const) {
      const value =
        field === "worktree"
          ? { repo: "https://example.invalid/r.git" }
          : field === "commandSandbox"
            ? "strict"
            : field === "daemonMount"
              ? true
              : field === "browser"
                ? "chrome"
                : field === "mcpServers" || field === "bundles"
                  ? [{ name: "x" }]
                  : { any: "non-empty" }
      const res = (await client.callTool({
        name: "agent_start",
        arguments: { adapter: "claude-code", cloud: "anthropic", [field]: value },
      })) as { isError?: boolean; content?: Array<{ text?: string }> }
      expect(res.isError).toBe(true)
      expect(res.content?.[0]?.text).toContain(field)
    }
    expect(resolveAgentAdapter).not.toHaveBeenCalled()
    expect(startSession).not.toHaveBeenCalled()
    expect(registry.list()).toHaveLength(0)
  })

  it("refuses an unknown vendor before any side effect", async () => {
    const startSession = vi.fn(async () => mockSession("never"))
    const { client, resolveAgentAdapter } = await setup(startSession)

    const res = (await client.callTool({
      name: "agent_start",
      arguments: { adapter: "claude-code", cloud: "openai", prompt: "hi" },
    })) as { isError?: boolean; content?: Array<{ text?: string }> }
    expect(res.isError).toBe(true)
    expect(res.content?.[0]?.text).toContain("unknown cloud vendor")
    expect(resolveAgentAdapter).not.toHaveBeenCalled()
    expect(startSession).not.toHaveBeenCalled()
  })

  it("refuses a harness the vendor does not run, naming the allowed harnesses", async () => {
    const startSession = vi.fn(async () => mockSession("never"))
    const { client, resolveAgentAdapter } = await setup(startSession)

    const res = (await client.callTool({
      name: "agent_start",
      arguments: { adapter: "codex", cloud: "anthropic", prompt: "hi" },
    })) as { isError?: boolean; content?: Array<{ text?: string }> }
    expect(res.isError).toBe(true)
    expect(res.content?.[0]?.text).toContain("claude-code")
    expect(resolveAgentAdapter).not.toHaveBeenCalled()
  })

  it("resolves claude-code → claude-code-cloud and persists meta.cloud = { vendor }", async () => {
    const startSession = vi.fn(async (_opts: Record<string, any>) => mockSession("acp_uuid_fresh"))
    const { client, registry, resolveAgentAdapter } = await setup(startSession)

    const body = parseToolJson(
      await client.callTool({
        name: "agent_start",
        arguments: { adapter: "claude-code", cloud: "anthropic", prompt: "hello cloud", cwd: "/tmp" },
      }),
    )
    expect(body.id).toMatch(/^sess_/)
    // The relay adapter was resolved, not the local claude-code one.
    expect(resolveAgentAdapter).toHaveBeenCalled()
    for (const call of resolveAgentAdapter.mock.calls) {
      expect(call[0]).toBe("claude-code-cloud")
    }
    expect(startSession).toHaveBeenCalledTimes(1)
    const opts = startSession.mock.calls[0]![0] as Record<string, any>
    // The relay adapter was resolved, not the local claude-code one.
    expect(registry.get(body.id)?.adapterSlug).toBe("claude-code-cloud")
    // The relay is told where to write the learned vendor session id.
    expect(opts.env?.[CLOUD_SESSION_META_FILE_ENV]).toMatch(/cloud-session\.json$/)
    // The descriptor carries the vendor binding (JSON-encoded - meta values
    // are strings); the session id is learned later from the side file.
    const desc = registry.get(body.id)
    expect(cloudMetaOf(desc as any)).toEqual({ vendor: "anthropic" })
    expect(cloudSessionIdOf(desc as any)).toBeUndefined()
  })

  it("re-attach prefers meta.cloud.sessionId over the ACP uuid as the resume target", async () => {
    const startSession = vi.fn(async (_opts: Record<string, any>) => mockSession("acp_uuid_row"))
    const { client, registry } = await setup(startSession)

    const first = parseToolJson(
      await client.callTool({
        name: "agent_start",
        arguments: { adapter: "claude-code", cloud: "anthropic", prompt: "first", cwd: "/tmp" },
      }),
    )
    expect(first.id).toMatch(/^sess_/)
    expect(startSession).toHaveBeenCalledTimes(1)

    // Simulate the relay reporting the vendor id (what watchCloudSessionMeta
    // does when the side file appears).
    registry.mergeMeta(first.id, {
      cloud: encodeCloudSessionMeta({
        vendor: "anthropic",
        sessionId: "session_learned",
        url: "https://claude.ai/code/session_learned",
      }),
    })
    expect(cloudSessionIdOf(registry.get(first.id))).toBe("session_learned")

    startSession.mockClear()
    // The AIP-66 §5 re-attach: same cloud vendor, resume the learned id.
    const second = parseToolJson(
      await client.callTool({
        name: "agent_start",
        arguments: {
          adapter: "claude-code",
          cloud: "anthropic",
          resumeSessionId: first.id,
          prompt: "second",
          cwd: "/tmp",
        },
      }),
    )
    expect(second.id).toMatch(/^sess_/)
    expect(startSession).toHaveBeenCalledTimes(1)
    // The adapter is handed the VENDOR id, not the row's ACP uuid.
    const opts = startSession.mock.calls[0]![0] as Record<string, any>
    expect(opts.resumeSessionId).toBe("session_learned")
    // The revived row keeps the vendor mapping (carried forward).
    expect(cloudMetaOf(registry.get(second.id) as any)).toEqual({
      vendor: "anthropic",
      sessionId: "session_learned",
      url: "https://claude.ai/code/session_learned",
    })
  })

  it("cloud with NO adapter resolves to the vendor's cloud adapter (no 'adapter is required' failure)", async () => {
    const startSession = vi.fn(async () => mockSession("acp_uuid_no_adapter"))
    const { client, registry, resolveAgentAdapter } = await setup(startSession)

    const body = parseToolJson(
      await client.callTool({
        name: "agent_start",
        arguments: { cloud: "anthropic", prompt: "hello cloud", cwd: "/tmp" },
      }),
    )
    expect(body.id).toMatch(/^sess_/)
    // spawnAgentSession resolved the vendor's relay adapter.
    expect(resolveAgentAdapter).toHaveBeenCalled()
    for (const call of resolveAgentAdapter.mock.calls) {
      expect(call[0]).toBe("claude-code-cloud")
    }
    expect(registry.get(body.id)?.adapterSlug).toBe("claude-code-cloud")
    expect(cloudMetaOf(registry.get(body.id) as any)).toEqual({ vendor: "anthropic" })
  })

  it("cloud + adapter 'hermes' → cloud_spawn_refused, naming the vendor's allowed harness", async () => {
    const startSession = vi.fn(async () => mockSession("never"))
    const { client, registry, resolveAgentAdapter } = await setup(startSession)

    const res = (await client.callTool({
      name: "agent_start",
      arguments: { cloud: "anthropic", adapter: "hermes", prompt: "hi", cwd: "/tmp" },
    })) as { isError?: boolean; content?: Array<{ text?: string }> }
    expect(res.isError).toBe(true)
    // Structured like the HTTP route: the typed code plus a message naming
    // the vendor and its allowed harnesses.
    const body = parseToolJson(res)
    expect(body.error).toBe("cloud_spawn_refused")
    expect(body.message).toContain("hermes")
    expect(body.message).toContain("anthropic")
    expect(body.message).toContain("claude-code")
    // Refused before any side effect.
    expect(resolveAgentAdapter).not.toHaveBeenCalled()
    expect(startSession).not.toHaveBeenCalled()
    expect(registry.list()).toHaveLength(0)
  })

  it("re-attach falls back to the relay's meta file when the watch never stamped meta.cloud (daemon-restart survivor)", async () => {
    const startSession = vi.fn(async (_opts: Record<string, any>) => mockSession("acp_uuid_fallback"))
    const { client, registry } = await setup(startSession)

    const first = parseToolJson(
      await client.callTool({
        name: "agent_start",
        arguments: { cloud: "anthropic", prompt: "first", cwd: "/tmp" },
      }),
    )
    expect(first.id).toMatch(/^sess_/)
    // The spawn-time watch died (daemon restart) before learning anything -
    // meta.cloud is still vendor-only. The relay, however, wrote the vendor
    // id into the meta file inside this session's isolated config dir.
    const metaPath = (startSession.mock.calls[0]![0] as Record<string, any>).env?.[
      CLOUD_SESSION_META_FILE_ENV
    ] as string
    expect(metaPath).toMatch(/cloud-session\.json$/)
    await mkdir(dirname(metaPath), { recursive: true })
    await writeFile(
      metaPath,
      JSON.stringify({ vendor: "anthropic", sessionId: "session_from_file" }),
      "utf8",
    )
    expect(cloudSessionIdOf(registry.get(first.id) as any)).toBeUndefined()

    startSession.mockClear()
    const second = parseToolJson(
      await client.callTool({
        name: "agent_start",
        arguments: {
          cloud: "anthropic",
          resumeSessionId: first.id,
          prompt: "second",
          cwd: "/tmp",
        },
      }),
    )
    expect(second.id).toMatch(/^sess_/)
    // The adapter is handed the VENDOR id read from the side file.
    const opts = startSession.mock.calls[0]![0] as Record<string, any>
    expect(opts.resumeSessionId).toBe("session_from_file")
    // The SOURCE row was stamped so later resumes take the learned path.
    expect(cloudSessionIdOf(registry.get(first.id) as any)).toBe("session_from_file")
    expect(cloudMetaOf(registry.get(second.id) as any)).toMatchObject({
      vendor: "anthropic",
      sessionId: "session_from_file",
    })
  })

  it("mergeMeta overwrites only the named key and persists through the registry", async () => {
    const startSession = vi.fn(async () => mockSession("acp_uuid_merge"))
    const { client, registry } = await setup(startSession)
    const body = parseToolJson(
      await client.callTool({
        name: "agent_start",
        arguments: { adapter: "claude-code", prompt: "x", cwd: "/tmp" },
      }),
    )
    registry.mergeMeta(body.id, { cloud: encodeCloudSessionMeta({ vendor: "anthropic" }) })
    registry.mergeMeta(body.id, {
      cloud: encodeCloudSessionMeta({ vendor: "anthropic", sessionId: "session_2" }),
    })
    const desc = registry.get(body.id)
    expect(cloudMetaOf(desc as any)).toEqual({ vendor: "anthropic", sessionId: "session_2" })
    // Unrelated meta keys are untouched.
    expect(desc?.meta?.["cloud"]).toContain("session_2")
  })
})

// ── restartAgentSession - the resume-side fallback wired in (AIP-66 §5) ────

describe("restartAgentSession - cloud resume id fallback", () => {
  it("resumes the vendor id from the meta file for a cloud row that never learned it, and stamps the source row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agp-cloud-restart-"))
    try {
      await writeFile(
        cloudSessionMetaFilePath(dir),
        JSON.stringify({ vendor: "anthropic", sessionId: "session_restart_file" }),
        "utf8",
      )
      const registry = createSessionsRegistry({ persist: false })
      const prev = registry.spawnAgent({
        workspaceSlug: "default",
        cwd: "/tmp",
        agentSession: mockSession("acp_uuid_prev"),
        adapterSlug: "claude-code-cloud",
        adapterConfigDir: dir,
        // Spawn-time binding learned; the id never stamped (watch killed by
        // the daemon restart that is now restarting this row).
        meta: { cloud: encodeCloudSessionMeta({ vendor: "anthropic" }) },
      })
      registry.kill(prev.id)

      const calls: Array<{ adapter: string; resumeSessionId?: string }> = []
      const resolver: AgentAdapterResolver = async slug => ({
        async startSession(sessOpts: Record<string, any>) {
          calls.push({
            adapter: slug,
            ...(sessOpts.resumeSessionId ? { resumeSessionId: sessOpts.resumeSessionId } : {}),
          })
          return mockSession("acp_uuid_restarted")
        },
        commandPreview: `mock-${slug}`,
      })

      const restarted = await restartAgentSession(registry, resolver, prev, {
        forceAgentResume: true,
        loadDefaultsConfig: async () => ({}),
      })
      expect(restarted.desc.id).toMatch(/^sess_/)
      // The adapter was handed the VENDOR id read from the side file, not
      // the row's ACP uuid.
      expect(calls[0]?.adapter).toBe("claude-code-cloud")
      expect(calls[0]?.resumeSessionId).toBe("session_restart_file")
      // The source row was stamped, so the NEXT resume takes the learned path.
      expect(cloudSessionIdOf(registry.get(prev.id) as any)).toBe("session_restart_file")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("carries meta.cloud + the vendor harness label onto the restarted descriptor", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const cloud = {
      vendor: "anthropic",
      sessionId: "session_live",
      url: "https://claude.ai/code/session_live",
    }
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: mockSession("acp_uuid_prev"),
      adapterSlug: "claude-code-cloud",
      // The descriptor a cloud spawn records carries the VENDOR harness, not
      // the relay adapter slug - but a stale/pre-#1953 row can spell it as the
      // adapter slug, which the restart must not propagate.
      harness: "claude-code-cloud",
      meta: { cloud: encodeCloudSessionMeta(cloud) },
    })
    registry.kill(prev.id)

    const resolver: AgentAdapterResolver = async () => ({
      async startSession() {
        return mockSession("acp_uuid_restarted")
      },
      commandPreview: "mock-claude-code-cloud",
    })

    const restarted = await restartAgentSession(registry, resolver, prev, {
      forceAgentResume: true,
      loadDefaultsConfig: async () => ({}),
    })
    expect(restarted.desc.id).toMatch(/^sess_/)
    expect(restarted.desc.id).not.toBe(prev.id)
    // The vendor binding is preserved byte-for-byte (same JSON string).
    expect(restarted.desc.meta?.cloud).toBe(
      encodeCloudSessionMeta(cloud),
    )
    expect(cloudMetaOf(restarted.desc as any)).toEqual(cloud)
    // The harness label is the vendor's (`claude-code`), not the relay slug.
    expect(restarted.desc.harness).toBe("claude-code")
  })

  it("leaves a non-cloud restart's harness and meta unchanged", async () => {
    const registry = createSessionsRegistry({ persist: false })
    const prev = registry.spawnAgent({
      workspaceSlug: "default",
      cwd: "/tmp",
      agentSession: mockSession("acp_uuid_local"),
      adapterSlug: "claude-code",
      harness: "claude-code",
    })
    registry.kill(prev.id)

    const resolver: AgentAdapterResolver = async () => ({
      async startSession() {
        return mockSession("acp_uuid_local_restarted")
      },
      commandPreview: "mock-claude-code",
    })

    const restarted = await restartAgentSession(registry, resolver, prev, {
      forceAgentResume: true,
      loadDefaultsConfig: async () => ({}),
    })
    expect(restarted.desc.harness).toBe("claude-code")
    expect(restarted.desc.meta?.cloud).toBeUndefined()
  })
})
