/**
 * AIP-59 section 8 sub-session minter: one token per (alias, session), cached
 * until it is within 60 s of expiry, with concurrent requests sharing a single
 * in-flight mint. Nothing here is network: every request goes through a fake
 * `fetch`.
 */

import { describe, expect, it, vi } from "vitest"

import { createSubsessionMinter, type SubsessionTarget } from "../subsession-minter.js"

interface MintCall {
  url: string
  method: string
  headers: Headers
  body: { sessionId?: string; ttlSeconds?: number }
}

const TARGET_A: SubsessionTarget = {
  baseUrl: "https://bureau.example",
  headers: { authorization: "Bearer device-a" },
}
const TARGET_B: SubsessionTarget = {
  baseUrl: "https://bureau-b.example",
  headers: { authorization: "Bearer device-b" },
}

function makeFetch(now: () => number) {
  const calls: MintCall[] = []
  let minted = 0
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? "GET").toUpperCase()
    const headers = new Headers(init?.headers)
    const body = init?.body ? (JSON.parse(String(init.body)) as MintCall["body"]) : {}
    calls.push({ url, method, headers, body })
    if (method === "DELETE") return new Response(null, { status: 204 })
    minted += 1
    const ttl = body.ttlSeconds ?? 3600
    return new Response(
      JSON.stringify({
        token: `token-${minted}`,
        sessionId: body.sessionId,
        deviceId: "dev_1",
        expiresAt: new Date(now() + ttl * 1000).toISOString(),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  })
  return { fetchImpl, calls }
}

describe("createSubsessionMinter", () => {
  it("posts { sessionId, ttlSeconds } with the import's headers and caches per (alias, session)", async () => {
    let now = 1_000_000
    const { fetchImpl, calls } = makeFetch(() => now)
    const minter = createSubsessionMinter({
      resolve: async alias => (alias === "bureau" ? TARGET_A : undefined),
      fetch: fetchImpl,
      now: () => now,
    })

    expect(await minter.applies("bureau")).toBe(true)
    expect(await minter.applies("other")).toBe(false)

    const first = await minter.tokenFor("bureau", "sess_1")
    const second = await minter.tokenFor("bureau", "sess_1")
    expect(second).toBe(first)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("https://bureau.example/pair/subsessions")
    expect(calls[0]!.method).toBe("POST")
    expect(calls[0]!.body).toEqual({ sessionId: "sess_1", ttlSeconds: 3600 })
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer device-a")

    now += 1000
    expect(await minter.tokenFor("bureau", "sess_1")).toBe(first)
    expect(calls).toHaveLength(1)
  })

  it("re-mints when the cached token is within 60 s of expiry", async () => {
    let now = 1_000_000
    const { fetchImpl, calls } = makeFetch(() => now)
    const minter = createSubsessionMinter({
      resolve: async () => TARGET_A,
      fetch: fetchImpl,
      now: () => now,
      ttlSeconds: 120,
    })

    const first = await minter.tokenFor("bureau", "sess_1")
    now += 61_000 // 59 s left
    const second = await minter.tokenFor("bureau", "sess_1")
    expect(second).not.toBe(first)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.body.ttlSeconds).toBe(120)
  })

  it("shares one in-flight mint between concurrent callers", async () => {
    const target = TARGET_A
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const fetchImpl = vi.fn(async () => {
      await gate
      return new Response(
        JSON.stringify({
          token: "shared-token",
          sessionId: "sess_1",
          deviceId: "dev_1",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
        { status: 200 },
      )
    })
    const minter = createSubsessionMinter({ resolve: async () => target, fetch: fetchImpl })

    const a = minter.tokenFor("bureau", "sess_1")
    const b = minter.tokenFor("bureau", "sess_1")
    release()
    expect(await a).toBe("shared-token")
    expect(await b).toBe("shared-token")
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("revokeSession deletes for every alias that minted for it and drops the cache", async () => {
    const { fetchImpl, calls } = makeFetch(() => 1_000_000)
    const minter = createSubsessionMinter({
      resolve: async alias => (alias === "bureau" ? TARGET_A : alias === "bureau-b" ? TARGET_B : undefined),
      fetch: fetchImpl,
    })

    await minter.tokenFor("bureau", "sess_1")
    await minter.tokenFor("bureau-b", "sess_1")

    await minter.revokeSession("sess_1")
    const deletes = calls.filter(c => c.method === "DELETE")
    expect(deletes.map(c => c.url).sort()).toEqual([
      "https://bureau-b.example/pair/subsessions/sess_1",
      "https://bureau.example/pair/subsessions/sess_1",
    ])
    expect(deletes[0]!.headers.get("authorization")).toMatch(/Bearer device-/)

    // A revoked (ended) session never gets a token again.
    await expect(minter.tokenFor("bureau", "sess_1")).rejects.toThrow(/session ended/)
    expect(calls.filter(c => c.method === "POST")).toHaveLength(2)
  })

  it("an error message never contains a token or an Authorization value", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "denied super-secret-token" }), { status: 401 }),
    )
    const minter = createSubsessionMinter({ resolve: async () => TARGET_A, fetch: fetchImpl })

    const err = await minter.tokenFor("bureau", "sess_1").then(
      () => {
        throw new Error("expected a rejection")
      },
      (e: unknown) => e as Error,
    )
    expect(err.message).toMatch(/bureau/)
    expect(err.message).toMatch(/401/)
    expect(err.message).not.toContain("super-secret-token")
    expect(err.message).not.toContain("Bearer device-a")
    expect(err.message).not.toContain("device-a")
  })

  it("a mint still in flight when the session ends is revoked, never cached", async () => {
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    const deletes: string[] = []
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET").toUpperCase() === "DELETE") {
        deletes.push(String(input))
        return new Response(null, { status: 204 })
      }
      await gate
      return new Response(JSON.stringify({ token: "late", expiresAt: new Date(Date.now() + 3600_000).toISOString() }), { status: 200 })
    })
    const minter = createSubsessionMinter({ resolve: async () => TARGET_A, fetch: fetchImpl as unknown as typeof fetch })
    const pending = minter.tokenFor("bureau", "sess_1")
    await new Promise(r => setTimeout(r, 0))
    await minter.revokeSession("sess_1")
    release()
    await expect(pending).rejects.toThrow(/session ended/)
    expect(deletes).toEqual(["https://bureau.example/pair/subsessions/sess_1"])
    await expect(minter.tokenFor("bureau", "sess_1")).rejects.toThrow(/session ended/)
  })

  it("a revoke the server does not confirm is kept and retried", async () => {
    let deleteStatus = 500
    const deletes: number[] = []
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET").toUpperCase() === "DELETE") {
        deletes.push(deleteStatus)
        return new Response(null, { status: deleteStatus })
      }
      return new Response(JSON.stringify({ token: "t", expiresAt: new Date(Date.now() + 3600_000).toISOString() }), { status: 200 })
    })
    const minter = createSubsessionMinter({ resolve: async () => TARGET_A, fetch: fetchImpl as unknown as typeof fetch })
    await minter.tokenFor("bureau", "sess_1")
    await expect(minter.revokeSession("sess_1")).rejects.toThrow(/will retry/)
    deleteStatus = 204
    await minter.revokeSession("sess_other")
    expect(deletes).toEqual([500, 204])
  })
})
