import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"

const httpsMock = vi.hoisted(() => ({ request: vi.fn() }))

vi.mock("node:https", () => ({ request: httpsMock.request }))

import { pinnedHttpsFetch } from "../remote-providers/dns-resolver.js"

interface Captured {
  options: Record<string, unknown>
}

function makeResponse(opts: {
  statusCode?: number
  headers?: Record<string, string | string[]>
  chunks?: string[]
}) {
  const res = new EventEmitter() as EventEmitter & {
    statusCode: number
    headers: Record<string, string | string[]>
  }
  res.statusCode = opts.statusCode ?? 200
  res.headers = opts.headers ?? {}
  return res
}

function install(opts: {
  response: ReturnType<typeof makeResponse>
  chunks?: string[]
  error?: Error
}) {
  const captured: Captured[] = []
  httpsMock.request.mockImplementation((options: Record<string, unknown>, cb: (res: unknown) => void) => {
    captured.push({ options })
    const req = new EventEmitter() as EventEmitter & { end: () => void }
    req.end = () => {
      if (opts.error) {
        req.emit("error", opts.error)
        return
      }
      cb(opts.response)
      for (const chunk of opts.chunks ?? []) opts.response.emit("data", Buffer.from(chunk))
      opts.response.emit("end")
    }
    return req
  })
  return captured
}

beforeEach(() => {
  httpsMock.request.mockReset()
})

describe("pinnedHttpsFetch", () => {
  it("pins the address while keeping the hostname for SNI and Host", async () => {
    const response = makeResponse({})
    const captured = install({ response })
    const signal = new AbortController().signal

    await pinnedHttpsFetch("example.com", "203.0.113.9")(
      "https://example.com/api/thing?x=1",
      { headers: { "x-test": "yes" }, signal },
    )

    expect(captured[0]?.options).toMatchObject({
      host: "203.0.113.9",
      servername: "example.com",
      port: 443,
      path: "/api/thing?x=1",
      method: "GET",
      rejectUnauthorized: true,
      signal,
      headers: { "x-test": "yes", Host: "example.com" },
    })
  })

  it("uses the URL port when present and passes the method through", async () => {
    const response = makeResponse({})
    const captured = install({ response })
    await pinnedHttpsFetch("example.com", "203.0.113.9")(
      "https://example.com:8443/path",
      { method: "POST" },
    )
    expect(captured[0]?.options).toMatchObject({
      host: "203.0.113.9",
      port: 8443,
      path: "/path",
      method: "POST",
    })
  })

  it("maps a 2xx response including headers, text and json", async () => {
    const response = makeResponse({
      statusCode: 201,
      headers: { "content-type": ["application/json", "charset=utf-8"], "x-one": "v" },
    })
    install({ response, chunks: ['{"a":', "1}"] })

    const res = await pinnedHttpsFetch("example.com", "203.0.113.9")("https://example.com/")

    expect(res.status).toBe(201)
    expect(res.ok).toBe(true)
    expect(res.headers.get("Content-Type")).toBe("application/json,charset=utf-8")
    expect(res.headers.get("X-ONE")).toBe("v")
    expect(res.headers.get("x-missing")).toBeNull()
    expect(await res.text()).toBe('{"a":1}')
    expect(await res.json()).toEqual({ a: 1 })
  })

  it("marks a non-2xx response as not ok", async () => {
    const response = makeResponse({ statusCode: 404 })
    install({ response })
    const res = await pinnedHttpsFetch("example.com", "203.0.113.9")("https://example.com/")
    expect(res.status).toBe(404)
    expect(res.ok).toBe(false)
  })

  it("rejects when the request emits an error", async () => {
    const response = makeResponse({})
    install({ response, error: new Error("tls handshake failed") })
    await expect(
      pinnedHttpsFetch("example.com", "203.0.113.9")("https://example.com/"),
    ).rejects.toThrow("tls handshake failed")
  })
})
