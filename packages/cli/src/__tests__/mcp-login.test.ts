import { describe, expect, it } from "vitest"
import type { ImportedMcpsConfig } from "@agentproto/runtime/mcp-imports"
import { mcpLogin, mcpLogout } from "../commands/mcp.js"

const URL_RO = "https://mcp.example/multi-organization/mcp"

function harness(initial: ImportedMcpsConfig = { version: 1, imports: [] }) {
  let config = initial
  const secrets = new Map<string, string>()
  const calls: Array<Record<string, unknown>> = []
  return {
    get config() {
      return config
    },
    secrets,
    calls,
    deps: {
      load: async () => config,
      save: async (c: ImportedMcpsConfig) => void (config = c),
      io: {
        read: async (r: string) => secrets.get(r),
        write: async (r: string, v: string) => void secrets.set(r, v),
      },
      onAuthorizationUrl: () => {},
      verify: async () => ["list_accounts"],
      login: (async (o: Record<string, unknown>) => {
        calls.push(o)
        return { grantedScope: "a.read" }
      }) as never,
    },
  }
}

describe("mcp login / logout", () => {
  it("creates a manual http import from --url and marks it oauth", async () => {
    const h = harness()
    const r = await mcpLogin("qonto-ro", { url: URL_RO, scope: "a.read" }, h.deps)
    expect(r.created).toBe(true)
    expect(r.tools).toEqual(["list_accounts"])
    expect(r.grantedScope).toBe("a.read")
    const e = h.config.imports[0]!
    expect(e.id).toBe("manual:cli:qonto-ro")
    expect(e.snapshot.url).toBe(URL_RO)
    expect(e.auth).toEqual({ type: "oauth", scope: "a.read" })
    expect(e.resolve).toBe("snapshot")
    expect(h.calls[0]!.serverUrl).toBe(URL_RO)
  })

  it("unknown alias without --url fails and writes nothing", async () => {
    const h = harness()
    await expect(mcpLogin("nope", {}, h.deps)).rejects.toThrow(/--url/)
    expect(h.config.imports).toHaveLength(0)
  })

  it("does not persist the import when verification fails", async () => {
    const h = harness()
    h.deps.verify = async () => {
      throw new Error("401")
    }
    await expect(mcpLogin("x", { url: URL_RO }, h.deps)).rejects.toThrow("401")
    expect(h.config.imports).toHaveLength(0)
  })

  it("refuses to repoint an existing import and non-remote imports", async () => {
    const h = harness()
    await mcpLogin("x", { url: URL_RO }, h.deps)
    await expect(mcpLogin("x", { url: "https://evil.example/mcp" }, h.deps)).rejects.toThrow(
      /already points/
    )
    const stdio = harness({
      version: 1,
      imports: [
        {
          id: "s",
          alias: "s",
          addedAt: "2026-01-01T00:00:00.000Z",
          snapshot: { id: "s", source: "claude-code", scope: "global", name: "s", type: "stdio", command: "x" },
        },
      ],
    })
    await expect(mcpLogin("s", {}, stdio.deps)).rejects.toThrow(/not a remote/)
  })

  it("logout by id cleans the keychain even when the import is gone", async () => {
    const h = harness()
    h.secrets.set("agentproto/mcp-import/manual:cli:gone#oauth:state", "{}")
    await mcpLogout("manual:cli:gone", h.deps)
    expect(h.secrets.get("agentproto/mcp-import/manual:cli:gone#oauth:state")).toBe("")
  })

  it("logout clears the keychain slot", async () => {
    const h = harness()
    await mcpLogin("x", { url: URL_RO }, h.deps)
    h.secrets.set("agentproto/mcp-import/manual:cli:x#oauth:state", "{}")
    await mcpLogout("x", h.deps)
    expect(h.secrets.get("agentproto/mcp-import/manual:cli:x#oauth:state")).toBe("")
  })
})
