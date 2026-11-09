/**
 * AIP-59 section 8 sub-session minter: one token per (alias, session), cached
 * until it is within 60 s of expiry, with concurrent requests sharing a single
 * in-flight mint. Nothing here is network: every request goes through a fake
 * `fetch`.
 */

import { describe, expect, it, vi } from "vitest"

import { createSessionEventBus } from "../session-event-bus.js"
import {
  createSubsessionMinter,
  wireSubsessionLifecycle,
  type SubsessionTarget,
} from "../subsession-minter.js"

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

  describe("reinstateSession (a session resumed in place)", () => {
    const expiry = () => new Date(Date.now() + 3600_000).toISOString()

    it("a revoked session is refused, a reinstated one mints a fresh token", async () => {
      const { fetchImpl, calls } = makeFetch(() => Date.now())
      const minter = createSubsessionMinter({ resolve: async () => TARGET_A, fetch: fetchImpl })

      const first = await minter.tokenFor("bureau", "sess_1")
      await minter.revokeSession("sess_1")
      await expect(minter.tokenFor("bureau", "sess_1")).rejects.toThrow(/session ended/)

      minter.reinstateSession("sess_1")
      const second = await minter.tokenFor("bureau", "sess_1")
      expect(second).not.toBe(first)
      expect(await minter.tokenFor("bureau", "sess_1")).toBe(second)
      expect(calls.map(c => c.method)).toEqual(["POST", "DELETE", "POST"])

      // Idempotent, and harmless for a session that was never revoked.
      minter.reinstateSession("sess_1")
      minter.reinstateSession("sess_never_seen")
      expect(await minter.tokenFor("bureau", "sess_1")).toBe(second)
    })

    it("reinstating one session leaves another revoked session refused", async () => {
      const { fetchImpl } = makeFetch(() => Date.now())
      const minter = createSubsessionMinter({ resolve: async () => TARGET_A, fetch: fetchImpl })
      await minter.revokeSession("sess_1")
      await minter.revokeSession("sess_2")
      minter.reinstateSession("sess_1")
      await expect(minter.tokenFor("bureau", "sess_2")).rejects.toThrow(/session ended/)
      await expect(minter.tokenFor("bureau", "sess_1")).resolves.toEqual(expect.any(String))
    })

    it("a mint in flight across a revoke and a reinstate is dropped and minted again", async () => {
      let release!: () => void
      const gate = new Promise<void>(r => (release = r))
      const log: string[] = []
      let posts = 0
      const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase()
        log.push(method)
        if (method === "DELETE") return new Response(null, { status: 204 })
        posts += 1
        const n = posts
        if (n === 1) await gate
        return new Response(JSON.stringify({ token: `token-${n}`, expiresAt: expiry() }), { status: 200 })
      })
      const minter = createSubsessionMinter({ resolve: async () => TARGET_A, fetch: fetchImpl as unknown as typeof fetch })

      const pending = minter.tokenFor("bureau", "sess_1")
      await new Promise(r => setTimeout(r, 0))
      await minter.revokeSession("sess_1")
      minter.reinstateSession("sess_1")
      release()

      // The first token may have been deleted server-side after it was minted,
      // so it is never cached: the caller gets the second one.
      expect(await pending).toBe("token-2")
      expect(await minter.tokenFor("bureau", "sess_1")).toBe("token-2")
      expect(log).toEqual(["POST", "POST"])
    })

    it("a DELETE still on the wire when the session is reinstated finishes before the new POST", async () => {
      let releaseDelete!: () => void
      const deleteGate = new Promise<void>(r => (releaseDelete = r))
      const log: string[] = []
      let posts = 0
      const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase()
        if (method === "DELETE") {
          log.push("DELETE:start")
          await deleteGate
          log.push("DELETE:end")
          return new Response(null, { status: 204 })
        }
        posts += 1
        log.push(`POST:${posts}`)
        return new Response(JSON.stringify({ token: `token-${posts}`, expiresAt: expiry() }), { status: 200 })
      })
      const minter = createSubsessionMinter({ resolve: async () => TARGET_A, fetch: fetchImpl as unknown as typeof fetch })

      await minter.tokenFor("bureau", "sess_1")
      const revoking = minter.revokeSession("sess_1")
      minter.reinstateSession("sess_1")
      const next = minter.tokenFor("bureau", "sess_1")
      await new Promise(r => setTimeout(r, 10))
      expect(log).toEqual(["POST:1", "DELETE:start"])

      releaseDelete()
      await revoking
      expect(await next).toBe("token-2")
      expect(log).toEqual(["POST:1", "DELETE:start", "DELETE:end", "POST:2"])
    })

    it("a revoke the server never confirmed is settled before the new mint, never after it", async () => {
      let deleteStatus = 500
      const log: string[] = []
      let posts = 0
      const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase()
        if (method === "DELETE") {
          log.push(`DELETE:${deleteStatus}`)
          return new Response(null, { status: deleteStatus })
        }
        posts += 1
        log.push(`POST:${posts}`)
        return new Response(JSON.stringify({ token: `token-${posts}`, expiresAt: expiry() }), { status: 200 })
      })
      const minter = createSubsessionMinter({ resolve: async () => TARGET_A, fetch: fetchImpl as unknown as typeof fetch })

      await minter.tokenFor("bureau", "sess_1")
      await expect(minter.revokeSession("sess_1")).rejects.toThrow(/will retry/)
      minter.reinstateSession("sess_1")

      // The server still honours the old token: no new token is minted while
      // the DELETE cannot be confirmed (it would delete the NEW token later).
      await expect(minter.tokenFor("bureau", "sess_1")).rejects.toThrow(/still pending/)
      expect(log).toEqual(["POST:1", "DELETE:500", "DELETE:500"])

      deleteStatus = 204
      expect(await minter.tokenFor("bureau", "sess_1")).toBe("token-2")
      expect(log).toEqual(["POST:1", "DELETE:500", "DELETE:500", "DELETE:204", "POST:2"])

      // Nothing is left owed: a later revoke of ANOTHER session sends no stale DELETE for this one.
      await minter.revokeSession("sess_other")
      expect(log.filter(l => l.startsWith("DELETE"))).toHaveLength(3)
      expect(log[log.length - 1]).toBe("POST:2")
    })
  })
})

describe("wireSubsessionLifecycle", () => {
  const exited = (sessionId: string) =>
    ({ type: "session:exited", sessionId, status: "killed", exitCode: null, ts: "t" }) as never
  const resumed = (sessionId: string) =>
    ({ type: "session:resumed", sessionId, interrupted: false, resumedFrom: "daemon-restart", ts: "t" }) as never

  function setup(rows: Record<string, Record<string, unknown>>) {
    const sessionEvents = createSessionEventBus()
    const subsessions = {
      revokeSession: vi.fn(async (_id: string) => {}),
      reinstateSession: vi.fn((_id: string) => {}),
    }
    wireSubsessionLifecycle({ sessionEvents, registry: { get: id => rows[id] }, subsessions })
    return { sessionEvents, subsessions }
  }

  it("revokes on exit and reinstates a live, non-retired session on resume", () => {
    const { sessionEvents, subsessions } = setup({ sess_1: { endedReason: "idle-reaped" } })
    sessionEvents.emit(exited("sess_1"))
    expect(subsessions.revokeSession).toHaveBeenCalledWith("sess_1")
    sessionEvents.emit(resumed("sess_1"))
    expect(subsessions.reinstateSession).toHaveBeenCalledWith("sess_1")
  })

  it("never reinstates a retired or unknown session", () => {
    const { sessionEvents, subsessions } = setup({
      archived: { archived: true },
      superseded: { continuedTo: "sess_next" },
      stamped: { retiredAt: "2026-01-01T00:00:00Z" },
      stopped: { endedReason: "operator-stopped" },
    })
    for (const id of ["archived", "superseded", "stamped", "stopped", "ghost"]) {
      sessionEvents.emit(resumed(id))
    }
    expect(subsessions.reinstateSession).not.toHaveBeenCalled()
  })

  it("a failing revoke never throws into the exit path", async () => {
    const sessionEvents = createSessionEventBus()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    wireSubsessionLifecycle({
      sessionEvents,
      registry: { get: () => undefined },
      subsessions: {
        revokeSession: async () => {
          throw new Error("server down")
        },
        reinstateSession: () => {},
      },
    })
    expect(() => sessionEvents.emit(exited("sess_1"))).not.toThrow()
    await new Promise(r => setTimeout(r, 0))
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
