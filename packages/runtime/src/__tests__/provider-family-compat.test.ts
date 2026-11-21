/**
 * Behavior pinned for sandbox and tunnels now that both sit on
 * `makeProviderFamily` with `legacySetup: true`. The pre-existing adapter
 * tests do not exercise these three paths, so flipping `legacySetup` to false
 * left them green; each test below fails in that case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  makeMemoryCredsStore,
  makeMemorySetupLedger,
  type CredsStore,
  type SetupLedger,
} from "@agentproto/provider-kit"
import {
  makeSandboxCredsStore,
  registerSandboxAdapterTools,
} from "../sandbox-adapters.js"
import { registerTunnelAdapterTools, setupTunnelProvider } from "../tunnel-adapters.js"
import type { SandboxProviderHandle } from "../sandbox-providers/types.js"

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { type: "text"; text: string }[]
  isError?: boolean
}>

function fakeServer(): { server: McpServer; tools: Map<string, Handler> } {
  const tools = new Map<string, Handler>()
  const server = {
    tool: (name: string, _d: string, _s: unknown, handler: Handler) => {
      tools.set(name, handler)
    },
  } as unknown as McpServer
  return { server, tools }
}

/** A sandbox handle whose first field omits `required` and has no `sensitive`. */
function configurableHandle(slug: string): SandboxProviderHandle {
  return {
    slug,
    name: slug,
    version: "1.0.0",
    description: "d",
    requiresSetup: true,
    capabilities: {
      networkEgress: true,
      mounts: false,
      lifecyclePause: false,
      readOnly: false,
      exec: false,
      sharedSessions: false,
    },
    setupFields: [
      { name: "token", description: "token, required omitted" },
      { name: "url", description: "url", required: false },
    ],
    provider: {} as SandboxProviderHandle["provider"],
    check: async () => true,
  }
}

describe("sandbox setup keeps its pre-factory semantics", () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "family-compat-"))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  async function setupTool() {
    const { server, tools } = fakeServer()
    await registerSandboxAdapterTools(server, {
      home,
      resolveSandboxProvider: async slug =>
        slug === "e2b" ? configurableHandle("e2b") : null,
    })
    return tools.get("setup_sandbox_provider")!
  }

  it("a field that omits `required` is optional, and the hint text is unchanged", async () => {
    const setup = await setupTool()
    const res = await setup({ slug: "e2b", token: "", url: "" })
    expect(res.isError).toBe(false)
    expect(JSON.parse(res.content[0]!.text)).toEqual({
      ok: true,
      slug: "e2b",
      hint: "e2b configured \u2014 status is now ready",
    })
  })

  it("re-setup replaces the stored creds instead of merging", async () => {
    const setup = await setupTool()
    await setup({ slug: "e2b", token: "tok-1", url: "https://one.invalid" })
    await setup({ slug: "e2b", token: "tok-2", url: "" })
    expect(await makeSandboxCredsStore(home).read("e2b")).toEqual({ token: "tok-2" })
  })
})

describe("tunnel setup keeps its pre-factory semantics", () => {
  function stores(over: {
    credsStore?: Partial<CredsStore<Record<string, string>>>
    ledger?: Partial<SetupLedger>
  } = {}) {
    const credsStore = {
      ...makeMemoryCredsStore<Record<string, string>>(),
      ...over.credsStore,
    } as CredsStore<Record<string, string>>
    const ledger = { ...makeMemorySetupLedger(), ...over.ledger } as SetupLedger
    return { credsStore, ledger }
  }

  it("re-setup replaces the stored creds instead of merging", async () => {
    const s = stores()
    const first = await setupTunnelProvider(
      "ngrok",
      { authToken: "tok-1", domain: "one.invalid" },
      s,
    )
    expect(first.ok).toBe(true)
    expect(first.hint).toBe("ngrok configured \u2014 status is now ready")
    await setupTunnelProvider("ngrok", { authToken: "tok-2", domain: "" }, s)
    expect(await s.credsStore.read("ngrok")).toEqual({ authToken: "tok-2" })
  })

  it("setup resolves the provider without reading the stored creds", async () => {
    const read = vi.fn(async () => ({ authToken: "stored" }))
    const s = stores({ credsStore: { read } })
    const res = await setupTunnelProvider("ngrok", { authToken: "tok-1" }, s)
    expect(res.ok).toBe(true)
    expect(read).not.toHaveBeenCalled()
  })

  it("a creds store failure propagates instead of becoming ok:false", async () => {
    const s = stores({
      credsStore: {
        write: async () => {
          throw new Error("disk full")
        },
      },
    })
    await expect(
      setupTunnelProvider("ngrok", { authToken: "tok-1" }, s),
    ).rejects.toThrow("disk full")
  })

  it("a ledger failure propagates instead of becoming ok:false", async () => {
    const s = stores({
      ledger: {
        write: async () => {
          throw new Error("ledger down")
        },
      },
    })
    await expect(
      setupTunnelProvider("ngrok", { authToken: "tok-1" }, s),
    ).rejects.toThrow("ledger down")
  })
})

describe("tunnel setup tool schema ignores stored creds", () => {
  it("a corrupt creds file does not hide a provider from setup_tunnel_provider", async () => {
    const home = mkdtempSync(join(tmpdir(), "family-compat-"))
    try {
      mkdirSync(join(home, "tunnel-creds"), { recursive: true })
      writeFileSync(join(home, "tunnel-creds", "ngrok.json"), "{not json")
      const { server, tools } = fakeServer()
      await registerTunnelAdapterTools(server, { home })
      const res = await tools.get("setup_tunnel_provider")!({ slug: "ngrok", authToken: "" })
      expect(res.content[0]!.text).not.toContain("unknown slug")
      expect(res.content[0]!.text).toContain("missing required field(s): authToken")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
