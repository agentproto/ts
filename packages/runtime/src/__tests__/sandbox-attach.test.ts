import { describe, it, expect, vi } from "vitest"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { BootedSandbox, SandboxBootOpts, SandboxSpec } from "@agentproto/sandbox"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"
import type { SandboxProviderResolver } from "../sandbox-adapters.js"
import {
  attachSandbox,
  buildMcpConfigSnippet,
  registerSandboxAttachTool,
} from "../sandbox-attach.js"

// ── fake McpServer that captures registered tools ──────────────────────────

interface Registered {
  name: string
  description: string
  shape: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<{
    content: { type: "text"; text: string }[]
    isError?: boolean
  }>
}

function fakeServer(): { server: McpServer; tools: Registered[] } {
  const tools: Registered[] = []
  const server = {
    tool: (
      name: string,
      description: string,
      shape: Record<string, unknown>,
      handler: Registered["handler"],
    ) => {
      tools.push({ name, description, shape, handler })
    },
  } as unknown as McpServer
  return { server, tools }
}

const CAPABILITIES = { networkEgress: true, mounts: false, lifecyclePause: true, readOnly: false }

/** Fake `SandboxProviderHandle` whose `connect()` is a spy returning `booted`
 *  (or throwing `connectError`). Mirrors the resolver-injection seam
 *  `bootSandboxAgentSession`/`registerSandboxAdapterTools` already use. */
function fakeHandle(opts: {
  connect?: (id: string, spec: SandboxSpec, bootOpts: SandboxBootOpts) => Promise<BootedSandbox>
  omitConnect?: boolean
}): SandboxProviderHandle {
  const stop = vi.fn(async () => {})
  const pause = vi.fn(async () => {})
  return {
    slug: "box",
    name: "Box",
    version: "installed",
    description: "fake",
    requiresSetup: true,
    capabilities: CAPABILITIES,
    provider: {
      boot: vi.fn(async () => {
        throw new Error("attachSandbox must never call boot()")
      }),
      ...(opts.omitConnect
        ? {}
        : {
            connect:
              opts.connect ??
              (async () => ({
                mcpUrl: "https://frazil-18790.on.ascii.dev/mcp",
                sandboxId: "bx_abc",
                token: "tok_secret",
                stop,
                pause,
              })),
          }),
    },
    async check() {
      return true
    },
  }
}

function resolverFor(handle: SandboxProviderHandle | null): SandboxProviderResolver {
  return async () => handle
}

// ── attachSandbox ────────────────────────────────────────────────────────

describe("attachSandbox", () => {
  it("returns sandbox_provider_not_found when the resolver has no handle for the slug", async () => {
    const result = await attachSandbox({
      provider: "box",
      sandboxId: "bx_abc",
      resolveSandboxProvider: resolverFor(null),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("sandbox_provider_not_found")
  })

  it("returns sandbox_no_connect when the resolved provider has no connect()", async () => {
    const handle = fakeHandle({ omitConnect: true })
    const result = await attachSandbox({
      provider: "box",
      sandboxId: "bx_abc",
      resolveSandboxProvider: resolverFor(handle),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("sandbox_no_connect")
  })

  it("returns sandbox_attach_failed when connect() throws", async () => {
    const handle = fakeHandle({
      connect: async () => {
        throw new Error("box is archived")
      },
    })
    const result = await attachSandbox({
      provider: "box",
      sandboxId: "bx_abc",
      resolveSandboxProvider: resolverFor(handle),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("sandbox_attach_failed")
      expect(result.message).toContain("box is archived")
    }
  })

  it("returns sandbox_attach_ungated when connect() succeeds but returns no token — never emits an ungated URL", async () => {
    const stop = vi.fn(async () => {})
    const handle = fakeHandle({
      connect: async () => ({
        mcpUrl: "https://frazil-18790.on.ascii.dev/mcp",
        sandboxId: "bx_abc",
        stop,
      }),
    })
    const result = await attachSandbox({
      provider: "box",
      sandboxId: "bx_abc",
      resolveSandboxProvider: resolverFor(handle),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("sandbox_attach_ungated")
    expect(stop).not.toHaveBeenCalled()
  })

  it("requests a private, token-gated exposure — never boot(), never stop()/pause()", async () => {
    const stop = vi.fn(async () => {})
    const pause = vi.fn(async () => {})
    const connect = vi.fn(async (_id: string, _spec: SandboxSpec, _opts: SandboxBootOpts) => ({
      mcpUrl: "https://frazil-18790.on.ascii.dev/mcp",
      sandboxId: "bx_abc",
      token: "tok_secret",
      stop,
      pause,
    }))
    const handle = fakeHandle({ connect })

    const result = await attachSandbox({
      provider: "box",
      sandboxId: "bx_abc",
      config: { port: 18790 },
      resolveSandboxProvider: resolverFor(handle),
    })

    expect(connect).toHaveBeenCalledWith(
      "bx_abc",
      { provider: "box", config: { port: 18790 } },
      expect.objectContaining({ expose: "private" }),
    )
    expect(handle.provider.boot).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    expect(pause).not.toHaveBeenCalled()

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.descriptor).toEqual({
        provider: "box",
        sandboxId: "bx_abc",
        mcpUrl: "https://frazil-18790.on.ascii.dev/mcp",
        token: "tok_secret",
        allowOrigin: "https://frazil-18790.on.ascii.dev",
        keepAlive: false,
      })
    }
  })

  it("forwards keepAlive to connect() and echoes it on the descriptor", async () => {
    const connect = vi.fn(async (_id: string, _spec: SandboxSpec, _opts: SandboxBootOpts) => ({
      mcpUrl: "https://frazil-18790.on.ascii.dev/mcp",
      sandboxId: "bx_abc",
      token: "tok_secret",
      stop: async () => {},
    }))
    const handle = fakeHandle({ connect })

    const result = await attachSandbox({
      provider: "box",
      sandboxId: "bx_abc",
      keepAlive: true,
      resolveSandboxProvider: resolverFor(handle),
    })

    expect(connect).toHaveBeenCalledWith(
      "bx_abc",
      { provider: "box", config: {} },
      expect.objectContaining({ keepAlive: true }),
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.descriptor.keepAlive).toBe(true)
  })

  it("defaults config to {} when omitted", async () => {
    const connect = vi.fn(async () => ({
      mcpUrl: "https://frazil-18790.on.ascii.dev/mcp",
      sandboxId: "bx_abc",
      token: "tok_secret",
      stop: async () => {},
    }))
    const handle = fakeHandle({ connect })

    await attachSandbox({ provider: "box", sandboxId: "bx_abc", resolveSandboxProvider: resolverFor(handle) })

    expect(connect).toHaveBeenCalledWith(
      "bx_abc",
      { provider: "box", config: {} },
      expect.anything(),
    )
  })
})

// ── buildMcpConfigSnippet ────────────────────────────────────────────────

describe("buildMcpConfigSnippet", () => {
  it("includes an Authorization: Bearer header when the descriptor carries a token", () => {
    const snippet = buildMcpConfigSnippet({
      provider: "box",
      sandboxId: "bx_abc",
      mcpUrl: "https://frazil-18790.on.ascii.dev/mcp",
      token: "tok_secret",
      allowOrigin: "https://frazil-18790.on.ascii.dev",
      keepAlive: false,
    })
    const entry = snippet.mcpServers["sandbox-box-bx_abc"]!
    expect(entry.type).toBe("http")
    expect(entry.url).toBe("https://frazil-18790.on.ascii.dev/mcp")
    expect(entry.headers).toEqual({ Authorization: "Bearer tok_secret" })
  })

  it("omits headers entirely when there is no token", () => {
    const snippet = buildMcpConfigSnippet({
      provider: "local",
      sandboxId: "local-abc",
      mcpUrl: "http://127.0.0.1:18790/mcp",
      allowOrigin: "http://127.0.0.1:18790",
      keepAlive: false,
    })
    const entry = snippet.mcpServers["sandbox-local-local-abc"]!
    expect(entry.headers).toBeUndefined()
  })
})

// ── sandbox_attach tool ──────────────────────────────────────────────────

describe("sandbox_attach tool", () => {
  it("returns the descriptor + mcpConfig snippet as tool content on success", async () => {
    const handle = fakeHandle({})
    const { server, tools } = fakeServer()
    registerSandboxAttachTool(server, { resolveSandboxProvider: resolverFor(handle) })

    const tool = tools.find(t => t.name === "sandbox_attach")!
    const result = await tool.handler({ provider: "box", sandboxId: "bx_abc" })

    expect(result.isError).toBeUndefined()
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.descriptor.sandboxId).toBe("bx_abc")
    expect(payload.mcpConfig.mcpServers["sandbox-box-bx_abc"].headers.Authorization).toBe(
      "Bearer tok_secret",
    )
  })

  it("returns isError + the failure code/message when attach fails", async () => {
    const { server, tools } = fakeServer()
    registerSandboxAttachTool(server, { resolveSandboxProvider: resolverFor(null) })

    const tool = tools.find(t => t.name === "sandbox_attach")!
    const result = await tool.handler({ provider: "box", sandboxId: "bx_abc" })

    expect(result.isError).toBe(true)
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.code).toBe("sandbox_provider_not_found")
  })

  it("forwards keepAlive:true to attachSandbox and reflects it in the returned descriptor", async () => {
    const connect = vi.fn(async (_id: string, _spec: SandboxSpec, _opts: SandboxBootOpts) => ({
      mcpUrl: "https://frazil-18790.on.ascii.dev/mcp",
      sandboxId: "bx_abc",
      token: "tok_secret",
      stop: async () => {},
    }))
    const handle = fakeHandle({ connect })
    const { server, tools } = fakeServer()
    registerSandboxAttachTool(server, { resolveSandboxProvider: resolverFor(handle) })

    const tool = tools.find(t => t.name === "sandbox_attach")!
    const result = await tool.handler({ provider: "box", sandboxId: "bx_abc", keepAlive: true })

    expect(connect).toHaveBeenCalledWith(
      "bx_abc",
      { provider: "box", config: {} },
      expect.objectContaining({ keepAlive: true }),
    )
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload.descriptor.keepAlive).toBe(true)
  })
})
