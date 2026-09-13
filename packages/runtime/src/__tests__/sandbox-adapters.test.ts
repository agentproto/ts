import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { makeSetupLedger, type AdapterEntry } from "@agentproto/provider-kit"
import {
  SANDBOX_CATALOG,
  SANDBOX_FAMILY,
  makeSandboxCredsStore,
  makeSandboxLister,
  makeSandboxResolver,
  registerSandboxAdapterTools,
  toSandboxInfo,
  type SandboxAdapterInfo,
} from "../sandbox-adapters.js"
import { resolveSandboxProvider } from "../sandbox-providers/registry.js"
import { localSandboxProvider } from "../sandbox-providers/local.js"

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

/** Fake e2b module shape — same export the real `@agentproto/sandbox-e2b` uses. */
function fakeE2bModule(): Record<string, unknown> {
  return {
    e2bSandboxProvider: {
      boot: async () => ({
        mcpUrl: "https://fake/mcp",
        sandboxId: "sbx_fake",
        stop: async () => {},
      }),
    },
  }
}

const E2B_CREDS = { apiKey: "e2b_test_key" }

// ── fixtures ─────────────────────────────────────────────────────────────

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sandbox-adapters-"))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

// ── catalog ──────────────────────────────────────────────────────────────

describe("sandbox catalog", () => {
  it("exposes local, e2b, box, modal, daytona in order", () => {
    expect(SANDBOX_CATALOG.map((c) => c.slug)).toEqual([
      "local",
      "e2b",
      "box",
      "modal",
      "daytona",
    ])
  })
})

// ── resolver ─────────────────────────────────────────────────────────────

describe("resolveSandboxProvider", () => {
  it("resolves the built-in local provider without any import", async () => {
    const handle = await resolveSandboxProvider("local")
    expect(handle?.slug).toBe("local")
    expect(handle?.requiresSetup).toBe(false)
    expect(handle?.provider).toBe(localSandboxProvider)
  })

  it("returns null for e2b when the package isn't importable", async () => {
    const handle = await resolveSandboxProvider("e2b", {
      importPackage: async () => {
        throw new Error("Cannot find module '@agentproto/sandbox-e2b'")
      },
    })
    expect(handle).toBeNull()
  })

  it("resolves e2b when the package is importable, wrapping the bare SandboxProvider", async () => {
    const handle = await resolveSandboxProvider("e2b", {
      creds: E2B_CREDS,
      importPackage: async () => fakeE2bModule(),
    })
    expect(handle?.slug).toBe("e2b")
    expect(handle?.requiresSetup).toBe(true)
    expect(handle?.setupFields?.map((f) => f.name)).toEqual(["apiKey"])
    expect(typeof handle?.provider.boot).toBe("function")
  })

  it("fills the provider's control-plane env var from the stored apiKey cred when unset (so setup actually authenticates boot)", async () => {
    const saved = process.env.E2B_API_KEY
    delete process.env.E2B_API_KEY
    try {
      await resolveSandboxProvider("e2b", {
        creds: E2B_CREDS,
        importPackage: async () => fakeE2bModule(),
      })
      expect(process.env.E2B_API_KEY).toBe(E2B_CREDS.apiKey)
    } finally {
      if (saved === undefined) delete process.env.E2B_API_KEY
      else process.env.E2B_API_KEY = saved
    }
  })

  it("never overwrites an explicit control-plane env var with the stored cred (env wins)", async () => {
    const saved = process.env.E2B_API_KEY
    process.env.E2B_API_KEY = "from_env_wins"
    try {
      await resolveSandboxProvider("e2b", {
        creds: E2B_CREDS,
        importPackage: async () => fakeE2bModule(),
      })
      expect(process.env.E2B_API_KEY).toBe("from_env_wins")
    } finally {
      if (saved === undefined) delete process.env.E2B_API_KEY
      else process.env.E2B_API_KEY = saved
    }
  })

  it("returns null for modal/daytona (no package published yet)", async () => {
    expect(await resolveSandboxProvider("modal")).toBeNull()
    expect(await resolveSandboxProvider("daytona")).toBeNull()
  })

  it("returns null for an unknown slug", async () => {
    expect(await resolveSandboxProvider("does-not-exist")).toBeNull()
  })
})

// ── lister: status classification ───────────────────────────────────────

describe("sandbox lister", () => {
  it("classifies local as ready, e2b/box/modal/daytona as supported when none are importable", async () => {
    const credsStore = makeSandboxCredsStore(home)
    const ledger = makeSetupLedger({ home })
    const resolver = makeSandboxResolver(credsStore, {
      importPackage: async () => {
        throw new Error("not installed")
      },
    })
    const lister = makeSandboxLister({ credsStore, ledger, resolver })

    const entries = await lister()
    expect(entries.map((e) => e.slug)).toEqual([
      "local",
      "e2b",
      "box",
      "modal",
      "daytona",
    ])

    const local = entries[0]!
    expect(local.status).toBe("ready")
    expect(local.info?.capabilities.networkEgress).toBe(true)

    for (const slug of ["e2b", "box", "modal", "daytona"]) {
      const entry = entries.find((e) => e.slug === slug)!
      expect(entry.status).toBe("supported")
      expect(entry.version).toBe("not installed")
      expect(entry.info).toBeUndefined()
    }
  })

  it("classifies e2b as available (no creds) once the package is importable", async () => {
    const credsStore = makeSandboxCredsStore(home)
    const ledger = makeSetupLedger({ home })
    const resolver = makeSandboxResolver(credsStore, {
      importPackage: async () => fakeE2bModule(),
    })
    const lister = makeSandboxLister({ credsStore, ledger, resolver })

    const entries = await lister()
    const e2b = entries.find((e) => e.slug === "e2b")!
    expect(e2b.status).toBe("available")
    expect(e2b.info?.capabilities).toBeTruthy()
  })

  it("classifies e2b as ready once creds are stored", async () => {
    const credsStore = makeSandboxCredsStore(home)
    const ledger = makeSetupLedger({ home })
    await credsStore.write("e2b", E2B_CREDS)

    const resolver = makeSandboxResolver(credsStore, {
      importPackage: async () => fakeE2bModule(),
    })
    const lister = makeSandboxLister({ credsStore, ledger, resolver })

    const entries = await lister()
    const e2b = entries.find((e) => e.slug === "e2b")!
    expect(e2b.status).toBe("ready")
  })

  it("never leaks cred values into the listed entries (toInfo is capabilities-only)", async () => {
    const credsStore = makeSandboxCredsStore(home)
    const ledger = makeSetupLedger({ home })
    await credsStore.write("e2b", E2B_CREDS)

    const resolver = makeSandboxResolver(credsStore, {
      importPackage: async () => fakeE2bModule(),
    })
    const entries = await makeSandboxLister({ credsStore, ledger, resolver })()
    const blob = JSON.stringify(entries)
    expect(blob).not.toContain(E2B_CREDS.apiKey)
  })

  it("toSandboxInfo carries only the capability set", async () => {
    const handle = await resolveSandboxProvider("local")
    const info = toSandboxInfo(handle!)
    expect(Object.keys(info)).toEqual(["capabilities"])
  })
})

// ── list_sandbox_providers tool ─────────────────────────────────────────

describe("list_sandbox_providers tool", () => {
  it("registers a parameterless tool returning the status-classified catalog", async () => {
    const { server, tools } = fakeServer()
    await registerSandboxAdapterTools(server, {
      home,
      resolveSandboxProvider: makeSandboxResolver(makeSandboxCredsStore(home), {
        importPackage: async () => fakeE2bModule(),
      }),
    })

    const listTool = tools.find((t) => t.name === "list_sandbox_providers")!
    expect(listTool).toBeTruthy()
    expect(listTool.shape).toEqual({})

    const res = await listTool.handler({})
    expect(res.isError).toBeFalsy()
    const entries = JSON.parse(
      res.content[0]!.text,
    ) as AdapterEntry<SandboxAdapterInfo>[]
    expect(entries).toHaveLength(5)
    expect(entries.map((e) => e.slug).sort()).toEqual([
      "box",
      "daytona",
      "e2b",
      "local",
      "modal",
    ])
  })
})

// ── setup_sandbox_provider tool (multi-field form) ──────────────────────

describe("setup_sandbox_provider tool", () => {
  async function setupTool() {
    const { server, tools } = fakeServer()
    await registerSandboxAdapterTools(server, {
      home,
      resolveSandboxProvider: makeSandboxResolver(makeSandboxCredsStore(home), {
        importPackage: async () => fakeE2bModule(),
      }),
    })
    return tools.find((t) => t.name === "setup_sandbox_provider")!
  }

  it("schema exposes slug + apiKey — no single 'value'", async () => {
    const tool = await setupTool()
    const shapeKeys = Object.keys(tool.shape).sort()
    expect(shapeKeys).toEqual(["apiKey", "slug"])
    expect(tool.shape).not.toHaveProperty("value")
  })

  it("marks apiKey as sensitive in its schema annotation", async () => {
    const tool = await setupTool()
    const apiKeyField = tool.shape["apiKey"] as { description?: string }
    expect(apiKeyField.description?.toLowerCase()).toContain("sensitive")
  })

  it("writes creds via the kit creds store and marks the ledger, without echoing the value", async () => {
    const tool = await setupTool()
    const res = await tool.handler({ slug: "e2b", apiKey: E2B_CREDS.apiKey })

    expect(res.isError).toBeFalsy()
    const text = res.content[0]!.text
    expect(text).not.toContain(E2B_CREDS.apiKey)

    const parsed = JSON.parse(text)
    expect(parsed.ok).toBe(true)
    expect(parsed.slug).toBe("e2b")
    expect(parsed).not.toHaveProperty("apiKey")

    const credFile = join(home, `${SANDBOX_FAMILY}-creds`, "e2b.json")
    expect(existsSync(credFile)).toBe(true)
    const store = makeSandboxCredsStore(home)
    expect(await store.read("e2b")).toEqual(E2B_CREDS)

    const ledger = makeSetupLedger({ home })
    expect(await ledger.exists("e2b")).toBe(true)
  })

  it("flips e2b to ready after a successful setup", async () => {
    const tool = await setupTool()
    await tool.handler({ slug: "e2b", apiKey: E2B_CREDS.apiKey })

    const credsStore = makeSandboxCredsStore(home)
    const ledger = makeSetupLedger({ home })
    const resolver = makeSandboxResolver(credsStore, {
      importPackage: async () => fakeE2bModule(),
    })
    const entries = await makeSandboxLister({ credsStore, ledger, resolver })()
    expect(entries.find((e) => e.slug === "e2b")!.status).toBe("ready")
  })

  it("rejects setup when apiKey is missing", async () => {
    const tool = await setupTool()
    const res = await tool.handler({ slug: "e2b", apiKey: "" })
    expect(res.isError).toBe(true)
    const credFile = join(home, `${SANDBOX_FAMILY}-creds`, "e2b.json")
    expect(existsSync(credFile)).toBe(false)
  })

  it("rejects an unconfigurable slug (local needs no setup)", async () => {
    const tool = await setupTool()
    const res = await tool.handler({ slug: "local", apiKey: "x" })
    expect(res.isError).toBe(true)
  })

  it("rejects an unknown slug", async () => {
    const tool = await setupTool()
    const res = await tool.handler({ slug: "unknown-provider", apiKey: "x" })
    expect(res.isError).toBe(true)
  })
})
