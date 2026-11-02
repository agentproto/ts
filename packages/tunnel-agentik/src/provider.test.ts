import { describe, expect, it, vi } from "vitest"
import type { FetchLike } from "@agentproto/tunnel"
import { TunnelProviderError } from "@agentproto/tunnel"

import {
  AGENTIK_TUNNEL_DEFAULT_BASE_URL,
  AgentikTunnelProvider,
  agentikTunnelProviderFromCredentials,
} from "./provider.js"

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  })
}

interface Call {
  url: string
  init: RequestInit | undefined
}

function recorder(...responses: Response[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
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

function headersOf(call: Call | undefined): Record<string, string> {
  return { ...(call?.init?.headers as Record<string, string> | undefined) }
}

function provider(fetch: FetchLike, baseUrl = "https://tunnels.example.com") {
  return new AgentikTunnelProvider({ apiKey: "sk-test", baseUrl, fetch })
}

describe("AgentikTunnelProvider construction", () => {
  it("defaults to tunnels.agentik.net and exposes discovery metadata", () => {
    const instance = new AgentikTunnelProvider({ apiKey: "sk-test" })
    expect(instance.baseUrl).toBe(AGENTIK_TUNNEL_DEFAULT_BASE_URL)
    expect(instance.slug).toBe("agentik")
    expect(instance.capabilities.hasApi).toBe(true)
  })

  it("rejects an apiKey without the sk- prefix", () => {
    expect(() => new AgentikTunnelProvider({ apiKey: "nope" })).toThrow(/must start with "sk-"/)
    expect(() => new AgentikTunnelProvider({ apiKey: "" })).toThrow(/must start with "sk-"/)
  })

  it("rejects a non-https baseUrl", () => {
    expect(
      () => new AgentikTunnelProvider({ apiKey: "sk-test", baseUrl: "http://tunnels.example.com" }),
    ).toThrow(/must use https/)
  })
})

describe("AgentikTunnelProvider.create", () => {
  it("PUTs the key with the service and hostnames, bearing the api key", async () => {
    const { fetch, calls } = recorder(
      jsonResponse({
        key: "k1",
        tunnelId: "tun_1",
        hostnames: ["k1.tunnels.agentik.net"],
        token: "connector-secret",
        status: "active",
      }),
    )
    const tunnel = await provider(fetch).create({
      key: "k1",
      service: "http://127.0.0.1:3000",
      hostnames: ["k1.tunnels.agentik.net"],
    })

    expect(calls[0]?.url).toBe("https://tunnels.example.com/v1/tunnels/k1")
    expect(calls[0]?.init?.method).toBe("PUT")
    expect(headersOf(calls[0])["authorization"]).toBe("Bearer sk-test")
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      service: "http://127.0.0.1:3000",
      hostnames: ["k1.tunnels.agentik.net"],
    })
    expect(tunnel).toMatchObject({
      key: "k1",
      tunnelId: "tun_1",
      status: "active",
      publicUrl: "https://k1.tunnels.agentik.net",
      hostnames: ["k1.tunnels.agentik.net"],
      connectorToken: "connector-secret",
    })
  })

  it("derives the service origin from a target", async () => {
    const { fetch, calls } = recorder(jsonResponse({ key: "k2", hostnames: [] }))
    await provider(fetch).create({
      key: "k2",
      target: { host: "127.0.0.1", port: 8787 },
    })
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      service: "http://127.0.0.1:8787",
      hostnames: [],
    })
  })

  it("accepts a dotted, underscored key verbatim", async () => {
    const { fetch, calls } = recorder(jsonResponse({ key: "team.api_1", hostnames: [] }))
    await provider(fetch).create({ key: "team.api_1" })
    expect(calls[0]?.url).toBe("https://tunnels.example.com/v1/tunnels/team.api_1")
  })

  it("treats an empty response body as created", async () => {
    const { fetch } = recorder(new Response(null, { status: 204 }))
    await expect(
      provider(fetch).create({ key: "k3", hostnames: ["k3.example.com"] }),
    ).resolves.toEqual({
      key: "k3",
      status: "active",
      hostnames: ["k3.example.com"],
      publicUrl: "https://k3.example.com",
    })
  })

  it("rejects an invalid key before any network call", async () => {
    const fetch = vi.fn<FetchLike>()
    await expect(provider(fetch).create({ key: "../escape" })).rejects.toThrow(/invalid key/)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe("AgentikTunnelProvider.list / status", () => {
  it("reads { tunnels: [...] } and normalises records", async () => {
    const { fetch } = recorder(
      jsonResponse({
        tunnels: [
          {
            key: "k1",
            id: "tun_1",
            status: "running",
            hostnames: ["a.example.com"],
            service: "http://127.0.0.1:3000",
          },
          { key: "k2", status: "stopped", url: "https://b.example.com" },
        ],
      }),
    )
    await expect(provider(fetch).list()).resolves.toEqual([
      {
        key: "k1",
        tunnelId: "tun_1",
        status: "active",
        hostnames: ["a.example.com"],
        service: "http://127.0.0.1:3000",
        publicUrl: "https://a.example.com",
      },
      {
        key: "k2",
        status: "stopped",
        hostnames: [],
        service: null,
        publicUrl: "https://b.example.com",
      },
    ])
  })

  it("also accepts a bare array and drops keyless rows", async () => {
    const { fetch } = recorder(jsonResponse([{ key: "k1", hostnames: [] }, { nope: true }]))
    await expect(provider(fetch).list()).resolves.toHaveLength(1)
  })

  it("finds a tunnel by key and returns null when absent", async () => {
    const { fetch } = recorder(
      jsonResponse({ tunnels: [{ key: "k1", hostnames: [] }] }),
      jsonResponse({ tunnels: [] }),
    )
    const instance = provider(fetch)
    await expect(instance.status("k1")).resolves.toMatchObject({ key: "k1" })
    await expect(instance.status("k2")).resolves.toBeNull()
  })
})

describe("AgentikTunnelProvider.delete", () => {
  it("DELETEs the tunnel", async () => {
    const { fetch, calls } = recorder(new Response(null, { status: 204 }))
    await expect(provider(fetch).delete("k1")).resolves.toBeUndefined()
    expect(calls[0]?.url).toBe("https://tunnels.example.com/v1/tunnels/k1")
    expect(calls[0]?.init?.method).toBe("DELETE")
  })

  it("swallows a 404", async () => {
    const { fetch } = recorder(jsonResponse({ error: "not_found" }, { status: 404 }))
    await expect(provider(fetch).delete("ghost")).resolves.toBeUndefined()
  })

  it("rethrows other failures", async () => {
    const { fetch } = recorder(jsonResponse({ error: "boom", message: "kaboom" }, { status: 500 }))
    await expect(provider(fetch).delete("k1")).rejects.toBeInstanceOf(TunnelProviderError)
  })
})

describe("AgentikTunnelProvider.health", () => {
  it("reports active when the API answers", async () => {
    const { fetch } = recorder(jsonResponse({ tunnels: [] }))
    const health = await provider(fetch).health()
    expect(health.state).toBe("active")
    expect(typeof health.checkedAt).toBe("string")
    expect(health.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it("reports error instead of throwing", async () => {
    const { fetch } = recorder(jsonResponse({ error: "down" }, { status: 503 }))
    const health = await provider(fetch).health()
    expect(health.state).toBe("error")
    expect(health.reason).toContain("503")
  })

  it("reports error on a transport failure", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("offline")
    }
    const health = await provider(fetch).health()
    expect(health.state).toBe("error")
    expect(health.reason).toContain("offline")
  })
})

describe("agentikTunnelProviderFromCredentials", () => {
  it("builds a provider from a stored record", () => {
    const instance = agentikTunnelProviderFromCredentials({
      apiKey: "sk-stored",
      baseUrl: "https://tunnels.example.com",
    })
    expect(instance.baseUrl).toBe("https://tunnels.example.com")
  })

  it("rejects a record without an apiKey", () => {
    expect(() => agentikTunnelProviderFromCredentials({})).toThrow(/missing apiKey/)
    expect(() => agentikTunnelProviderFromCredentials(null)).toThrow(/missing apiKey/)
  })
})
