import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { makeSetupLedger } from "@agentproto/adapter-kit"
import {
  TUNNEL_CATALOG,
  TUNNEL_FAMILY,
  makeTunnelCredsStore,
  makeTunnelLister,
  registerTunnelAdapterTools,
  toTunnelInfo,
  type TunnelAdapterInfo,
  type TunnelNamedCreds,
} from "../tunnel-adapters.js"
import type { AdapterEntry } from "@agentproto/adapter-kit"
import { quickTunnelProvider } from "../remote-providers/quick.js"
import { namedTunnelProvider } from "../remote-providers/named.js"

// ── fake McpServer that captures registered tools ──────────────────────────────

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

const SECRET_CREDS: TunnelNamedCreds = {
  hostname: "agent.example.com",
  tunnelId: "11111111-2222-3333-4444-555555555555",
  credentialsFile: "/super/secret/path.json",
}

// ── fixtures ───────────────────────────────────────────────────────────────────

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tunnel-adapters-"))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

// ── catalog / lister status integration ─────────────────────────────────────────

describe("tunnel catalog + lister", () => {
  it("classifies quick as ready and named as available when no creds exist", async () => {
    const credsStore = makeTunnelCredsStore(home)
    const ledger = makeSetupLedger({ home })
    const lister = makeTunnelLister({ credsStore, ledger })

    const entries = await lister()
    // Both catalog entries present, in catalog order.
    expect(entries.map(e => e.slug)).toEqual([
      "cloudflare-quick",
      "cloudflare-named",
    ])

    const quick = entries[0]!
    expect(quick.status).toBe("ready") // requiresSetup:false → ready
    expect(quick.version).toBe("builtin")
    expect(quick.info?.capabilities.requiresAuth).toBe(false)
    expect(quick.info?.capabilities.stableUrl).toBe(false)

    const named = entries[1]!
    expect(named.status).toBe("available") // requiresSetup + no creds
    expect(named.info?.capabilities.requiresAuth).toBe(true)
    expect(named.info?.capabilities.stableUrl).toBe(true)
  })

  it("promotes named to ready once creds are stored", async () => {
    const credsStore = makeTunnelCredsStore(home)
    const ledger = makeSetupLedger({ home })
    await credsStore.write("cloudflare-named", SECRET_CREDS)

    const lister = makeTunnelLister({ credsStore, ledger })
    const entries = await lister()
    const named = entries.find(e => e.slug === "cloudflare-named")!
    expect(named.status).toBe("ready")
  })

  it("never leaks cred values into the listed entries (toInfo is capabilities-only)", async () => {
    const credsStore = makeTunnelCredsStore(home)
    const ledger = makeSetupLedger({ home })
    await credsStore.write("cloudflare-named", SECRET_CREDS)

    const lister = makeTunnelLister({ credsStore, ledger })
    const entries = await lister()
    const blob = JSON.stringify(entries)
    expect(blob).not.toContain(SECRET_CREDS.tunnelId)
    expect(blob).not.toContain(SECRET_CREDS.hostname)
    expect(blob).not.toContain(SECRET_CREDS.credentialsFile)
  })

  it("toTunnelInfo carries only the capability set", () => {
    const info: TunnelAdapterInfo = toTunnelInfo(quickTunnelProvider())
    expect(Object.keys(info)).toEqual(["capabilities"])
  })

  it("providers satisfy the adapter-kit handle (slug/requiresSetup/check)", async () => {
    const quick = quickTunnelProvider()
    expect(quick.slug).toBe("cloudflare-quick")
    expect(quick.requiresSetup).toBe(false)
    expect(typeof quick.check).toBe("function")

    const named = namedTunnelProvider({ hostname: "h", tunnelId: "t" })
    expect(named.slug).toBe("cloudflare-named")
    expect(named.requiresSetup).toBe(true)
    // RemoteProvider lifecycle still intact (registry path).
    expect(named.id).toBe("named")
    expect(typeof named.start).toBe("function")
    expect(typeof named.stop).toBe("function")
  })
})

// ── list_tunnel_adapters tool ────────────────────────────────────────────────────

describe("list_tunnel_adapters tool", () => {
  it("registers a parameterless tool returning the status-classified catalog", async () => {
    const { server, tools } = fakeServer()
    registerTunnelAdapterTools(server, { home })

    const listTool = tools.find(t => t.name === "list_tunnel_adapters")!
    expect(listTool).toBeTruthy()
    expect(listTool.shape).toEqual({})

    const res = await listTool.handler({})
    expect(res.isError).toBeFalsy()
    const entries = JSON.parse(
      res.content[0]!.text,
    ) as AdapterEntry<TunnelAdapterInfo>[]
    expect(entries).toHaveLength(2)
    expect(entries.map(e => e.slug).sort()).toEqual([
      "cloudflare-named",
      "cloudflare-quick",
    ])
    for (const e of entries) {
      expect(typeof e.status).toBe("string")
      expect(e.info?.capabilities).toBeTruthy()
    }
  })
})

// ── setup_tunnel_provider tool ───────────────────────────────────────────────────

describe("setup_tunnel_provider tool", () => {
  function setupTool() {
    const { server, tools } = fakeServer()
    registerTunnelAdapterTools(server, { home })
    return tools.find(t => t.name === "setup_tunnel_provider")!
  }

  it("flags the value param as sensitive in its schema", () => {
    const tool = setupTool()
    const valueField = tool.shape["value"] as { description?: string }
    expect(valueField.description?.toLowerCase()).toContain("sensitive")
  })

  it("stores creds via the kit creds store and NEVER echoes the value", async () => {
    const tool = setupTool()
    const value = JSON.stringify(SECRET_CREDS)
    const res = await tool.handler({ slug: "cloudflare-named", value })

    // Response shape: { ok, slug, hint } — no value, no secret substring.
    expect(res.isError).toBeFalsy()
    const text = res.content[0]!.text
    expect(text).not.toContain(SECRET_CREDS.tunnelId)
    expect(text).not.toContain(value)
    const parsed = JSON.parse(text)
    expect(parsed.ok).toBe(true)
    expect(parsed.slug).toBe("cloudflare-named")
    expect(parsed).not.toHaveProperty("value")

    // Creds actually persisted via the kit store, under the tunnel family.
    const credFile = join(home, `${TUNNEL_FAMILY}-creds`, "cloudflare-named.json")
    expect(existsSync(credFile)).toBe(true)
    const store = makeTunnelCredsStore(home)
    expect(await store.read("cloudflare-named")).toEqual(SECRET_CREDS)
  })

  it("flips the adapter to ready after a successful setup", async () => {
    const tool = setupTool()
    await tool.handler({
      slug: "cloudflare-named",
      value: JSON.stringify(SECRET_CREDS),
    })

    const credsStore = makeTunnelCredsStore(home)
    const ledger = makeSetupLedger({ home })
    const entries = await makeTunnelLister({ credsStore, ledger })()
    expect(entries.find(e => e.slug === "cloudflare-named")!.status).toBe("ready")
    // Ledger record written too.
    expect(await ledger.exists("cloudflare-named")).toBe(true)
  })

  it("rejects malformed JSON without writing creds", async () => {
    const tool = setupTool()
    const res = await tool.handler({ slug: "cloudflare-named", value: "not-json" })
    expect(res.isError).toBe(true)
    const credFile = join(home, `${TUNNEL_FAMILY}-creds`, "cloudflare-named.json")
    expect(existsSync(credFile)).toBe(false)
  })

  it("rejects an unknown slug (only setup-requiring slugs are valid)", async () => {
    const tool = setupTool()
    const res = await tool.handler({ slug: "cloudflare-quick", value: "{}" })
    expect(res.isError).toBe(true)
  })

  it("catalog exposes exactly the two pilot providers", () => {
    expect(TUNNEL_CATALOG.map(c => c.slug)).toEqual([
      "cloudflare-quick",
      "cloudflare-named",
    ])
  })
})
