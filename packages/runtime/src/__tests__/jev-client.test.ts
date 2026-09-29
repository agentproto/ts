/**
 * The minimal Jev client (ported from openagentik's jev-judge adapter) and
 * the session-steward's `judgeSessionWithJev` on top of it — all over an
 * injected fetch, no network.
 */

import { afterEach, describe, it, expect, vi } from "vitest"
import { callJevSystemOne, judgeSessionWithJev, resolveJevApiKey, resolveJevConfig, setJevConfigLoader } from "../jev-client.js"
import { setMcpCredentialDeps } from "../mcp-credential-deps.js"

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const noSleep = async () => {}

describe("callJevSystemOne", () => {
  it("posts model/state/questions with a bearer key and parses each answer", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ model: "jev-latest", answers: { q: { type: "choice", choice: "A", probabilities: { A: 0.8, B: 0.2 } }, bad: { type: "choice" } } }),
    )
    const out = await callJevSystemOne({ x: 1 }, { q: { type: "choice", instructions: "pick", criteria: { A: "a", B: "b" } } }, {
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://api.typesafe.ai/v1/systemone")
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k")
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "jev-latest", state: { x: 1 } })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.answers.q).toMatchObject({ choice: "A", probabilities: { A: 0.8, B: 0.2 } })
    expect(out.answers.bad).toBeUndefined()
    expect(out.answerErrors?.bad).toBeDefined()
  })

  it("retries a transient status with backoff, honouring Retry-After, then succeeds", async () => {
    const sleeps: number[] = []
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(json({ answers: {} }))
    const out = await callJevSystemOne({}, {}, {
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async ms => {
        sleeps.push(ms)
      },
    })
    expect(out.ok).toBe(true)
    expect(sleeps).toEqual([2000])
  })

  it("never retries a 4xx caller error and never throws on a transport failure", async () => {
    const unauthorized = vi.fn(async () => new Response("nope", { status: 401 }))
    const out = await callJevSystemOne({}, {}, { apiKey: "k", fetchImpl: unauthorized as unknown as typeof fetch, sleep: noSleep })
    expect(unauthorized).toHaveBeenCalledTimes(1)
    expect(out).toEqual({ ok: false, error: "401 nope" })

    const broken = vi.fn(async () => {
      throw new Error("ECONNRESET")
    })
    const out2 = await callJevSystemOne({}, {}, { apiKey: "k", fetchImpl: broken as unknown as typeof fetch })
    expect(out2).toEqual({ ok: false, error: "request failed — ECONNRESET" })
  })
})

describe("judgeSessionWithJev", () => {
  const answer = (a: unknown) => vi.fn(async () => json({ answers: { verdict: a } })) as unknown as typeof fetch

  it("maps a choice answer to verdict + confidence = probabilities[choice]", async () => {
    const out = await judgeSessionWithJev({
      sessionId: "s1",
      evidence: { sessionId: "s1" },
      apiKey: "k",
      fetchImpl: answer({ type: "choice", choice: "blocked", probabilities: { blocked: 0.7, active: 0.3 } }),
    })
    expect(out).toEqual({ ok: true, sessionId: "s1", verdict: "blocked", confidence: 0.7, probabilities: { blocked: 0.7, active: 0.3 }, model: "jev-latest" })
  })

  it("prefers the answer's own confidence when present", async () => {
    const out = await judgeSessionWithJev({
      sessionId: "s1",
      evidence: {},
      apiKey: "k",
      fetchImpl: answer({ type: "choice", choice: "done", confidence: 0.88, probabilities: { done: 0.9 } }),
    })
    expect(out).toMatchObject({ ok: true, confidence: 0.88 })
  })

  it("fails (never a verdict) on an unknown choice, no usable confidence, a missing answer, or a 5xx", async () => {
    const cases: Array<[typeof fetch, RegExp]> = [
      [answer({ type: "choice", choice: "maybe", probabilities: { maybe: 1 } }), /unknown verdict choice/],
      [answer({ type: "choice", choice: "done", probabilities: {} }), /no usable confidence/],
      [answer({ type: "score", score: 1 }), /missing a valid verdict answer/],
      [vi.fn(async () => new Response("down", { status: 503 })) as unknown as typeof fetch, /^503/],
    ]
    for (const [fetchImpl, error] of cases) {
      const out = await judgeSessionWithJev({ sessionId: "s1", evidence: {}, apiKey: "k", fetchImpl, sleep: noSleep })
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.error).toMatch(error)
    }
  })

  it("no key → noKey, without any network call", async () => {
    const fetchImpl = vi.fn()
    const out = await judgeSessionWithJev({ sessionId: "s1", evidence: {}, apiKey: null, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(out).toMatchObject({ ok: false, noKey: true })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe("resolveJevApiKey", () => {
  afterEach(() => {
    setMcpCredentialDeps({})
    setJevConfigLoader(async () => ({}))
  })

  it("config jev.apiKey wins over everything (trimmed)", async () => {
    setJevConfigLoader(async () => ({ jev: { apiKey: " from-config " } }))
    setMcpCredentialDeps({ resolveSandboxSecret: async slug => (slug === "JEV_API_KEY" ? "from-broker" : null) })
    expect(await resolveJevApiKey({ JEV_API_KEY: "from-env" })).toBe("from-config")
    expect(await resolveJevApiKey({})).toBe("from-config")
  })

  it("env beats the host secret resolver", async () => {
    setMcpCredentialDeps({ resolveSandboxSecret: async slug => (slug === "JEV_API_KEY" ? "from-broker" : null) })
    expect(await resolveJevApiKey({ JEV_API_KEY: "from-env" })).toBe("from-env")
    expect(await resolveJevApiKey({})).toBe("from-broker")
  })

  it("env fallback when the config has no key; host resolver last; null when nothing", async () => {
    setJevConfigLoader(async () => ({ jev: {} }))
    setMcpCredentialDeps({ resolveSandboxSecret: async slug => (slug === "JEV_API_KEY" ? "from-broker" : null) })
    expect(await resolveJevApiKey({ JEV_API_KEY: "from-env" })).toBe("from-env")
    expect(await resolveJevApiKey({})).toBe("from-broker")
    setMcpCredentialDeps({})
    expect(await resolveJevApiKey({})).toBeNull()
  })

  it("unreadable config falls through to the env var", async () => {
    setJevConfigLoader(async () => {
      throw new Error("no config")
    })
    expect(await resolveJevApiKey({ JEV_API_KEY: "from-env" })).toBe("from-env")
  })
})

describe("resolveJevConfig", () => {
  afterEach(() => setJevConfigLoader(async () => ({})))

  it("trims and passes through model/baseUrl; omits blank/missing fields; survives a throwing loader", async () => {
    setJevConfigLoader(async () => ({ jev: { model: " jev-2 ", baseUrl: " https://x ", apiKey: " " } }))
    expect(await resolveJevConfig()).toEqual({ model: "jev-2", baseUrl: "https://x" })
    setJevConfigLoader(async () => ({}))
    expect(await resolveJevConfig()).toEqual({})
    setJevConfigLoader(async () => {
      throw new Error("nope")
    })
    expect(await resolveJevConfig()).toEqual({})
  })
})
