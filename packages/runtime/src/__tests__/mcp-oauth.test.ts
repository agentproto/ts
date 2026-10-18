/**
 * Generic OAuth for imported MCPs: a fake OAuth-protected MCP server
 * (RFC 9728 metadata, DCR, PKCE authorize/token with refresh, bearer-gated
 * /mcp) drives the real SDK `auth()` through `loginMcpOAuth`, then the
 * daemon path (`resolveImportConnection` → `openMcpClient`) reuses and
 * refreshes the stored state without ever starting a flow.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createHash, randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { openMcpClient } from "../mcp-client-pool.js"
import { setMcpCredentialDeps } from "../mcp-credential-deps.js"
import { resolveImportConnection } from "../mcp-import-resolve.js"
import { loadImportedMcps, saveImportedMcps, type ImportedMcpEntry } from "../mcp-imports.js"
import {
  loginMcpOAuth,
  mcpOAuthRef,
  McpOAuthLoginRequiredError,
  type McpOAuthSecretIO,
} from "../mcp-oauth.js"

interface FakeOAuthServer {
  url: string
  origin: string
  registrations: Array<Record<string, unknown>>
  authorizeScopes: string[]
  validAccess: Set<string>
  refreshTokens: Set<string>
  tokenGrants: string[]
  close(): Promise<void>
}

const body = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

const json = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(value))
}

async function startFakeOAuthMcp(): Promise<FakeOAuthServer> {
  const codes = new Map<string, { challenge: string; redirect: string }>()
  const state: FakeOAuthServer = {
    url: "",
    origin: "",
    registrations: [],
    authorizeScopes: [],
    validAccess: new Set(),
    refreshTokens: new Set(),
    tokenGrants: [],
    close: async () => {},
  }
  let n = 0
  const server: Server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", state.origin)
    if (u.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return json(res, 200, {
        resource: `${state.origin}/mcp`,
        authorization_servers: [state.origin],
        scopes_supported: ["accounts.read", "offline_access"],
      })
    }
    if (u.pathname === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: state.origin,
        authorization_endpoint: `${state.origin}/authorize`,
        token_endpoint: `${state.origin}/token`,
        registration_endpoint: `${state.origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      })
    }
    if (u.pathname === "/register" && req.method === "POST") {
      const reg = JSON.parse(await body(req)) as Record<string, unknown>
      state.registrations.push(reg)
      return json(res, 201, { ...reg, client_id: `client-${state.registrations.length}` })
    }
    if (u.pathname === "/authorize") {
      state.authorizeScopes.push(u.searchParams.get("scope") ?? "")
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
      const grant = form.get("grant_type") ?? ""
      state.tokenGrants.push(grant)
      if (grant === "authorization_code") {
        const rec = codes.get(form.get("code") ?? "")
        const verifier = form.get("code_verifier") ?? ""
        const ok =
          rec &&
          createHash("sha256").update(verifier).digest("base64url") === rec.challenge &&
          form.get("redirect_uri") === rec.redirect
        if (!ok) return json(res, 400, { error: "invalid_grant" })
        codes.delete(form.get("code") ?? "")
      } else if (grant === "refresh_token") {
        if (!state.refreshTokens.has(form.get("refresh_token") ?? "")) {
          return json(res, 400, { error: "invalid_grant" })
        }
      } else {
        return json(res, 400, { error: "unsupported_grant_type" })
      }
      const access = `at-${randomBytes(6).toString("hex")}`
      const refresh = `rt-${randomBytes(6).toString("hex")}`
      state.validAccess.add(access)
      state.refreshTokens.add(refresh)
      return json(res, 200, {
        access_token: access,
        token_type: "Bearer",
        refresh_token: refresh,
        expires_in: 3600,
        scope: "accounts.read offline_access",
      })
    }
    if (u.pathname === "/mcp") {
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1]
      if (!bearer || !state.validAccess.has(bearer)) {
        res
          .writeHead(401, {
            "www-authenticate": `Bearer resource_metadata="${state.origin}/.well-known/oauth-protected-resource/mcp"`,
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
  const port = (server.address() as AddressInfo).port
  state.origin = `http://127.0.0.1:${port}`
  state.url = `${state.origin}/mcp`
  state.close = () =>
    new Promise<void>(r => {
      server.closeAllConnections()
      server.close(() => r())
    })
  return state
}

function memoryIO(): McpOAuthSecretIO & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    read: async ref => data.get(ref),
    write: async (ref, value) => void data.set(ref, value),
  }
}

/** Follow the consent URL like a browser: authorize → 302 → loopback callback. */
const approve = async (url: URL): Promise<void> => {
  const r = await fetch(url, { redirect: "manual" })
  await fetch(r.headers.get("location")!)
}

function entryFor(server: FakeOAuthServer, over: Partial<ImportedMcpEntry> = {}): ImportedMcpEntry {
  return {
    id: "manual:cli:bank",
    alias: "bank",
    addedAt: "2026-01-01T00:00:00.000Z",
    snapshot: {
      id: "manual:cli:bank",
      source: "workspace",
      scope: "manual",
      name: "bank",
      type: "http",
      url: server.url,
    },
    resolve: "snapshot",
    auth: { type: "oauth" },
    ...over,
  }
}

describe("generic OAuth for imported MCPs", () => {
  let server: FakeOAuthServer
  let io: ReturnType<typeof memoryIO>

  beforeEach(async () => {
    server = await startFakeOAuthMcp()
    io = memoryIO()
    setMcpCredentialDeps({ resolveMcpSecret: io.read, storeMcpSecret: io.write })
  })
  afterEach(async () => {
    setMcpCredentialDeps({})
    await server.close()
  })

  const login = (scope?: string) =>
    loginMcpOAuth({
      importId: "manual:cli:bank",
      alias: "bank",
      serverUrl: server.url,
      ...(scope ? { scope } : {}),
      io,
      onAuthorizationUrl: approve,
      timeoutMs: 10_000,
    })

  it("logs in with DCR + PKCE, then the daemon path lists tools using the stored state", async () => {
    const res = await login()
    expect(res.grantedScope).toBe("accounts.read offline_access")
    expect(server.registrations).toHaveLength(1)
    expect(server.registrations[0]!.token_endpoint_auth_method).toBe("none")
    expect(server.authorizeScopes[0]).toContain("accounts.read")

    const { config } = await resolveImportConnection(entryFor(server), {
      resolveMcpSecret: io.read,
      storeMcpSecret: io.write,
    })
    expect(config.oauth).toEqual({ importId: "manual:cli:bank", alias: "bank" })
    const client = await openMcpClient(config, { label: 'import "bank"' })
    try {
      expect((await client.listTools()).tools.map(t => t.name)).toEqual(["list_accounts"])
    } finally {
      await client.close()
    }
  })

  it("works via explicit oauthSecrets even when the ambient credential store is empty — the regression this reproduces: @agentproto/runtime ships ./mcp-oauth, ./mcp-client-pool and ./mcp-credential-deps as separate tsup entries (splitting: false), so a consumer that imports them from DIFFERENT subpaths (as the CLI does) gets independent copies of mcp-credential-deps.ts's module state; a setMcpCredentialDeps() call made through one subpath is invisible to getMcpCredentialDeps() reached through another, and openMcpClient's ambient fallback then reports 'no keychain secret store is configured' even though the caller did configure one", async () => {
    await login()
    setMcpCredentialDeps({}) // simulates the cross-entry blind spot: ambient store looks empty here
    const { config } = await resolveImportConnection(entryFor(server), {
      resolveMcpSecret: io.read,
      storeMcpSecret: io.write,
    })
    await expect(openMcpClient(config, { label: 'import "bank"' })).rejects.toThrow(
      /no keychain secret store is configured/
    )
    const client = await openMcpClient(config, {
      label: 'import "bank"',
      oauthSecrets: { read: io.read, write: io.write },
    })
    try {
      expect((await client.listTools()).tools.map(t => t.name)).toEqual(["list_accounts"])
    } finally {
      await client.close()
    }
  })

  it("rejects a callback with a wrong state and still completes on the right one", async () => {
    let wrongStatus = 0
    await loginMcpOAuth({
      importId: "manual:cli:bank",
      alias: "bank",
      serverUrl: server.url,
      io,
      timeoutMs: 10_000,
      onAuthorizationUrl: async url => {
        const r = await fetch(url, { redirect: "manual" })
        const good = new URL(r.headers.get("location")!)
        const bad = new URL(good)
        bad.searchParams.set("state", "forged")
        wrongStatus = (await fetch(bad)).status
        await fetch(good)
      },
    })
    expect(wrongStatus).toBe(400)
  })

  it("requests an explicit scope when configured", async () => {
    await login("accounts.read")
    expect(server.authorizeScopes[0]).toBe("accounts.read")
  })

  it("refreshes silently when the access token was revoked", async () => {
    await login()
    server.validAccess.clear()
    const { config } = await resolveImportConnection(entryFor(server), {
      resolveMcpSecret: io.read,
      storeMcpSecret: io.write,
    })
    const client = await openMcpClient(config, { label: 'import "bank"' })
    try {
      expect((await client.listTools()).tools).toHaveLength(1)
    } finally {
      await client.close()
    }
    expect(server.tokenGrants).toEqual(["authorization_code", "refresh_token"])
    const stored = JSON.parse(io.data.get(mcpOAuthRef("manual:cli:bank"))!)
    expect(server.validAccess.has(stored.tokens.access_token)).toBe(true)
  })

  it("asks for a new login (never opens a flow) when the refresh token is dead", async () => {
    await login()
    server.validAccess.clear()
    server.refreshTokens.clear()
    const { config } = await resolveImportConnection(entryFor(server), {
      resolveMcpSecret: io.read,
      storeMcpSecret: io.write,
    })
    await expect(openMcpClient(config, { label: 'import "bank"' })).rejects.toThrow(
      /mcp login bank/
    )
  })

  it("reports login-required when nothing is stored", async () => {
    const { config } = await resolveImportConnection(entryFor(server), {
      resolveMcpSecret: io.read,
      storeMcpSecret: io.write,
    })
    await expect(openMcpClient(config, { label: 'import "bank"' })).rejects.toThrow(
      McpOAuthLoginRequiredError
    )
  })

  it("never presents stored credentials to another origin", async () => {
    await login()
    const other = await startFakeOAuthMcp()
    try {
      const { config } = await resolveImportConnection(
        entryFor(other, { id: "manual:cli:bank" }),
        { resolveMcpSecret: io.read, storeMcpSecret: io.write }
      )
      await expect(openMcpClient(config, { label: 'import "bank"' })).rejects.toThrow(
        /mcp login bank/
      )
      expect(other.tokenGrants).toEqual([])
    } finally {
      await other.close()
    }
  })

  it("keeps secrets out of imported-mcps.json (entry only carries auth.type/scope)", async () => {
    await login()
    const e = entryFor(server, { auth: { type: "oauth", scope: "accounts.read" } })
    const dir = await mkdtemp(join(tmpdir(), "mcp-oauth-"))
    const path = join(dir, "imported-mcps.json")
    await saveImportedMcps({ version: 1, imports: [e] }, path)
    const back = await loadImportedMcps(path)
    expect(back.imports[0]!.auth).toEqual({ type: "oauth", scope: "accounts.read" })
    const raw = await readFile(path, "utf8")
    const stored = JSON.parse(io.data.get(mcpOAuthRef(e.id))!)
    expect(raw).not.toContain(stored.tokens.access_token)
    expect(raw).not.toContain(stored.tokens.refresh_token)
  })
})
