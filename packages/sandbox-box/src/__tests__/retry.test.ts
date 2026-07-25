import { describe, it, expect, vi } from "vitest"

const { boxApiMock, boxApiCtorMock, configCtorMock } = vi.hoisted(() => {
  const boxApiMock = {
    create: vi.fn(),
    get: vi.fn(),
    resume: vi.fn(),
    command: vi.fn(async () => ({})),
    remove: vi.fn(async () => ({})),
    stop: vi.fn(async () => ({})),
  }
  return {
    boxApiMock,
    boxApiCtorMock: vi.fn(() => boxApiMock),
    configCtorMock: vi.fn((opts: unknown) => opts),
  }
})

vi.mock("@asciidev/box-sdk", () => ({
  BoxApi: boxApiCtorMock,
  Configuration: configCtorMock,
}))

describe("withBoxRetry", () => {
  it("retries a transient failure (network timeout) and resolves once the call succeeds", async () => {
    const { withBoxRetry } = await import("../provider.js")
    let calls = 0
    const fn = vi.fn(async () => {
      calls++
      if (calls < 3) {
        throw new Error("could not reach the Box API at https://ascii.dev: operation timed out")
      }
      return "ok"
    })

    const result = await withBoxRetry(fn, { baseDelayMs: 0 })

    expect(result).toBe("ok")
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it("does not retry a terminal error (404 ResponseError) and throws immediately", async () => {
    const { withBoxRetry } = await import("../provider.js")
    const notFound = Object.assign(new Error("Response returned an error code"), {
      name: "ResponseError",
      response: { status: 404 },
    })
    const fn = vi.fn(async () => {
      throw notFound
    })

    await expect(withBoxRetry(fn, { baseDelayMs: 0 })).rejects.toBe(notFound)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("throws the last error once every attempt is transient and the cap is reached", async () => {
    const { withBoxRetry } = await import("../provider.js")
    const timeouts = [
      new Error("could not reach the Box API at https://ascii.dev: operation timed out (1)"),
      new Error("could not reach the Box API at https://ascii.dev: operation timed out (2)"),
      new Error("could not reach the Box API at https://ascii.dev: operation timed out (3)"),
    ]
    let calls = 0
    const fn = vi.fn(async () => {
      throw timeouts[calls++]
    })

    await expect(withBoxRetry(fn, { attempts: 3, baseDelayMs: 0 })).rejects.toBe(timeouts[2])
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it("retries on a box-sdk FetchError (network-level failure) and on 5xx/429 ResponseErrors", async () => {
    const { withBoxRetry } = await import("../provider.js")

    const fetchError = Object.assign(new Error("The request failed"), { name: "FetchError", cause: new Error("ECONNRESET") })
    let calls = 0
    const fn = vi.fn(async () => {
      calls++
      if (calls === 1) throw fetchError
      return "ok"
    })
    await expect(withBoxRetry(fn, { baseDelayMs: 0 })).resolves.toBe("ok")
    expect(fn).toHaveBeenCalledTimes(2)

    const serverError = Object.assign(new Error("Response returned an error code"), {
      name: "ResponseError",
      response: { status: 503 },
    })
    let calls2 = 0
    const fn2 = vi.fn(async () => {
      calls2++
      if (calls2 === 1) throw serverError
      return "ok"
    })
    await expect(withBoxRetry(fn2, { baseDelayMs: 0 })).resolves.toBe("ok")
    expect(fn2).toHaveBeenCalledTimes(2)
  })

  it("does not retry other 4xx ResponseErrors (e.g. 400)", async () => {
    const { withBoxRetry } = await import("../provider.js")
    const badRequest = Object.assign(new Error("Response returned an error code"), {
      name: "ResponseError",
      response: { status: 400 },
    })
    const fn = vi.fn(async () => {
      throw badRequest
    })

    await expect(withBoxRetry(fn, { baseDelayMs: 0 })).rejects.toBe(badRequest)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
