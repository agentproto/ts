import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type {
  AuthProviderHandle,
  DiscoveredEndpoints,
  FlowRunOptions,
} from "../types.js"
import { MemoryStore } from "../store/memory-store.js"

// openBrowser shells out via execFile — no-op it so tests never spawn a browser.
vi.mock("node:child_process", () => ({
  execFile: (_c: string, _a: string[], cb: (e: unknown, r: unknown) => void) =>
    cb(null, { stdout: "" }),
}))

import { serviceAuthFlowEngine } from "../flow-engines/service-auth.js"

const API = "https://api.example"
const AS = "https://auth.example"
const IDENTITY = `${API}/agent/identity`
const TOKEN = `${AS}/oauth2/token`

const provider = {
  id: "guilde",
  description: "d",
  apiBase: API,
  auth: {
    flow: "service-auth",
    clientId: "agentproto-cli",
    tokenStore: { keychain: "bureau-guilde", account: "{server}" },
  },
} as AuthProviderHandle

const discovered = {
  identityEndpoint: IDENTITY,
  tokenEndpoint: TOKEN,
} as DiscoveredEndpoints

// Matches resolveStoreRef(config.tokenStore, server) for `provider` above.
const ref = { path: "bureau-guilde", account: API }

function jsonRes(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: "",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

function grantOf(init?: RequestInit): string | null {
  return new URLSearchParams(String(init?.body ?? "")).get("grant_type")
}

describe("serviceAuthFlowEngine", () => {
  let store: MemoryStore

  beforeEach(() => {
    store = new MemoryStore()
  })
  afterEach(() => vi.unstubAllGlobals())

  const opts = (extra?: Partial<FlowRunOptions>): FlowRunOptions => ({
    server: API,
    store,
    ...extra,
  })

  it("throws if invoked with a non-service-auth provider", async () => {
    const wrong = {
      ...provider,
      auth: { flow: "pat", tokenStore: { keychain: "k" } },
    } as AuthProviderHandle
    await expect(serviceAuthFlowEngine.run(wrong, null, opts())).rejects.toThrow(
      /invoked with flow="pat"/,
    )
  })

  it("exchanges the stored identity_assertion via jwt-bearer (no ceremony)", async () => {
    // The primary slot holds the identity_assertion JWT (AIP-50 storage model).
    await store.write(ref, { value: "assert-jwt", kind: "assertion" })
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe(TOKEN)
        expect(grantOf(init)).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer")
        return jsonRes({ access_token: "oat_from_assert" })
      }),
    )

    const r = await serviceAuthFlowEngine.run(provider, discovered, opts())
    expect(r).toEqual({ accessToken: "oat_from_assert", tokenKind: "oat" })
    // No refresh token is stored — the assertion stays put unless rotated.
    const stored = await store.read(ref)
    expect(stored).toEqual({ value: "assert-jwt", kind: "assertion" })
  })

  it("persists a rotated assertion returned by the exchange", async () => {
    await store.write(ref, { value: "assert-old", kind: "assertion" })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRes({ access_token: "oat_x", identity_assertion: "assert-new" }),
      ),
    )

    const r = await serviceAuthFlowEngine.run(provider, discovered, opts())
    expect(r.accessToken).toBe("oat_x")
    expect(r.identityAssertion).toBe("assert-new")
    const stored = await store.read(ref)
    expect(stored?.value).toBe("assert-new")
    expect(stored?.kind).toBe("assertion")
  })

  it("runs the full ceremony when forced and stores the assertion (not the token)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === IDENTITY) {
          return jsonRes({
            registration_id: "reg1",
            claim_token: "claim-tok",
            claim: {
              user_code: "ABCD-1234",
              verification_uri: "https://approve.example/x",
              expires_in: 300,
              interval: 0,
            },
          })
        }
        if (url === TOKEN) {
          expect(grantOf(init)).toBe("urn:workos:agent-auth:grant-type:claim")
          return jsonRes({
            access_token: "oat_fresh",
            token_type: "Bearer",
            identity_assertion: "assert-jwt",
            assertion_expires_in: 3600,
          })
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
    )

    const r = await serviceAuthFlowEngine.run(
      provider,
      discovered,
      opts({ force: true }),
    )

    expect(r.accessToken).toBe("oat_fresh")
    expect(r.identityAssertion).toBe("assert-jwt")
    expect(r.tokenKind).toBe("oat")
    expect(r.assertionExpires).toMatch(/^\d{4}-\d{2}-\d{2}T/) // ISO 8601

    // The assertion is stored — NOT the access token, NOT a refresh token.
    const stored = await store.read(ref)
    expect(stored?.value).toBe("assert-jwt")
    expect(stored?.kind).toBe("assertion")
    expect(stored?.expiresAt).toBe(r.assertionExpires)
  })

  it("falls through to a ceremony when the stored assertion is rejected", async () => {
    await store.write(ref, { value: "assert-expired", kind: "assertion" })
    let calls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls += 1
        // 1st: jwt-bearer exchange fails → triggers fall-through to a ceremony.
        if (grantOf(init) === "urn:ietf:params:oauth:grant-type:jwt-bearer") {
          return jsonRes({ error: "invalid_grant" })
        }
        if (url === IDENTITY) {
          return jsonRes({
            registration_id: "r",
            claim_token: "ct",
            claim: {
              user_code: "X",
              verification_uri: "https://approve.example/y",
              expires_in: 60,
              interval: 0,
            },
          })
        }
        return jsonRes({ access_token: "oat_after_fail", token_type: "Bearer" })
      }),
    )

    const r = await serviceAuthFlowEngine.run(provider, discovered, opts())
    expect(r.accessToken).toBe("oat_after_fail")
    expect(calls).toBeGreaterThanOrEqual(3)
  })

  it("rejects an insecure (non-HTTPS, non-loopback) endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn())
    await expect(
      serviceAuthFlowEngine.run(provider, null, opts({ server: "http://evil.example" })),
    ).rejects.toThrow(/requires HTTPS/)
  })

  it("defaults to a KeychainStore when opts.store is omitted", async () => {
    // Off macOS the Keychain backend fails loudly rather than silently — this
    // asserts the default wiring reaches KeychainStore without needing a real
    // Keychain in CI.
    if (process.platform === "darwin") return
    await expect(
      serviceAuthFlowEngine.run(provider, discovered, { server: API }),
    ).rejects.toThrow(/only supports macOS/)
  })
})
