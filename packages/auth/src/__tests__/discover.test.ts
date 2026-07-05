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

  it("requests with redirect:manual and treats a 3xx as a failure", async () => {
    let redirectMode: string | undefined
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        redirectMode = init?.redirect
        return res({}, { ok: false, status: 302 }) // a redirect, not followed
      }),
    )
    await expect(discoverEndpoints(API)).rejects.toBeInstanceOf(DiscoveryError)
    expect(redirectMode).toBe("manual")
  })

  it("rejects a non-HTTPS apiBase", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await expect(
      discoverEndpoints("http://insecure.example"),
    ).rejects.toBeInstanceOf(DiscoveryError)
    expect(fetchMock).not.toHaveBeenCalled() // guarded before any request
  })

  it("captures device_authorization_endpoint from AS metadata when present", async () => {
    stubFetch({
      [`${API}/.well-known/oauth-protected-resource`]: () => res(PRM),
      [`${AS}/.well-known/oauth-authorization-server`]: () =>
        res({ ...AS_META, device_authorization_endpoint: `${AS}/oauth2/device` }),
    })
    const d = await discoverEndpoints(API)
    expect(d.deviceAuthorizationEndpoint).toBe(`${AS}/oauth2/device`)
  })

  it("falls back to agentproto-host.json when the PRM chain fails", async () => {
    stubFetch({
      [`${API}/.well-known/oauth-protected-resource`]: () =>
        res({}, { ok: false, status: 404 }),
      [`${API}/.well-known/agentproto-host.json`]: () =>
        res({
          device_authorization_endpoint: `${API}/oauth/device`,
          token_endpoint: `${API}/oauth/token`,
        }),
    })
    const d = await discoverEndpoints(API)
    expect(d.tokenEndpoint).toBe(`${API}/oauth/token`)
    expect(d.deviceAuthorizationEndpoint).toBe(`${API}/oauth/device`)
    expect(d.authServerBase).toBe(API)
    expect(d.identityEndpoint).toBeUndefined()
  })

  it("surfaces the original PRM error when the host.json fallback also fails", async () => {
    stubFetch({
      [`${API}/.well-known/oauth-protected-resource`]: () =>
        res({ resource: API }), // missing authorization_servers
      // agentproto-host.json intentionally left unstubbed.
    })
    await expect(discoverEndpoints(API)).rejects.toThrow(/authorization_servers/)
  })

  it("surfaces the original PRM error when host.json is missing required fields", async () => {
    stubFetch({
      [`${API}/.well-known/oauth-protected-resource`]: () =>
        res({ resource: API }), // missing authorization_servers
      [`${API}/.well-known/agentproto-host.json`]: () =>
        res({ token_endpoint: `${API}/oauth/token` }), // no device_authorization_endpoint
    })
    await expect(discoverEndpoints(API)).rejects.toThrow(/authorization_servers/)
  })

  it("does not attempt the host.json fallback when the caller's signal is already aborted", async () => {
    const ac = new AbortController()
    const fetchMock = vi.fn(async () => {
      throw new Error("PRM down")
    })
    vi.stubGlobal("fetch", fetchMock)
    ac.abort()
    await expect(
      discoverEndpoints(API, { signal: ac.signal }),
    ).rejects.toBeInstanceOf(DiscoveryError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("allows loopback http for local development", async () => {
    const LOOPBACK = "http://127.0.0.1:8080"
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === `${LOOPBACK}/.well-known/oauth-protected-resource`)
          return res({ authorization_servers: [AS] })
        return res(AS_META)
      }),
    )
    const d = await discoverEndpoints(LOOPBACK)
    expect(d.tokenEndpoint).toBe(`${AS}/oauth2/token`)
  })
})
