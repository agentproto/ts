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
  type TunnelProviderCreds,
} from "../tunnel-adapters.js"
import type { AdapterEntry } from "@agentproto/adapter-kit"
import { quickTunnelProvider } from "../remote-providers/quick.js"
import { namedTunnelProvider } from "../remote-providers/named.js"
import {
  ngrokTunnelProvider,
  NGROK_SLUG,
  type TunnelNgrokCreds,
} from "../remote-providers/ngrok.js"

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

// Stored as a plain string map (the generic creds-store shape). Still a valid
// named-tunnel cred set — TunnelNamedCreds is a typed view over the same keys.
const SECRET_CREDS: Record<string, string> = {
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
  it("classifies quick as ready, named as available (no creds), ngrok as available", async () => {
    const credsStore = makeTunnelCredsStore(home)
    const ledger = makeSetupLedger({ home })
    const lister = makeTunnelLister({ credsStore, ledger })

    const entries = await lister()
    // All three catalog entries present, in catalog order.
    expect(entries.map(e => e.slug)).toEqual([
      "cloudflare-quick",
      "cloudflare-named",
      "ngrok",
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

    const ngrok = entries[2]!
    expect(ngrok.status).toBe("available") // requiresSetup + no creds
    expect(ngrok.info?.capabilities.requiresAuth).toBe(true)
    expect(ngrok.info?.capabilities.hasApi).toBe(true)
    expect(ngrok.info?.capabilities.autostart).toBe(true)
    // stableUrl is false when no domain is configured (factory with no cfg).
    // When a domain IS configured, the instance-level override kicks in.
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
    await registerTunnelAdapterTools(server, { home })

    const listTool = tools.find(t => t.name === "list_tunnel_adapters")!
    expect(listTool).toBeTruthy()
    expect(listTool.shape).toEqual({})

    const res = await listTool.handler({})
    expect(res.isError).toBeFalsy()
    const entries = JSON.parse(
      res.content[0]!.text,
    ) as AdapterEntry<TunnelAdapterInfo>[]
    expect(entries).toHaveLength(3)
    expect(entries.map(e => e.slug).sort()).toEqual([
      "cloudflare-named",
      "cloudflare-quick",
      "ngrok",
    ])
    for (const e of entries) {
      expect(typeof e.status).toBe("string")
      expect(e.info?.capabilities).toBeTruthy()
    }
  })
})

// ── setup_tunnel_provider tool (multi-field form) ────────────────────────────────

describe("setup_tunnel_provider tool", () => {
  async function setupTool() {
    const { server, tools } = fakeServer()
    await registerTunnelAdapterTools(server, { home })
    return tools.find(t => t.name === "setup_tunnel_provider")!
  }

  it("schema exposes hostname, tunnelId, credentialsFile, authToken, domain fields — no single 'value'", async () => {
    const tool = await setupTool()
    const shapeKeys = Object.keys(tool.shape).sort()
    expect(shapeKeys).toEqual(
      [
        "authToken",
        "credentialsFile",
        "domain",
        "hostname",
        "slug",
        "tunnelId",
      ].sort(),
    )
    expect(tool.shape).not.toHaveProperty("value")
  })

  it("marks every cred field as sensitive in its schema annotation", async () => {
    const tool = await setupTool()
    const hostnameField = tool.shape["hostname"] as { description?: string }
    expect(hostnameField.description?.toLowerCase()).toContain("sensitive")

    const tunnelIdField = tool.shape["tunnelId"] as { description?: string }
    expect(tunnelIdField.description?.toLowerCase()).toContain("sensitive")

    const credsFileField = tool.shape["credentialsFile"] as { description?: string }
    expect(credsFileField.description?.toLowerCase()).toContain("sensitive")
  })

  it("stores creds via the kit creds store and NEVER echoes field values", async () => {
    const tool = await setupTool()
    const res = await tool.handler({
      slug: "cloudflare-named",
      hostname: SECRET_CREDS.hostname,
      tunnelId: SECRET_CREDS.tunnelId,
      credentialsFile: SECRET_CREDS.credentialsFile,
    })

    // Response shape: { ok, slug, hint } — no field values.
    expect(res.isError).toBeFalsy()
    const text = res.content[0]!.text

    // Never echo any secret value in the response.
    expect(text).not.toContain(SECRET_CREDS.tunnelId)
    expect(text).not.toContain(SECRET_CREDS.hostname)
    expect(text).not.toContain(SECRET_CREDS.credentialsFile)

    const parsed = JSON.parse(text)
    expect(parsed.ok).toBe(true)
    expect(parsed.slug).toBe("cloudflare-named")
    expect(parsed).not.toHaveProperty("value")
    expect(parsed).not.toHaveProperty("hostname")
    expect(parsed).not.toHaveProperty("tunnelId")
    expect(parsed).not.toHaveProperty("credentialsFile")

    // Creds actually persisted via the kit store, under the tunnel family.
    const credFile = join(home, `${TUNNEL_FAMILY}-creds`, "cloudflare-named.json")
    expect(existsSync(credFile)).toBe(true)
    const store = makeTunnelCredsStore(home)
    expect(await store.read("cloudflare-named")).toEqual(SECRET_CREDS)
  })

  it("flips the adapter to ready after a successful setup", async () => {
    const tool = await setupTool()
    await tool.handler({
      slug: "cloudflare-named",
      hostname: SECRET_CREDS.hostname,
      tunnelId: SECRET_CREDS.tunnelId,
    })

    const credsStore = makeTunnelCredsStore(home)
    const ledger = makeSetupLedger({ home })
    const entries = await makeTunnelLister({ credsStore, ledger })()
    expect(entries.find(e => e.slug === "cloudflare-named")!.status).toBe("ready")
    // Ledger record written too.
    expect(await ledger.exists("cloudflare-named")).toBe(true)
  })

  it("rejects setup when hostname is missing", async () => {
    const tool = await setupTool()
    const res = await tool.handler({
      slug: "cloudflare-named",
      hostname: "",
      tunnelId: "some-id",
    })
    expect(res.isError).toBe(true)
    const credFile = join(home, `${TUNNEL_FAMILY}-creds`, "cloudflare-named.json")
    expect(existsSync(credFile)).toBe(false)
  })

  it("rejects an unknown slug (only setup-requiring slugs are valid)", async () => {
    const tool = await setupTool()
    const res = await tool.handler({
      slug: "cloudflare-quick",
      hostname: "x",
      tunnelId: "y",
    })
    expect(res.isError).toBe(true)
  })

  it("catalog exposes exactly the three providers", () => {
    expect(TUNNEL_CATALOG.map(c => c.slug)).toEqual([
      "cloudflare-quick",
      "cloudflare-named",
      "ngrok",
    ])
  })
})

// ── ngrok provider: handle + check() logic ──────────────────────────────

describe("ngrok provider", () => {
  it("satisfies the adapter-kit handle shape (slug/requiresSetup/check/capabilities)", () => {
    const ngrok = ngrokTunnelProvider()
    expect(ngrok.slug).toBe("ngrok")
    expect(ngrok.requiresSetup).toBe(true)
    expect(typeof ngrok.check).toBe("function")
    // RemoteProvider lifecycle still intact.
    expect(ngrok.id).toBe("ngrok")
    expect(typeof ngrok.start).toBe("function")
    expect(typeof ngrok.stop).toBe("function")

    // Capabilities: no domain configured → stableUrl false.
    expect(ngrok.capabilities.stableUrl).toBe(false)
    expect(ngrok.capabilities.autostart).toBe(true)
    expect(ngrok.capabilities.customDomain).toBe(true)
    expect(ngrok.capabilities.requiresAuth).toBe(true)
    expect(ngrok.capabilities.hasApi).toBe(true)
  })

  it("stableUrl is true when a domain is provided", () => {
    const ngrok = ngrokTunnelProvider({
      authToken: "tok_deadbeef",
      domain: "myapp.ngrok.io",
    })
    expect(ngrok.capabilities.stableUrl).toBe(true)
  })

  it("stableUrl is false when domain is empty string", () => {
    const ngrok = ngrokTunnelProvider({
      authToken: "tok_deadbeef",
      domain: "",
    })
    expect(ngrok.capabilities.stableUrl).toBe(false)
  })

  it("check() returns true when binary is present AND authtoken is configured", async () => {
    const ngrok = ngrokTunnelProvider({
      authToken: "tok_123",
      probeBinary: async () => true,
    })
    expect(await ngrok.check()).toBe(true)
  })

  it("check() returns false when binary is missing (even with authtoken)", async () => {
    const ngrok = ngrokTunnelProvider({
      authToken: "tok_123",
      probeBinary: async () => false,
    })
    expect(await ngrok.check()).toBe(false)
  })

  it("check() returns false when creds are absent (descriptor-only handle)", async () => {
    // probeBinary injected so the test is deterministic — binary is "present"
    // but creds are absent, so check() returns false.
    const ngrok = ngrokTunnelProvider({
      probeBinary: async () => true,
    })
    expect(await ngrok.check()).toBe(false)
  })
})

// ── ngrok setup_tunnel_provider (multi-field) ───────────────────────────

describe("setup_tunnel_provider — ngrok", () => {
  async function setupTool() {
    const { server, tools } = fakeServer()
    await registerTunnelAdapterTools(server, { home })
    return tools.find(t => t.name === "setup_tunnel_provider")!
  }

  it("schema exposes slug + named fields + ngrok fields (authToken, domain)", async () => {
    const tool = await setupTool()
    const shapeKeys = Object.keys(tool.shape).sort()
    expect(shapeKeys).toEqual(
      [
        "slug",
        "authToken",
        "credentialsFile",
        "domain",
        "hostname",
        "tunnelId",
      ].sort(),
    )
    expect(tool.shape).not.toHaveProperty("value")
  })

  it("marks ngrok fields as sensitive", async () => {
    const tool = await setupTool()
    const authTokenField = tool.shape["authToken"] as { description?: string }
    expect(authTokenField.description?.toLowerCase()).toContain("sensitive")

    const domainField = tool.shape["domain"] as { description?: string }
    expect(domainField.description?.toLowerCase()).toContain("sensitive")
  })

  const NGOK_CREDS: TunnelNgrokCreds = {
    authToken: "tok_cafebabe123",
    domain: "mybot.ngrok.io",
  }

  it("stores ngrok creds and NEVER echoes values", async () => {
    const tool = await setupTool()
    const res = await tool.handler({
      slug: "ngrok",
      authToken: NGOK_CREDS.authToken,
      domain: NGOK_CREDS.domain!,
    })

    // Response shape: { ok, slug, hint } — no field values.
    expect(res.isError).toBeFalsy()
    const text = res.content[0]!.text

    // Never echo any secret value in the response.
    expect(text).not.toContain(NGOK_CREDS.authToken)
    expect(text).not.toContain(NGOK_CREDS.domain)

    const parsed = JSON.parse(text)
    expect(parsed.ok).toBe(true)
    expect(parsed.slug).toBe("ngrok")
    expect(parsed).not.toHaveProperty("authToken")
    expect(parsed).not.toHaveProperty("domain")

    // Creds actually persisted via the kit store.
    const credFile = join(home, `${TUNNEL_FAMILY}-creds`, "ngrok.json")
    expect(existsSync(credFile)).toBe(true)
    const store = makeTunnelCredsStore(home)
    const stored = (await store.read("ngrok")) as TunnelNgrokCreds | null
    expect(stored?.authToken).toBe(NGOK_CREDS.authToken)
    expect(stored?.domain).toBe(NGOK_CREDS.domain)
  })

  it("stores ngrok creds without optional domain", async () => {
    const tool = await setupTool()
    const res = await tool.handler({
      slug: "ngrok",
      authToken: "tok_minimal",
    })

    expect(res.isError).toBeFalsy()
    const parsed = JSON.parse(res.content[0]!.text)
    expect(parsed.ok).toBe(true)

    const store = makeTunnelCredsStore(home)
    const stored = (await store.read("ngrok")) as TunnelNgrokCreds | null
    expect(stored?.authToken).toBe("tok_minimal")
    expect(stored?.domain).toBeUndefined()
  })

  it("flips ngrok to ready after a successful setup", async () => {
    const tool = await setupTool()
    await tool.handler({
      slug: "ngrok",
      authToken: NGOK_CREDS.authToken,
    })

    const credsStore = makeTunnelCredsStore(home)
    const ledger = makeSetupLedger({ home })
    const entries = await makeTunnelLister({ credsStore, ledger })()
    expect(entries.find(e => e.slug === "ngrok")!.status).toBe("ready")
    // Ledger record written too.
    expect(await ledger.exists("ngrok")).toBe(true)
  })

  it("rejects ngrok setup when authToken is missing", async () => {
    const tool = await setupTool()
    const res = await tool.handler({
      slug: "ngrok",
      authToken: "",
    })
    expect(res.isError).toBe(true)
    const text = res.content[0]!.text
    expect(JSON.parse(text).hint).toContain("authToken")
    // No file written on failure.
    const credFile = join(home, `${TUNNEL_FAMILY}-creds`, "ngrok.json")
    expect(existsSync(credFile)).toBe(false)
  })

  it("promotes named promos work independently of ngrok (cross-slug isolation)", async () => {
    // Setup both and verify each is ready independently.
    const tool = await setupTool()
    await tool.handler({
      slug: "cloudflare-named",
      hostname: "agent.example.com",
      tunnelId: "11111111-2222-3333-4444-555555555555",
    })
    await tool.handler({
      slug: "ngrok",
      authToken: "tok_independent",
    })

    const credsStore = makeTunnelCredsStore(home)
    const ledger = makeSetupLedger({ home })
    const entries = await makeTunnelLister({ credsStore, ledger })()

    expect(entries.find(e => e.slug === "cloudflare-named")!.status).toBe("ready")
    expect(entries.find(e => e.slug === "ngrok")!.status).toBe("ready")
    expect(await credsStore.exists("cloudflare-named")).toBe(true)
    expect(await credsStore.exists("ngrok")).toBe(true)
  })

  it("rejects an unknown slug (not quick, not named, not ngrok)", async () => {
    const tool = await setupTool()
    const res = await tool.handler({
      slug: "unknown-provider",
      authToken: "x",
    })
    expect(res.isError).toBe(true)
  })
})
