import { describe, expect, it } from "vitest"

import type { FetchLike } from "../remote-providers/cloudflare-api.js"
import {
  DEFAULT_DOH_ENDPOINTS,
  defaultPublicDns,
  resolveViaDoh,
  waitForPublicDns,
  type DohResult,
} from "../remote-providers/dns-resolver.js"

// --- fakes --------------------------------------------------------------

interface FetchCall {
  url: string
  init?: Parameters<FetchLike>[1]
}

function okJson(body: unknown, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

function nonOk(status: number) {
  return {
    status,
    ok: false,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => "",
  }
}

function recordingFetch(
  handler: (url: string, init: Parameters<FetchLike>[1]) => Promise<unknown> | unknown,
): { fetch: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init })
    return (await handler(url, init)) as Awaited<ReturnType<FetchLike>>
  }
  return { fetch, calls }
}

const ENDPOINTS = ["https://dns.one/query", "https://dns.two/query"]

function typeOf(url: string): string {
  return new URL(url).searchParams.get("type") ?? ""
}

function endpointOf(url: string): string {
  return url.split("?")[0] as string
}

// --- resolveViaDoh ------------------------------------------------------

describe("resolveViaDoh", () => {
  it("returns an A answer with the addresses", async () => {
    const { fetch } = recordingFetch(() =>
      okJson({ Status: 0, Answer: [{ type: 1, data: "203.0.113.10" }] }),
    )
    const result = await resolveViaDoh("example.com", { fetch, endpoints: ENDPOINTS })
    expect(result).toEqual({ kind: "answer", addresses: ["203.0.113.10"] })
  })

  it("counts only type 1 and 28 records with non-empty data", async () => {
    const { fetch } = recordingFetch(() =>
      okJson({
        Status: 0,
        Answer: [
          { type: 1, data: "" }, // empty data, ignored
          { type: 28, data: "2001:db8::1" }, // AAAA, kept
          { type: 5, data: "target.example.com" }, // CNAME, ignored
          { type: 1, data: "203.0.113.11" }, // A, kept
        ],
      }),
    )
    const result = await resolveViaDoh("example.com", { fetch, endpoints: ENDPOINTS })
    expect(result).toEqual({ kind: "answer", addresses: ["2001:db8::1", "203.0.113.11"] })
  })

  it("treats a CNAME-only answer as no-answer", async () => {
    const { fetch } = recordingFetch(() =>
      okJson({ Status: 0, Answer: [{ type: 5, data: "target.example.com" }] }),
    )
    const result = await resolveViaDoh("example.com", { fetch, endpoints: ENDPOINTS })
    expect(result).toEqual({ kind: "no-answer" })
  })

  it("queries A on every endpoint first, then AAAA, and returns the AAAA answer", async () => {
    const { fetch, calls } = recordingFetch(url => {
      if (typeOf(url) === "A") return okJson({ Status: 0, Answer: [] })
      return okJson({ Status: 0, Answer: [{ type: 28, data: "2001:db8::2" }] })
    })
    const result = await resolveViaDoh("v6.example.com", { fetch, endpoints: ENDPOINTS })
    expect(result).toEqual({ kind: "answer", addresses: ["2001:db8::2"] })
    expect(calls.map(c => `${endpointOf(c.url)}#${typeOf(c.url)}`)).toEqual([
      "https://dns.one/query#A",
      "https://dns.two/query#A",
      "https://dns.one/query#AAAA",
    ])
  })

  it("uses the first endpoint that has addresses and stops there", async () => {
    const { fetch, calls } = recordingFetch(url => {
      if (endpointOf(url) === "https://dns.one/query") {
        return okJson({ Status: 0, Answer: [{ type: 1, data: "203.0.113.20" }] })
      }
      return okJson({ Status: 0, Answer: [{ type: 1, data: "203.0.113.21" }] })
    })
    const result = await resolveViaDoh("example.com", { fetch, endpoints: ENDPOINTS })
    expect(result).toEqual({ kind: "answer", addresses: ["203.0.113.20"] })
    expect(calls).toHaveLength(1)
  })

  it("falls back to the second endpoint when the first throws", async () => {
    const { fetch, calls } = recordingFetch(url => {
      if (endpointOf(url) === "https://dns.one/query") throw new Error("connection refused")
      return okJson({ Status: 0, Answer: [{ type: 1, data: "203.0.113.30" }] })
    })
    const result = await resolveViaDoh("example.com", { fetch, endpoints: ENDPOINTS })
    expect(result).toEqual({ kind: "answer", addresses: ["203.0.113.30"] })
    expect(calls.map(c => endpointOf(c.url))).toEqual([
      "https://dns.one/query",
      "https://dns.two/query",
    ])
  })

  it("falls back to the second endpoint when the first returns non-ok HTTP", async () => {
    const { fetch } = recordingFetch(url => {
      if (endpointOf(url) === "https://dns.one/query") return nonOk(500)
      return okJson({ Status: 0, Answer: [{ type: 1, data: "203.0.113.31" }] })
    })
    const result = await resolveViaDoh("example.com", { fetch, endpoints: ENDPOINTS })
    expect(result).toEqual({ kind: "answer", addresses: ["203.0.113.31"] })
  })

  it("returns no-answer when every endpoint answers without addresses (NXDOMAIN body)", async () => {
    const { fetch, calls } = recordingFetch(() => okJson({ Status: 3, Answer: [] }))
    const result = await resolveViaDoh("missing.example.com", { fetch, endpoints: ENDPOINTS })
    expect(result).toEqual({ kind: "no-answer" })
    expect(calls).toHaveLength(4)
  })

  it("returns no-answer when every endpoint answers with an empty Answer", async () => {
    const { fetch } = recordingFetch(() => okJson({ Status: 0 }))
    const result = await resolveViaDoh("example.com", { fetch, endpoints: ENDPOINTS })
    expect(result).toEqual({ kind: "no-answer" })
  })

  it("returns unreachable with the last error when every endpoint throws", async () => {
    const { fetch } = recordingFetch(url => {
      throw new Error(`boom ${endpointOf(url)} ${typeOf(url)}`)
    })
    const result = await resolveViaDoh("example.com", { fetch, endpoints: ENDPOINTS })
    expect(result).toEqual({
      kind: "unreachable",
      error: "boom https://dns.two/query AAAA",
    })
  })

  it("returns unreachable with the last error when every endpoint is non-ok", async () => {
    let status = 500
    const { fetch } = recordingFetch(() => nonOk(status++))
    const result = await resolveViaDoh("example.com", { fetch, endpoints: ENDPOINTS })
    expect(result.kind).toBe("unreachable")
    expect(result).toMatchObject({ kind: "unreachable", error: "HTTP 503" })
  })

  it("builds the DoH request with encoded name, accept header and a signal", async () => {
    const { fetch, calls } = recordingFetch(() => okJson({ Status: 0, Answer: [] }))
    await resolveViaDoh("ex ample.example.com", { fetch, endpoints: ["https://dns.example/q"] })

    expect(calls[0]?.url).toBe(
      "https://dns.example/q?name=ex%20ample.example.com&type=A",
    )
    expect(calls[0]?.init?.headers).toEqual({ accept: "application/dns-json" })
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  it("uses DEFAULT_DOH_ENDPOINTS when endpoints are omitted", async () => {
    const { fetch, calls } = recordingFetch(() => okJson({ Status: 3, Answer: [] }))
    await resolveViaDoh("example.com", { fetch })
    expect(calls).toHaveLength(4)
    expect(calls[0]?.url).toBe(
      `${DEFAULT_DOH_ENDPOINTS[0]}?name=example.com&type=A`,
    )
    expect(calls[1]?.url).toBe(
      `${DEFAULT_DOH_ENDPOINTS[1]}?name=example.com&type=A`,
    )
  })

  it("reports a SERVFAIL body (Status 2) as no-answer today", async () => {
    const { fetch } = recordingFetch(() => okJson({ Status: 2, Answer: [] }))
    const result = await resolveViaDoh("example.com", { fetch, endpoints: ENDPOINTS })
    expect(result).toEqual({ kind: "no-answer" })
  })
})

// --- waitForPublicDns ---------------------------------------------------

interface VirtualClock {
  now: () => number
  sleep: (ms: number) => Promise<void>
  sleeps: number[]
}

function virtualClock(): VirtualClock {
  let clock = 0
  const sleeps: number[] = []
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      clock += ms
    },
    sleeps,
  }
}

describe("waitForPublicDns", () => {
  it("returns immediately on the first answer without sleeping", async () => {
    const clock = virtualClock()
    const result = await waitForPublicDns("example.com", {
      resolve: async () => ({ kind: "answer", addresses: ["203.0.113.1"] }),
      ...clock,
    })
    expect(result).toEqual({ kind: "answer", addresses: ["203.0.113.1"] })
    expect(clock.sleeps).toEqual([])
  })

  it("backs off with defaults 500, 800, 1280, 2048, 3277, 5000, 5000", async () => {
    const clock = virtualClock()
    let calls = 0
    const result = await waitForPublicDns("example.com", {
      resolve: async (): Promise<DohResult> => {
        calls++
        if (calls >= 8) return { kind: "answer", addresses: ["203.0.113.2"] }
        return { kind: "no-answer" }
      },
      timeoutMs: 60_000,
      ...clock,
    })
    expect(result).toEqual({ kind: "answer", addresses: ["203.0.113.2"] })
    expect(clock.sleeps).toEqual([500, 800, 1280, 2048, 3277, 5000, 5000])
  })

  it("clips the last sleep to the remaining budget and returns the last no-answer", async () => {
    const clock = virtualClock()
    const result = await waitForPublicDns("example.com", {
      resolve: async () => ({ kind: "no-answer" }),
      timeoutMs: 2_000,
      ...clock,
    })
    expect(result).toEqual({ kind: "no-answer" })
    expect(clock.sleeps).toEqual([500, 800, 700])
    expect(clock.now()).toBe(2_000)
  })

  it("turns a throwing resolve into unreachable and keeps polling", async () => {
    const clock = virtualClock()
    let calls = 0
    const result = await waitForPublicDns("example.com", {
      resolve: async (): Promise<DohResult> => {
        calls++
        if (calls === 1) throw new Error("transient")
        return { kind: "answer", addresses: ["203.0.113.3"] }
      },
      ...clock,
    })
    expect(result).toEqual({ kind: "answer", addresses: ["203.0.113.3"] })
    expect(clock.sleeps).toEqual([500])
  })

  it("returns the last unreachable result when the budget runs out", async () => {
    const clock = virtualClock()
    const result = await waitForPublicDns("example.com", {
      resolve: async () => {
        throw new Error("boom")
      },
      timeoutMs: 1_000,
      ...clock,
    })
    expect(result).toEqual({ kind: "unreachable", error: "boom" })
    expect(clock.sleeps).toEqual([500, 500])
  })
})

// --- defaultPublicDns ---------------------------------------------------

describe("defaultPublicDns", () => {
  it("wires resolve to resolveViaDoh with the supplied options", async () => {
    const { fetch, calls } = recordingFetch(() =>
      okJson({ Status: 0, Answer: [{ type: 1, data: "203.0.113.40" }] }),
    )
    const dns = defaultPublicDns({ fetch, endpoints: ENDPOINTS })
    const result = await dns.resolve("example.com")
    expect(result).toEqual({ kind: "answer", addresses: ["203.0.113.40"] })
    expect(calls[0]?.url).toBe("https://dns.one/query?name=example.com&type=A")
  })

  it("exposes pinnedFetch and systemLookup", () => {
    const dns = defaultPublicDns({ fetch: recordingFetch(() => okJson({})).fetch })
    expect(typeof dns.pinnedFetch).toBe("function")
    expect(typeof dns.systemLookup).toBe("function")
  })
})
