/**
 * AIP-66 managed cloud agents — the vendor registry, the pure spawn
 * resolver (`resolveCloudSpawn`), the `meta.cloud` mapping helpers, the
 * `agent_start.cloud` schema field, and the spawn-level wiring: a refused
 * cloud spawn fails BEFORE any side effect, a resolved one relays through
 * the vendor's cloud adapter, and a re-attach prefers the learned vendor
 * session id. No network: every adapter touch is a mock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

import { registerAgentTools } from "../agent-tools.js"
import { createSessionsRegistry, type AgentSessionLike } from "../sessions.js"
import type { AgentAdapterResolver } from "../http-server.js"
import { agentStartInputSchema } from "../agent-start-schema.js"
import {
  CLOUD_SESSION_META_FILE_ENV,
  CLOUD_VENDORS,
  CloudSpawnError,
  CLOUD_REFUSED_SPAWN_FIELDS,
  cloudMetaOf,
  cloudSessionIdOf,
  decodeCloudSessionMeta,
  encodeCloudSessionMeta,
  readCloudSessionMetaFile,
  resolveCloudSpawn,
  watchCloudSessionMeta,
  type CloudSpawnInput,
} from "../cloud-vendors.js"

// ── resolveCloudSpawn (pure) ────────────────────────────────────────────────

describe("resolveCloudSpawn — refusals", () => {
  it("refuses an unknown vendor slug — never mapped to a default", () => {
    expect(() => resolveCloudSpawn({ cloud: "openai" })).toThrow(CloudSpawnError)
    try {
      resolveCloudSpawn({ cloud: "bogus" })
    } catch (err) {
      expect(err).toBeInstanceOf(CloudSpawnError)
      expect((err as CloudSpawnError).code).toBe("cloud_spawn_refused")
      expect((err as CloudSpawnError).message).toContain("unknown cloud vendor")
      expect((err as CloudSpawnError).message).toContain("bogus")
      expect((err as CloudSpawnError).message).toContain(Object.keys(CLOUD_VENDORS).join(", "))
    }
  })

  it("refuses cloud + sandbox (mutually exclusive, AIP-66 §1)", () => {
    try {
      resolveCloudSpawn({ cloud: "anthropic", sandbox: {} })
      throw new Error("expected a refusal")
    } catch (err) {
      expect(err).toBeInstanceOf(CloudSpawnError)
      expect((err as CloudSpawnError).field).toBe("sandbox")
      expect((err as CloudSpawnError).message).toContain("mutually exclusive")
    }
  })

  for (const field of CLOUD_REFUSED_SPAWN_FIELDS) {
    if (field === "sandbox") continue // covered above (its own message)
    it(`refuses \`${field}\` by name (AIP-66 §4)`, () => {
      const value: Record<string, unknown> = {
        cloud: "anthropic",
        [field]:
          field === "commandSandbox"
            ? "strict"
            : field === "daemonMount"
              ? true
              : field === "browser"
                ? "chrome"
                : field === "mcpServers" || field === "bundles"
                  ? [{ name: "x" }]
                  : { any: "non-empty" },
      }
      try {
        resolveCloudSpawn(value as unknown as CloudSpawnInput)
        throw new Error("expected a refusal")
      } catch (err) {
        expect(err).toBeInstanceOf(CloudSpawnError)
        expect((err as CloudSpawnError).field).toBe(field)
        expect((err as CloudSpawnError).code).toBe("cloud_spawn_refused")
        expect((err as CloudSpawnError).message).toContain(`\`${field}\``)
      }
    })
  }

  it("accepts the §4 fields in their no-op spellings (false / off / empty)", () => {
    const resolved = resolveCloudSpawn({
      cloud: "anthropic",
      worktree: false,
      commandSandbox: "off",
      mcpServers: [],
      daemonMount: false,
      bundles: [],
      browser: false,
    })
    expect(resolved.adapter).toBe("claude-code-cloud")
  })

  it("refuses a harness the vendor does not run — naming the allowed ones", () => {
    try {
      resolveCloudSpawn({ cloud: "anthropic", harness: "codex" })
      throw new Error("expected a refusal")
    } catch (err) {
      expect(err).toBeInstanceOf(CloudSpawnError)
      expect((err as CloudSpawnError).message).toContain("codex")
      expect((err as CloudSpawnError).message).toContain("anthropic")
      // The allowed harnesses are named in the error (AIP-66 §2).
      expect((err as CloudSpawnError).message).toContain("claude-code")
      expect((err as CloudSpawnError).message).toContain("claude-code-cloud")
    }
    expect(() => resolveCloudSpawn({ cloud: "anthropic", adapter: "hermes" })).toThrow(
      CloudSpawnError,
    )
  })
})

describe("resolveCloudSpawn — resolution", () => {
  it("adapter claude-code → relay adapter claude-code-cloud, harness claude-code", () => {
    expect(resolveCloudSpawn({ cloud: "anthropic", adapter: "claude-code" })).toEqual({
      vendor: CLOUD_VENDORS["anthropic"],
      adapter: "claude-code-cloud",
      harness: "claude-code",
    })
  })

  it("harness claude-code → the same resolution", () => {
    expect(resolveCloudSpawn({ cloud: "anthropic", harness: "claude-code" })).toEqual({
      vendor: CLOUD_VENDORS["anthropic"],
      adapter: "claude-code-cloud",
      harness: "claude-code",
    })
  })

  it("unset adapter/harness → the vendor's relay adapter", () => {
    expect(resolveCloudSpawn({ cloud: "anthropic" })).toEqual({
      vendor: CLOUD_VENDORS["anthropic"],
      adapter: "claude-code-cloud",
      harness: "claude-code-cloud",
    })
  })

  it("the relay adapter itself is accepted as the requested adapter", () => {
    expect(resolveCloudSpawn({ cloud: "anthropic", adapter: "claude-code-cloud" })).toEqual({
      vendor: CLOUD_VENDORS["anthropic"],
      adapter: "claude-code-cloud",
      harness: "claude-code-cloud",
    })
  })
})

// ── meta.cloud mapping (AIP-66 §5) ─────────────────────────────────────────

describe("meta.cloud encode/decode", () => {
  it("round-trips a mapping through the string-valued descriptor meta", () => {
    const encoded = encodeCloudSessionMeta({
      vendor: "anthropic",
      sessionId: "session_01Fake",
      url: "https://claude.ai/code/session_01Fake",
    })
    expect(typeof encoded).toBe("string") // SessionDescriptor.meta is Record<string,string>
    expect(decodeCloudSessionMeta(encoded)).toEqual({
      vendor: "anthropic",
      sessionId: "session_01Fake",
      url: "https://claude.ai/code/session_01Fake",
    })
  })

  it("decodes a vendor-only mapping and tolerates an already-parsed object", () => {
    expect(decodeCloudSessionMeta(encodeCloudSessionMeta({ vendor: "anthropic" }))).toEqual({
      vendor: "anthropic",
    })
    expect(decodeCloudSessionMeta({ vendor: "anthropic", sessionId: "session_x" })).toEqual({
      vendor: "anthropic",
      sessionId: "session_x",
    })
  })

  it("returns undefined for absent/garbage/credential-shaped values — never throws", () => {
    expect(decodeCloudSessionMeta(undefined)).toBeUndefined()
    expect(decodeCloudSessionMeta("")).toBeUndefined()
    expect(decodeCloudSessionMeta("{not json")).toBeUndefined()
    expect(decodeCloudSessionMeta("[1,2]")).toBeUndefined()
    expect(decodeCloudSessionMeta({ vendor: "" })).toBeUndefined()
    expect(decodeCloudSessionMeta({ noVendor: true })).toBeUndefined()
    // An empty sessionId is dropped rather than persisted as "".
    expect(decodeCloudSessionMeta({ vendor: "anthropic", sessionId: "" })).toEqual({
      vendor: "anthropic",
    })
  })

  it("cloudMetaOf / cloudSessionIdOf read the descriptor's meta.cloud", () => {
    const desc = {
      meta: {
        cloud: encodeCloudSessionMeta({
          vendor: "anthropic",
          sessionId: "session_learned",
          url: "https://claude.ai/code/session_learned",
        }),
      },
    }
    expect(cloudMetaOf(desc)?.sessionId).toBe("session_learned")
    expect(cloudSessionIdOf(desc)).toBe("session_learned")
    expect(cloudSessionIdOf({ meta: {} })).toBeUndefined()
    expect(cloudSessionIdOf(undefined)).toBeUndefined()
  })

  it("never carries a credential-shaped field through the mapping", () => {
    const decoded = decodeCloudSessionMeta(
      encodeCloudSessionMeta({
        vendor: "anthropic",
        sessionId: "session_01Fake",
        url: "https://claude.ai/code/session_01Fake",
      }),
    )
    expect(Object.keys(decoded ?? {}).sort()).toEqual(["sessionId", "url", "vendor"])
  })
})

// ── the relay's meta side file (AIP-66 §5/§8) ──────────────────────────────

describe("readCloudSessionMetaFile / watchCloudSessionMeta", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agp-cloud-meta-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("returns null for absent / unparseable / incomplete files — never throws", async () => {
    expect(await readCloudSessionMetaFile(join(dir, "missing.json"))).toBeNull()
    const garbage = join(dir, "garbage.json")
    await writeFile(garbage, "{oops", "utf8")
    expect(await readCloudSessionMetaFile(garbage)).toBeNull()
    const noId = join(dir, "noid.json")
    await writeFile(noId, JSON.stringify({ vendor: "anthropic" }), "utf8")
    expect(await readCloudSessionMetaFile(noId)).toBeNull()
  })

  it("reads a well-formed relay file (vendor + sessionId + url)", async () => {
    const path = join(dir, "cloud-session.json")
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({
        vendor: "anthropic",
        sessionId: "session_01Fake",
        url: "https://claude.ai/code/session_01Fake",
      }),
      "utf8",
    )
    expect(await readCloudSessionMetaFile(path)).toEqual({
      vendor: "anthropic",
      sessionId: "session_01Fake",
      url: "https://claude.ai/code/session_01Fake",
    })
  })

  it("watchCloudSessionMeta calls onLearned exactly once when the file appears", async () => {
    const path = join(dir, "cloud-session.json")
    const onLearned = vi.fn()
    const stop = watchCloudSessionMeta({
      metaFilePath: path,
      vendor: "anthropic",
      onLearned,
      intervalMs: 1,
      timeoutMs: 2_000,
    })
    try {
      // No file yet — the poll keeps watching, never learning.
      await new Promise(resolve => setTimeout(resolve, 15))
      expect(onLearned).not.toHaveBeenCalled()

      // The relay writes the file; the next tick learns it and stops.
      await mkdir(dirname(path), { recursive: true })
      await writeFile(
        path,
        JSON.stringify({ vendor: "anthropic", sessionId: "session_learned" }),
        "utf8",
      )
      await vi.waitFor(() => expect(onLearned).toHaveBeenCalledTimes(1))
      expect(onLearned).toHaveBeenCalledWith({
        vendor: "anthropic",
        sessionId: "session_learned",
      })
      // No further callback after learning.
      await new Promise(resolve => setTimeout(resolve, 15))
      expect(onLearned).toHaveBeenCalledTimes(1)
    } finally {
      stop()
    }
  })

  it("watchCloudSessionMeta stops when shouldContinue turns false (session died)", async () => {
    const path = join(dir, "cloud-session.json")
    const onLearned = vi.fn()
    const stop = watchCloudSessionMeta({
      metaFilePath: path,
      vendor: "anthropic",
      onLearned,
      shouldContinue: () => false,
      intervalMs: 1,
      timeoutMs: 2_000,
    })
    try {
      // The session is dead on the first tick: the watch stops WITHOUT
      // reading — even after the file appears, nothing is learned.
      await mkdir(dirname(path), { recursive: true })
      await writeFile(
        path,
        JSON.stringify({ vendor: "anthropic", sessionId: "session_late" }),
        "utf8",
      )
      await new Promise(resolve => setTimeout(resolve, 15))
      expect(onLearned).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })
})

// ── agent_start schema ─────────────────────────────────────────────────────

describe("agent_start schema — cloud field", () => {
  it("accepts `cloud` and keeps it on the parsed input", () => {
    const parsed = agentStartInputSchema.parse({
      adapter: "claude-code",
      cloud: "anthropic",
      prompt: "do the thing",
    })
    expect(parsed.cloud).toBe("anthropic")
  })

  it("treats `cloud` as optional — a local spawn parses without it", () => {
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

describe("agent_start — cloud spawn", () => {
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
    // The descriptor carries the vendor binding (JSON-encoded — meta values
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
