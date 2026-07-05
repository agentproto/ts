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

import { deviceCodeFlowEngine } from "../flow-engines/device-code.js"

const API = "https://api.example"
const AS = "https://auth.example"
const DEVICE_AUTH = `${API}/oauth/device`
const TOKEN = `${AS}/oauth2/token`

const provider = {
  id: "acme-daemon",
  description: "d",
  apiBase: API,
  auth: {
    flow: "device-code",
    clientId: "agentproto-cli",
    tokenStore: { keychain: "acme-daemon", account: "{server}" },
  },
} as AuthProviderHandle

const discovered = {
  deviceAuthorizationEndpoint: DEVICE_AUTH,
  tokenEndpoint: TOKEN,
} as DiscoveredEndpoints

// Matches resolveStoreRef(config.tokenStore, server) for `provider` above.
const ref = { path: "acme-daemon", account: API }

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

describe("deviceCodeFlowEngine", () => {
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

  it("throws if invoked with a non-device-code provider", async () => {
    const wrong = {
      ...provider,
      auth: { flow: "pat", tokenStore: { keychain: "k" } },
    } as AuthProviderHandle
    await expect(deviceCodeFlowEngine.run(wrong, null, opts())).rejects.toThrow(
      /invoked with flow="pat"/,
    )
  })

  it("runs the full ceremony and persists a daemon credential", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === DEVICE_AUTH) {
          expect(new URLSearchParams(String(init?.body)).get("client_id")).toBe(
            "agentproto-cli",
          )
          return jsonRes({
            device_code: "dc-1",
            user_code: "ABCD-1234",
            verification_uri: "https://approve.example/x",
            verification_uri_complete:
              "https://approve.example/x?code=ABCD-1234",
            expires_in: 300,
            interval: 0,
          })
        }
        if (url === TOKEN) {
          expect(grantOf(init)).toBe(
            "urn:ietf:params:oauth:grant-type:device_code",
          )
          return jsonRes({
            access_token: "gdt_fresh",
            token_type: "Bearer",
            refresh_token: "gdr_fresh",
            expires_in: 3600,
            scope: "cli",
            subject: "user-1",
            revocation_id: "rev-1",
          })
        }
        throw new Error(`unexpected fetch ${url}`)
      }),
    )

    const r = await deviceCodeFlowEngine.run(provider, discovered, opts())

    expect(r.accessToken).toBe("gdt_fresh")
    expect(r.tokenKind).toBe("daemon")
    expect(r.refreshToken).toBe("gdr_fresh")
    expect(r.scope).toBe("cli")
    expect(r.subject).toBe("user-1")
    expect(r.revocationId).toBe("rev-1")

    const stored = await store.read(ref)
    expect(stored?.value).toBe("gdt_fresh")
    expect(stored?.kind).toBe("daemon")
    expect(stored?.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(stored?.metadata).toMatchObject({
      refreshToken: "gdr_fresh",
      scope: "cli",
      subject: "user-1",
      revocationId: "rev-1",
    })
  })

  it("short-circuits the ceremony when a fresh credential is cached", async () => {
    await store.write(ref, {
      value: "gdt_cached",
      kind: "daemon",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      metadata: { refreshToken: "gdr_cached", scope: "cli" },
    })
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const r = await deviceCodeFlowEngine.run(provider, discovered, opts())

    expect(r).toEqual({
      accessToken: "gdt_cached",
      tokenKind: "daemon",
      refreshToken: "gdr_cached",
      scope: "cli",
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("returns a cached credential with no expiry without running a ceremony", async () => {
    await store.write(ref, { value: "gdt_no_expiry", kind: "daemon" })
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const r = await deviceCodeFlowEngine.run(provider, discovered, opts())

    expect(r).toEqual({ accessToken: "gdt_no_expiry", tokenKind: "daemon" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("refreshes an expired credential via grant_type=refresh_token", async () => {
    await store.write(ref, {
      value: "gdt_old",
      kind: "daemon",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      metadata: { refreshToken: "gdr_old", scope: "cli", subject: "user-1" },
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe(TOKEN)
        expect(grantOf(init)).toBe("refresh_token")
        expect(
          new URLSearchParams(String(init?.body)).get("refresh_token"),
        ).toBe("gdr_old")
        return jsonRes({ access_token: "gdt_refreshed", expires_in: 3600 })
      }),
    )

    const r = await deviceCodeFlowEngine.run(provider, discovered, opts())

    expect(r.accessToken).toBe("gdt_refreshed")
    expect(r.tokenKind).toBe("daemon")
    // The AS didn't rotate refresh_token/scope/subject — carried forward from
    // the previously stored metadata rather than dropped.
    expect(r.refreshToken).toBe("gdr_old")
    expect(r.scope).toBe("cli")
    expect(r.subject).toBe("user-1")

    const stored = await store.read(ref)
    expect(stored?.value).toBe("gdt_refreshed")
    expect(stored?.metadata).toMatchObject({
      refreshToken: "gdr_old",
      scope: "cli",
      subject: "user-1",
    })
  })

  it("falls back to a full ceremony when the refresh_token grant fails", async () => {
    await store.write(ref, {
      value: "gdt_old",
      kind: "daemon",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      metadata: { refreshToken: "gdr_old" },
    })
    let calls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls += 1
        // 1st: refresh_token grant fails → triggers fall-through to a ceremony.
        if (grantOf(init) === "refresh_token") {
          return jsonRes({ error: "invalid_grant" })
        }
        if (url === DEVICE_AUTH) {
          return jsonRes({
            device_code: "dc-2",
            user_code: "X",
            verification_uri: "https://approve.example/y",
            expires_in: 60,
            interval: 0,
          })
        }
        return jsonRes({ access_token: "gdt_after_fail", expires_in: 60 })
      }),
    )

    const r = await deviceCodeFlowEngine.run(provider, discovered, opts())
    expect(r.accessToken).toBe("gdt_after_fail")
    expect(calls).toBeGreaterThanOrEqual(3)
  })

  it("ignores the cache when force is set", async () => {
    await store.write(ref, {
      value: "gdt_cached",
      kind: "daemon",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === DEVICE_AUTH) {
          return jsonRes({
            device_code: "dc-3",
            user_code: "F",
            verification_uri: "https://approve.example/z",
            expires_in: 60,
            interval: 0,
          })
        }
        return jsonRes({ access_token: "gdt_forced" })
      }),
    )

    const r = await deviceCodeFlowEngine.run(
      provider,
      discovered,
      opts({ force: true }),
    )
    expect(r.accessToken).toBe("gdt_forced")
  })

  it("rejects an insecure (non-HTTPS, non-loopback) endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn())
    await expect(
      deviceCodeFlowEngine.run(
        provider,
        null,
        opts({ server: "http://evil.example" }),
      ),
    ).rejects.toThrow(/requires HTTPS/)
  })

  it("defaults to a KeychainStore when opts.store is omitted", async () => {
    // Off macOS the Keychain backend fails loudly rather than silently — this
    // asserts the default wiring reaches KeychainStore without needing a real
    // Keychain in CI.
    if (process.platform === "darwin") return
    await expect(
      deviceCodeFlowEngine.run(provider, discovered, { server: API }),
    ).rejects.toThrow(/only supports macOS/)
  })
})
