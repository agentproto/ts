import { describe, expect, it } from "vitest"
import { loadConfigFromEnv } from "./config.js"

const BASE_ENV = {
  AGENTPROTO_RELAY_TARGET_SESSION: "my-session",
  AGENTPROTO_RELAY_TOKEN: "secret-token",
}

describe("loadConfigFromEnv", () => {
  it("throws when AGENTPROTO_RELAY_TARGET_SESSION is missing", () => {
    expect(() => loadConfigFromEnv({ AGENTPROTO_RELAY_TOKEN: "x" })).toThrow(
      /AGENTPROTO_RELAY_TARGET_SESSION/,
    )
  })

  it("throws when AGENTPROTO_RELAY_TARGET_SESSION is blank", () => {
    expect(() =>
      loadConfigFromEnv({ AGENTPROTO_RELAY_TARGET_SESSION: "   ", AGENTPROTO_RELAY_TOKEN: "x" }),
    ).toThrow(/AGENTPROTO_RELAY_TARGET_SESSION/)
  })

  it("throws when AGENTPROTO_RELAY_TOKEN is missing", () => {
    expect(() =>
      loadConfigFromEnv({ AGENTPROTO_RELAY_TARGET_SESSION: "s" }),
    ).toThrow(/AGENTPROTO_RELAY_TOKEN/)
  })

  it("throws when AGENTPROTO_RELAY_TOKEN is empty string", () => {
    expect(() =>
      loadConfigFromEnv({ AGENTPROTO_RELAY_TARGET_SESSION: "s", AGENTPROTO_RELAY_TOKEN: "" }),
    ).toThrow(/AGENTPROTO_RELAY_TOKEN/)
  })

  it("rejects an invalid AGENTPROTO_RELAY_TARGET_VIA", () => {
    expect(() =>
      loadConfigFromEnv({ ...BASE_ENV, AGENTPROTO_RELAY_TARGET_VIA: "carrier-pigeon" }),
    ).toThrow(/AGENTPROTO_RELAY_TARGET_VIA/)
  })

  it("applies defaults when optional vars are unset", () => {
    const config = loadConfigFromEnv(BASE_ENV)
    expect(config).toEqual({
      targetSession: "my-session",
      targetVia: "agent",
      token: "secret-token",
      daemonUrl: "http://127.0.0.1:18790",
      rateLimit: { max: 20, windowMs: 60_000 },
    })
  })

  it("accepts targetVia=terminal", () => {
    const config = loadConfigFromEnv({ ...BASE_ENV, AGENTPROTO_RELAY_TARGET_VIA: "terminal" })
    expect(config.targetVia).toBe("terminal")
  })

  it("strips a trailing slash from AGENTPROTO_DAEMON_URL", () => {
    const config = loadConfigFromEnv({
      ...BASE_ENV,
      AGENTPROTO_DAEMON_URL: "http://example.com:1234/",
    })
    expect(config.daemonUrl).toBe("http://example.com:1234")
  })

  it("parses custom rate limit settings", () => {
    const config = loadConfigFromEnv({
      ...BASE_ENV,
      AGENTPROTO_RELAY_RATE_LIMIT: "5",
      AGENTPROTO_RELAY_RATE_WINDOW_MS: "1000",
    })
    expect(config.rateLimit).toEqual({ max: 5, windowMs: 1000 })
  })

  it("falls back to defaults for invalid rate limit settings", () => {
    const config = loadConfigFromEnv({
      ...BASE_ENV,
      AGENTPROTO_RELAY_RATE_LIMIT: "not-a-number",
      AGENTPROTO_RELAY_RATE_WINDOW_MS: "-5",
    })
    expect(config.rateLimit).toEqual({ max: 20, windowMs: 60_000 })
  })
})
