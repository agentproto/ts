import { describe, it, expect, vi, afterEach } from "vitest"
import { pollDeviceGrant } from "../flow-engines/device-grant.js"

const TOKEN = "https://auth.example/oauth2/token"

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

describe("pollDeviceGrant", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("resolves on the first authorization_pending → success transition", async () => {
    let calls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls += 1
        expect(url).toBe(TOKEN)
        expect(grantOf(init)).toBe("urn:example:grant")
        expect(new URLSearchParams(String(init?.body)).get("device_code")).toBe(
          "dc-1",
        )
        if (calls === 1) return jsonRes({ error: "authorization_pending" })
        return jsonRes({ access_token: "tok-1", token_type: "Bearer" })
      }),
    )

    const result = await pollDeviceGrant({
      tokenEndpoint: TOKEN,
      grantType: "urn:example:grant",
      params: { device_code: "dc-1", client_id: "cli" },
      intervalS: 0,
      expiresIn: 60,
    })

    expect(result.access_token).toBe("tok-1")
    expect(calls).toBe(2)
  })

  it("accumulates +5s backoff on repeated slow_down before succeeding", async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          calls += 1
          if (calls <= 2) return jsonRes({ error: "slow_down" })
          return jsonRes({ access_token: "tok-slow" })
        }),
      )

      const pending = pollDeviceGrant({
        tokenEndpoint: TOKEN,
        grantType: "urn:example:grant",
        params: { device_code: "dc-1", client_id: "cli" },
        intervalS: 0,
        expiresIn: 3_600,
      })

      // 1st poll: intervalS(0) → fires immediately.
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toBe(1)

      // slow_down → next wait is 0 + 5s; not yet at 4999ms.
      await vi.advanceTimersByTimeAsync(4_999)
      expect(calls).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toBe(2)

      // 2nd slow_down → accumulates another +5s (10s total); not yet at 9999ms.
      await vi.advanceTimersByTimeAsync(9_999)
      expect(calls).toBe(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toBe(3)

      const result = await pending
      expect(result.access_token).toBe("tok-slow")
    } finally {
      vi.useRealTimers()
    }
  })

  it("throws on expired_token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ error: "expired_token" })))

    await expect(
      pollDeviceGrant({
        tokenEndpoint: TOKEN,
        grantType: "urn:example:grant",
        params: { device_code: "dc-1", client_id: "cli" },
        intervalS: 0,
        expiresIn: 60,
      }),
    ).rejects.toThrow(/claim expired before user approved/)
  })

  it("throws on access_denied", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ error: "access_denied" })))

    await expect(
      pollDeviceGrant({
        tokenEndpoint: TOKEN,
        grantType: "urn:example:grant",
        params: { device_code: "dc-1", client_id: "cli" },
        intervalS: 0,
        expiresIn: 60,
      }),
    ).rejects.toThrow(/access denied — user rejected/)
  })

  it("throws a descriptive error for any other OAuth error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRes({ error: "invalid_request", error_description: "bad client_id" }),
      ),
    )

    await expect(
      pollDeviceGrant({
        tokenEndpoint: TOKEN,
        grantType: "urn:example:grant",
        params: { device_code: "dc-1", client_id: "cli" },
        intervalS: 0,
        expiresIn: 60,
      }),
    ).rejects.toThrow(/token endpoint error: invalid_request — bad client_id/)
  })

  it("throws once the approval window closes with no terminal response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes({ error: "authorization_pending" })),
    )

    await expect(
      pollDeviceGrant({
        tokenEndpoint: TOKEN,
        grantType: "urn:example:grant",
        params: { device_code: "dc-1", client_id: "cli" },
        intervalS: 0,
        expiresIn: 0,
      }),
    ).rejects.toThrow(/auth timeout — approval window closed/)
  })

  it("aborts via signal before the deadline elapses", async () => {
    const ctrl = new AbortController()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes({ error: "authorization_pending" })),
    )

    const pending = pollDeviceGrant({
      tokenEndpoint: TOKEN,
      grantType: "urn:example:grant",
      params: { device_code: "dc-1", client_id: "cli" },
      intervalS: 0,
      expiresIn: 60,
      signal: ctrl.signal,
    })

    ctrl.abort()
    await expect(pending).rejects.toThrow(/auth cancelled/)
  })
})
