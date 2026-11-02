import { describe, expect, it, vi } from "vitest"

import { TunnelClient, type TunnelRequestOptions } from "./client.js"
import {
  TunnelProviderError,
  type FetchLike,
  type TunnelAuth,
  type TunnelOidcAuth,
} from "./types.js"

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  })
}

class TestClient extends TunnelClient {
  get<T>(path: string, options?: TunnelRequestOptions): Promise<T> {
    return this.request<T>(path, options)
  }
}

function recorder(...responses: Response[]): {
  fetch: FetchLike
  calls: Array<{ url: string; init: RequestInit | undefined }>
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  let index = 0
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const res = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (!res) throw new Error("no response queued")
    return res
  }
  return { fetch, calls }
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return { ...(init?.headers as Record<string, string> | undefined) }
}

describe("normalizeTunnelBaseUrl", () => {
  it("adds https and strips trailing slashes", () => {
    const client = new TestClient({ baseUrl: "tunnels.example.com/" })
    expect(client.baseUrl).toBe("https://tunnels.example.com")
  })

  it("allows plain http on loopback only", () => {
    expect(new TestClient({ baseUrl: "http://127.0.0.1:8787" }).baseUrl).toBe(
      "http://127.0.0.1:8787",
    )
    expect(() => new TestClient({ baseUrl: "http://tunnels.example.com" })).toThrow(
      /must use https/,
    )
  })

  it("rejects an empty or invalid url", () => {
    expect(() => new TestClient({ baseUrl: "  " })).toThrow(/baseUrl is required/)
    expect(() => new TestClient({ baseUrl: "https://exa mple.com" })).toThrow(/invalid baseUrl/)
  })
})

describe("TunnelClient", () => {
  it("sends an apiKey as a bearer token and JSON body", async () => {
    const { fetch, calls } = recorder(jsonResponse({ ok: true }))
    const client = new TestClient({
      baseUrl: "https://tunnels.example.com",
      auth: { mode: "apiKey", apiKey: "sk-test" },
      fetch,
    })

    await expect(client.get("/v1/tunnels/k1", { method: "PUT", body: { x: 1 } })).resolves.toEqual({
      ok: true,
    })
    expect(calls[0]?.url).toBe("https://tunnels.example.com/v1/tunnels/k1")
    const headers = headersOf(calls[0]?.init)
    expect(headers["authorization"]).toBe("Bearer sk-test")
    expect(headers["content-type"]).toBe("application/json")
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ x: 1 }))
  })

  it("resolves an apiKey without a scheme", async () => {
    const { fetch, calls } = recorder(jsonResponse({}))
    const client = new TestClient({
      baseUrl: "https://tunnels.example.com",
      auth: { mode: "apiKey", apiKey: "sk-test" },
      fetch,
    })
    await client.get("/v1/tunnels", { auth: false })
    expect(headersOf(calls[0]?.init)["authorization"]).toBeUndefined()
  })

  it("refreshes an oidc token once on 401", async () => {
    const accessToken = vi
      .fn<TunnelOidcAuth["accessToken"]>()
      .mockResolvedValueOnce("expired")
      .mockResolvedValueOnce("fresh")
    const { fetch, calls } = recorder(
      jsonResponse({ error: "unauthorized" }, { status: 401 }),
      jsonResponse({ ok: true }),
    )
    const auth: TunnelAuth = {
      mode: "oidc",
      issuer: "https://auth.example.com",
      clientId: "client",
      accessToken,
    }
    const client = new TestClient({ baseUrl: "https://tunnels.example.com", auth, fetch })

    await expect(client.get("/v1/tunnels")).resolves.toEqual({ ok: true })
    expect(calls).toHaveLength(2)
    expect(headersOf(calls[0]?.init)["authorization"]).toBe("Bearer expired")
    expect(headersOf(calls[1]?.init)["authorization"]).toBe("Bearer fresh")
    expect(accessToken).toHaveBeenNthCalledWith(1, undefined)
    expect(accessToken).toHaveBeenNthCalledWith(2, { forceRefresh: true })
  })

  it("maps an error body to a TunnelProviderError", async () => {
    const { fetch } = recorder(
      jsonResponse(
        { error: "hostname_taken", message: "already routed", checkoutUrl: "https://pay.example" },
        { status: 409 },
      ),
    )
    const client = new TestClient({ baseUrl: "https://tunnels.example.com", fetch })

    await expect(client.get("/v1/tunnels")).rejects.toMatchObject({
      name: "TunnelProviderError",
      status: 409,
      code: "hostname_taken",
      checkoutUrl: "https://pay.example",
    })
    await expect(client.get("/v1/tunnels")).rejects.toBeInstanceOf(TunnelProviderError)
  })

  it("returns undefined for an empty body and text for non-JSON", async () => {
    const { fetch } = recorder(
      new Response(null, { status: 204 }),
      new Response("plain text", { status: 200 }),
    )
    const client = new TestClient({ baseUrl: "https://tunnels.example.com", fetch })
    await expect(client.get("/v1/a")).resolves.toBeUndefined()
    await expect(client.get("/v1/b")).resolves.toBe("plain text")
  })

  it("wraps a transport failure", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("boom")
    }
    const client = new TestClient({ baseUrl: "https://tunnels.example.com", fetch })
    await expect(client.get("/v1/tunnels")).rejects.toMatchObject({
      code: "network_error",
    })
  })
})
