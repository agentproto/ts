import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CredentialBroker, MemoryStore, resolveStoreRef } from "@agentproto/auth"
import {
  authProvidersPath,
  buildBrokerProvider,
  defaultTokenStore,
  loadAuthProviders,
  removeAuthProviderDef,
  setAuthProviderDef,
} from "../auth-providers-store.js"

// The store keys off homedir(); on POSIX that follows $HOME, so point it at a
// throwaway dir per test to keep the real ~/.agentproto untouched.
let prevHome: string | undefined
let home: string

beforeEach(async () => {
  prevHome = process.env.HOME
  home = await mkdtemp(join(tmpdir(), "apc-auth-store-"))
  process.env.HOME = home
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

describe("auth-providers-store round-trip", () => {
  it("set → load → rm, persisting only metadata (never the token)", async () => {
    expect((await loadAuthProviders()).providers).toEqual({})

    const path = await setAuthProviderDef(
      "agentpush",
      {
        apiBase: "https://api.agentpush.example",
        audience: "mcp",
        flow: "pat",
        description: "agentpush remote MCP",
        tokenStore: defaultTokenStore("agentpush"),
      },
      "2026-07-06T00:00:00.000Z",
    )
    expect(path).toBe(authProvidersPath())

    const loaded = await loadAuthProviders()
    expect(loaded.providers.agentpush).toMatchObject({
      apiBase: "https://api.agentpush.example",
      audience: "mcp",
      flow: "pat",
      updatedAt: "2026-07-06T00:00:00.000Z",
    })

    // The on-disk file holds only the def — never a StoredCredential. The
    // token's home is the keychain; no `"value"` field may appear here.
    const raw = await readFile(authProvidersPath(), "utf8")
    expect(raw).not.toMatch(/"value"\s*:/)

    expect(await removeAuthProviderDef("agentpush")).toBe(true)
    expect((await loadAuthProviders()).providers).toEqual({})
    expect(await removeAuthProviderDef("agentpush")).toBe(false)
  })

  it("malformed file loads as empty (never throws)", async () => {
    await setAuthProviderDef(
      "x",
      { apiBase: "https://x.example", audience: "mcp", flow: "pat", tokenStore: defaultTokenStore("x") },
      "2026-07-06T00:00:00.000Z",
    )
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(authProvidersPath(), "{ not json", "utf8"),
    )
    expect((await loadAuthProviders()).providers).toEqual({})
  })
})

describe("seed ⇄ broker-read correctness", () => {
  it("the broker resolves the exact key `auth cred set` writes (audience mcp)", async () => {
    const id = "agentpush"
    const provider = buildBrokerProvider(id, {
      apiBase: "https://api.agentpush.example",
      audience: "mcp",
      tokenStore: defaultTokenStore(id),
    })

    // Seed exactly as runCredSet does: same ref derivation, kind "pat".
    const store = new MemoryStore()
    const ref = resolveStoreRef(
      provider.auth.tokenStore,
      provider.apiBase,
      provider.audience,
    )
    await store.write(ref, { value: "apk_secret123", kind: "pat" })

    // Read exactly as serve.ts wires it: registry lookup + audience "mcp".
    const registry = new Map([[provider.id, provider]])
    const broker = new CredentialBroker({
      store,
      getProvider: (i) => registry.get(i),
    })
    const headers = await broker.resolveHeaders({ path: id, audience: "mcp" })
    expect(headers).toEqual({ Authorization: "Bearer apk_secret123" })
  })

  it("rejects an audience mismatch (defense-in-depth)", async () => {
    const provider = buildBrokerProvider("svc", {
      apiBase: "https://x.example",
      audience: "mcp",
      tokenStore: defaultTokenStore("svc"),
    })
    const registry = new Map([[provider.id, provider]])
    const broker = new CredentialBroker({
      store: new MemoryStore(),
      getProvider: (i) => registry.get(i),
    })
    await expect(
      broker.resolveHeaders({ path: "svc", audience: "api" }),
    ).rejects.toThrow(/audience/)
  })
})
