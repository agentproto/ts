import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { discoverEndpoints, DiscoveryError } from "../discover.js"

/** Minimal Response stub for the two-hop fetch chain. */
function res(body: unknown, init?: { ok?: boolean; status?: number }) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: "",
    json: async () => body,
  } as unknown as Response
}

const API = "https://api.acme.example"
const AS = "https://auth.acme.example"

const PRM = {
  resource: API,
  resource_name: "ACME",
  authorization_servers: [AS],
}
const AS_META = {
  issuer: AS,
  token_endpoint: `${AS}/oauth2/token`,
  revocation_endpoint: `${AS}/oauth2/revoke`,
  grant_types_supported: ["authorization_code"],
  agent_auth: {
    identity_endpoint: `${API}/agent/identity`,
    claim_endpoint: `${API}/agent/identity/claim`,
    identity_types_supported: ["service_auth", "anonymous"],
  },
}

describe("discoverEndpoints", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubFetch(map: Record<string, () => Response>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const hit = map[url]
        if (!hit) throw new Error(`unexpected fetch: ${url}`)
        return hit()
      }),
    )
  }

  it("resolves the full two-hop chain", async () => {
    stubFetch({
      [`${API}/.well-known/oauth-protected-resource`]: () => res(PRM),
      [`${AS}/.well-known/oauth-authorization-server`]: () => res(AS_META),
    })

    const d = await discoverEndpoints(API)
    expect(d.resource).toBe(API)
    expect(d.resourceName).toBe("ACME")
    expect(d.authServerBase).toBe(AS)
    expect(d.tokenEndpoint).toBe(`${AS}/oauth2/token`)
    expect(d.revocationEndpoint).toBe(`${AS}/oauth2/revoke`)
    expect(d.identityEndpoint).toBe(`${API}/agent/identity`)
    expect(d.claimEndpoint).toBe(`${API}/agent/identity/claim`)
    expect(d.identityTypesSupported).toContain("service_auth")
    expect(d.grantTypesSupported).toContain("authorization_code")
  })

  it("tolerates a trailing slash on apiBase", async () => {
    stubFetch({
      [`${API}/.well-known/oauth-protected-resource`]: () => res(PRM),
      [`${AS}/.well-known/oauth-authorization-server`]: () => res(AS_META),
    })
    const d = await discoverEndpoints(`${API}/`)
    expect(d.tokenEndpoint).toBe(`${AS}/oauth2/token`)
  })

  it("throws DiscoveryError when PRM is not ok", async () => {
    stubFetch({
      [`${API}/.well-known/oauth-protected-resource`]: () =>
        res({}, { ok: false, status: 404 }),
    })
    await expect(discoverEndpoints(API)).rejects.toBeInstanceOf(DiscoveryError)
  })

  it("throws when PRM lacks authorization_servers", async () => {
    stubFetch({
      [`${API}/.well-known/oauth-protected-resource`]: () =>
        res({ resource: API }),
    })
    await expect(discoverEndpoints(API)).rejects.toThrow(
      /authorization_servers/,
    )
  })

  it("throws when AS metadata lacks token_endpoint", async () => {
    stubFetch({
      [`${API}/.well-known/oauth-protected-resource`]: () => res(PRM),
      [`${AS}/.well-known/oauth-authorization-server`]: () =>
        res({ agent_auth: { identity_endpoint: `${API}/agent/identity` } }),
    })
    await expect(discoverEndpoints(API)).rejects.toThrow(/token_endpoint/)
  })

  it("throws when AS metadata lacks agent_auth.identity_endpoint", async () => {
    stubFetch({
      [`${API}/.well-known/oauth-protected-resource`]: () => res(PRM),
      [`${AS}/.well-known/oauth-authorization-server`]: () =>
        res({ token_endpoint: `${AS}/oauth2/token` }),
    })
    await expect(discoverEndpoints(API)).rejects.toThrow(/identity_endpoint/)
  })

  it("defaults resource to apiBase and arrays to [] when omitted", async () => {
    stubFetch({
      [`${API}/.well-known/oauth-protected-resource`]: () =>
        res({ authorization_servers: [AS] }),
      [`${AS}/.well-known/oauth-authorization-server`]: () =>
        res({
          token_endpoint: `${AS}/oauth2/token`,
          agent_auth: { identity_endpoint: `${API}/agent/identity` },
        }),
    })
    const d = await discoverEndpoints(API)
    expect(d.resource).toBe(API)
    expect(d.identityTypesSupported).toEqual([])
    expect(d.grantTypesSupported).toEqual([])
    expect(d.claimEndpoint).toBeUndefined()
  })

  it("wraps a network failure as DiscoveryError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED")
      }),
    )
    await expect(discoverEndpoints(API)).rejects.toBeInstanceOf(DiscoveryError)
  })

  it("aborts a hung request after the timeout and wraps it", async () => {
    // A server that never responds — only the deadline signal ends the wait.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason ?? new Error("aborted")),
            )
          }),
      ),
    )
    await expect(
      discoverEndpoints(API, { timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(DiscoveryError)
  })

  it("aborts when the caller's signal fires", async () => {
    const ac = new AbortController()
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason ?? new Error("aborted")),
            )
          }),
      ),
    )
    const p = discoverEndpoints(API, { signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toBeInstanceOf(DiscoveryError)
  })
})
