/**
 * Tests for the typed env module — the ONE place `process.env` is read. Covers
 * the required-token guard, the endpoint / timeout defaults, and the projection
 * into an adapter config.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  gbrainDocEnvToConfig,
  loadGbrainDocKnowledgeEnv,
} from "../env.js"

const KEYS = [
  "GBRAIN_BEARER_TOKEN",
  "GBRAIN_ENDPOINT",
  "GBRAIN_HTTP_TIMEOUT_MS",
] as const

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe("loadGbrainDocKnowledgeEnv", () => {
  it("throws when GBRAIN_BEARER_TOKEN is absent", () => {
    expect(() => loadGbrainDocKnowledgeEnv()).toThrow(
      /GBRAIN_BEARER_TOKEN is required/,
    )
  })

  it("applies defaults for endpoint + timeout", () => {
    process.env.GBRAIN_BEARER_TOKEN = "gbrain_at_test"
    expect(loadGbrainDocKnowledgeEnv()).toEqual({
      endpoint: "http://127.0.0.1:3132",
      bearerToken: "gbrain_at_test",
      timeoutMs: 45_000,
    })
  })

  it("reads every override", () => {
    process.env.GBRAIN_BEARER_TOKEN = "gbrain_at_live"
    process.env.GBRAIN_ENDPOINT = "https://gbrain.example:8443"
    process.env.GBRAIN_HTTP_TIMEOUT_MS = "10000"
    expect(loadGbrainDocKnowledgeEnv()).toEqual({
      endpoint: "https://gbrain.example:8443",
      bearerToken: "gbrain_at_live",
      timeoutMs: 10_000,
    })
  })

  it("treats blank/whitespace vars as unset (falls back to defaults)", () => {
    process.env.GBRAIN_BEARER_TOKEN = "gbrain_at_test"
    process.env.GBRAIN_ENDPOINT = "   "
    process.env.GBRAIN_HTTP_TIMEOUT_MS = "not-a-number"
    const env = loadGbrainDocKnowledgeEnv()
    expect(env.endpoint).toBe("http://127.0.0.1:3132")
    expect(env.timeoutMs).toBe(45_000)
  })

  it("treats a blank token as absent (throws)", () => {
    process.env.GBRAIN_BEARER_TOKEN = "   "
    expect(() => loadGbrainDocKnowledgeEnv()).toThrow(
      /GBRAIN_BEARER_TOKEN is required/,
    )
  })
})

describe("gbrainDocEnvToConfig", () => {
  it("projects the env verbatim into an adapter config", () => {
    process.env.GBRAIN_BEARER_TOKEN = "gbrain_at_test"
    process.env.GBRAIN_ENDPOINT = "https://gbrain.example:8443"
    const config = gbrainDocEnvToConfig(loadGbrainDocKnowledgeEnv())
    expect(config).toEqual({
      endpoint: "https://gbrain.example:8443",
      bearerToken: "gbrain_at_test",
      timeoutMs: 45_000,
    })
  })
})
