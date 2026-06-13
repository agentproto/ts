import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type {
  AuthProviderHandle,
  DiscoveredEndpoints,
  FlowRunOptions,
} from "../types.js"

const { readKeychainToken, writeKeychainToken } = vi.hoisted(() => ({
  readKeychainToken: vi.fn(),
  writeKeychainToken: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("../token-store.js", () => ({
  readKeychainToken,
  writeKeychainToken,
  resolveAccount: (acct: string | undefined, server: string) =>
    acct ? acct.replace("{server}", server) : server,
}))
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

const opts: FlowRunOptions = { server: API }

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
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.unstubAllGlobals())

  it("throws if invoked with a non-service-auth provider", async () => {
    const wrong = {
      ...provider,
      auth: { flow: "pat", tokenStore: { keychain: "k" } },
    } as AuthProviderHandle
    await expect(serviceAuthFlowEngine.run(wrong, null, opts)).rejects.toThrow(
      /invoked with flow="pat"/,
    )
  })

  it("returns a cached non-ort token as-is without any network call", async () => {
    readKeychainToken.mockResolvedValue("gld_legacy")
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const r = await serviceAuthFlowEngine.run(provider, discovered, opts)
    expect(r).toEqual({ accessToken: "gld_legacy", tokenKind: "oat" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("exchanges a cached ort_* refresh token for a fresh oat_* and rotates it", async () => {
    readKeychainToken.mockResolvedValue("ort_old")
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        expect(grantOf(init)).toBe("refresh_token")
        return jsonRes({ access_token: "oat_new", refresh_token: "ort_new" })
      }),
    )

    const r = await serviceAuthFlowEngine.run(provider, discovered, opts)
    expect(r).toEqual({ accessToken: "oat_new", tokenKind: "oat" })
    // Rotated refresh token persisted to the primary slot.
    expect(writeKeychainToken).toHaveBeenCalledWith(
      "bureau-guilde",
      API,
      "ort_new",
    )
  })

  it("runs the full claim ceremony when forced, storing ort_* + assertion", async () => {
    readKeychainToken.mockResolvedValue(undefined)
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
          expect(grantOf(init)).toBe(
            "urn:workos:agent-auth:grant-type:claim",
          )
          return jsonRes({
            access_token: "oat_fresh",
            token_type: "Bearer",
            refresh_token: "ort_fresh",
            identity_assertion: "assert-jwt",
            assertion_expires_in: 3600,
          })
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
    )

    const r = await serviceAuthFlowEngine.run(provider, discovered, {
      ...opts,
      force: true,
    })

    expect(r.accessToken).toBe("oat_fresh")
    expect(r.identityAssertion).toBe("assert-jwt")
    expect(r.tokenKind).toBe("oat")
    expect(r.assertionExpires).toMatch(/^\d{4}-\d{2}-\d{2}T/) // ISO 8601

    // Primary slot holds the rotating refresh token; assertion in -assertion slot.
    expect(writeKeychainToken).toHaveBeenCalledWith(
      "bureau-guilde",
      API,
      "ort_fresh",
    )
    expect(writeKeychainToken).toHaveBeenCalledWith(
      "bureau-guilde-assertion",
      API,
      "assert-jwt",
    )
  })

  it("exchanges a stored assertion via jwt-bearer when the primary slot is empty", async () => {
    // Primary slot empty; the -assertion slot holds a prior ceremony's JWT.
    readKeychainToken.mockImplementation(async (service: string) =>
      service === "bureau-guilde-assertion" ? "assert-jwt" : undefined,
    )
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        expect(grantOf(init)).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer")
        return jsonRes({ access_token: "oat_from_assert", refresh_token: "ort_x" })
      }),
    )

    const r = await serviceAuthFlowEngine.run(provider, discovered, opts)
    expect(r).toEqual({ accessToken: "oat_from_assert", tokenKind: "oat" })
    // A rotated refresh token from the exchange is persisted to the primary slot.
    expect(writeKeychainToken).toHaveBeenCalledWith("bureau-guilde", API, "ort_x")
  })

  it("falls through to a full ceremony when both refresh and assertion fail", async () => {
    // ort_* in the primary slot, but no usable assertion in the -assertion slot.
    readKeychainToken.mockImplementation(async (service: string) =>
      service === "bureau-guilde" ? "ort_stale" : undefined,
    )
    let calls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls += 1
        // 1st: refresh attempt fails → triggers fall-through.
        if (grantOf(init) === "refresh_token") {
          return jsonRes({ error: "invalid_grant" })
        }
        // No assertion is cached, so no jwt-bearer exchange is attempted.
        // 2nd: ceremony identity request.
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
        // 3rd: claim poll succeeds.
        return jsonRes({ access_token: "oat_after_fail", token_type: "Bearer" })
      }),
    )

    const r = await serviceAuthFlowEngine.run(provider, discovered, opts)
    expect(r.accessToken).toBe("oat_after_fail")
    expect(calls).toBeGreaterThanOrEqual(3)
  })
})
