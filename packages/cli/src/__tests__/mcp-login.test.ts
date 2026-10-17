import { afterEach, describe, expect, it } from "vitest"
import { createHash, randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { openMcpClient } from "@agentproto/runtime/mcp-client-pool"
import type { ImportedMcpsConfig } from "@agentproto/runtime/mcp-imports"
import { loginMcpOAuth, type McpOAuthSecretIO } from "@agentproto/runtime/mcp-oauth"
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

/** Minimal OAuth-protected MCP (metadata, DCR, PKCE authorize/token,
 *  bearer-gated /mcp) — a standalone copy of the runtime package's fixture,
 *  kept local since the CLI package can't import runtime's test helpers. */
interface FakeOAuthServer {
  url: string
  close(): Promise<void>
}

async function startFakeOAuthMcp(): Promise<FakeOAuthServer> {
  const body = async (req: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    return Buffer.concat(chunks).toString("utf8")
  }
  const json = (res: ServerResponse, status: number, value: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value))
  }
  const codes = new Map<string, { challenge: string; redirect: string }>()
  const access = new Set<string>()
  let origin = ""
  let n = 0
  const server: Server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", origin)
    if (u.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return json(res, 200, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ["accounts.read"],
      })
    }
    if (u.pathname === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      })
    }
    if (u.pathname === "/register" && req.method === "POST") {
      const reg = JSON.parse(await body(req)) as Record<string, unknown>
      return json(res, 201, { ...reg, client_id: "client-1" })
    }
    if (u.pathname === "/authorize") {
      const code = `code-${++n}`
      codes.set(code, {
        challenge: u.searchParams.get("code_challenge") ?? "",
        redirect: u.searchParams.get("redirect_uri") ?? "",
      })
      const back = new URL(u.searchParams.get("redirect_uri") ?? "")
      back.searchParams.set("code", code)
      back.searchParams.set("state", u.searchParams.get("state") ?? "")
      res.writeHead(302, { location: back.toString() }).end()
      return
    }
    if (u.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await body(req))
      const rec = codes.get(form.get("code") ?? "")
      const ok =
        rec &&
        createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") ===
          rec.challenge &&
        form.get("redirect_uri") === rec.redirect
      if (!ok) return json(res, 400, { error: "invalid_grant" })
      const token = `at-${randomBytes(6).toString("hex")}`
      access.add(token)
      return json(res, 200, {
        access_token: token,
        token_type: "Bearer",
        refresh_token: `rt-${randomBytes(6).toString("hex")}`,
        expires_in: 3600,
        scope: "accounts.read",
      })
    }
    if (u.pathname === "/mcp") {
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1]
      if (!bearer || !access.has(bearer)) {
        res
          .writeHead(401, {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          })
          .end()
        return
      }
      const mcp = new McpServer({ name: "fake-bank", version: "0.0.0" })
      mcp.tool("list_accounts", "List accounts (read-only)", async () => ({
        content: [{ type: "text", text: "[]" }],
      }))
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on("close", () => {
        void transport.close()
        void mcp.close()
      })
      await mcp.connect(transport)
      await transport.handleRequest(req, res, JSON.parse((await body(req)) || "null"))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url: `${origin}/mcp`,
    close: () =>
      new Promise<void>(r => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}

function memoryIO(): McpOAuthSecretIO & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, read: async ref => data.get(ref), write: async (ref, v) => void data.set(ref, v) }
}

describe("mcp login / logout", () => {
  let fakeServer: FakeOAuthServer | undefined
  afterEach(async () => {
    await fakeServer?.close()
    fakeServer = undefined
  })

  it("logs in end to end against a real OAuth MCP: the callback is awaited, the token lands in the keychain, and verify never needs the ambient credential store", async () => {
    fakeServer = await startFakeOAuthMcp()
    const io = memoryIO()
    const config: ImportedMcpsConfig = { version: 1, imports: [] }
    const r = await mcpLogin(
      "qonto-ro",
      { url: fakeServer.url },
      {
        load: async () => config,
        save: async c => {
          config.imports = c.imports
        },
        io,
        login: loginMcpOAuth,
        onAuthorizationUrl: async url => {
          // Stand-in for Jeremy's click: follow the consent URL exactly
          // like a browser would (authorize → 302 → loopback callback).
          const r = await fetch(url, { redirect: "manual" })
          await fetch(r.headers.get("location")!)
        },
        verify: async entry => {
          // Mirrors the production `verify` in ../commands/mcp.ts: must
          // pass `oauthSecrets` explicitly, since `openMcpClient` lives in
          // a different tsup entry than wherever a global credential
          // store might have been set (the bug this test reproduces).
          const client = await openMcpClient(
            {
              type: entry.snapshot.type,
              url: entry.snapshot.url!,
              oauth: { importId: entry.id, alias: entry.alias },
            },
            { label: `import "${entry.alias}"`, oauthSecrets: io }
          )
          try {
            return (await client.listTools()).tools.map(t => t.name)
          } finally {
            await client.close().catch(() => {})
          }
        },
      }
    )
    expect(r.tools).toEqual(["list_accounts"])
    expect(r.entry.auth).toEqual({ type: "oauth" })
    const stored = JSON.parse(io.data.get("agentproto/mcp-import/manual:cli:qonto-ro#oauth:state")!)
    expect(stored.tokens.access_token).toMatch(/^at-/)
    expect(config.imports[0]!.id).toBe("manual:cli:qonto-ro")
  })


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
