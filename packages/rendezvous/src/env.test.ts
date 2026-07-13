import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { loadEnvConfig, type RendezvousEnvConfig } from "./env.js"

describe("loadEnvConfig", () => {
  const originalEnv = process.env

  beforeEach(() => {
    // Clear relevant env vars before each test
    delete process.env.RENDEZVOUS_PORT
    delete process.env.RENDEZVOUS_HOST
    delete process.env.RENDEZVOUS_PATH
    delete process.env.RENDEZVOUS_PARK_TIMEOUT_MS
    delete process.env.RENDEZVOUS_IDLE_TIMEOUT_MS
    delete process.env.RENDEZVOUS_MAX_MESSAGE_BYTES
    delete process.env.RENDEZVOUS_RATE_LIMIT_MAX
    delete process.env.RENDEZVOUS_RATE_LIMIT_WINDOW_MS
    delete process.env.RENDEZVOUS_DEBUG
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it("returns defaults when no env vars are set", () => {
    const config = loadEnvConfig()
    expect(config.port).toBe(8788)
    expect(config.host).toBe("0.0.0.0")
    expect(config.path).toBe("/v1")
    expect(config.parkTimeoutMs).toBe(120000)
    expect(config.idleTimeoutMs).toBe(900000)
    expect(config.maxMessageBytes).toBe(1048576)
    expect(config.rateLimitMax).toBe(120)
    expect(config.rateLimitWindowMs).toBe(60000)
    expect(config.debug).toBe(false)
  })

  it("parses RENDEZVOUS_PORT as integer", () => {
    process.env.RENDEZVOUS_PORT = "9090"
    const config = loadEnvConfig()
    expect(config.port).toBe(9090)
  })

  it("parses RENDEZVOUS_HOST", () => {
    process.env.RENDEZVOUS_HOST = "127.0.0.1"
    const config = loadEnvConfig()
    expect(config.host).toBe("127.0.0.1")
  })

  it("parses RENDEZVOUS_PATH", () => {
    process.env.RENDEZVOUS_PATH = "/ws"
    const config = loadEnvConfig()
    expect(config.path).toBe("/ws")
  })

  it("parses RENDEZVOUS_PARK_TIMEOUT_MS as integer", () => {
    process.env.RENDEZVOUS_PARK_TIMEOUT_MS = "60000"
    const config = loadEnvConfig()
    expect(config.parkTimeoutMs).toBe(60000)
  })

  it("parses RENDEZVOUS_IDLE_TIMEOUT_MS as integer", () => {
    process.env.RENDEZVOUS_IDLE_TIMEOUT_MS = "300000"
    const config = loadEnvConfig()
    expect(config.idleTimeoutMs).toBe(300000)
  })

  it("parses RENDEZVOUS_MAX_MESSAGE_BYTES as integer", () => {
    process.env.RENDEZVOUS_MAX_MESSAGE_BYTES = "2097152"
    const config = loadEnvConfig()
    expect(config.maxMessageBytes).toBe(2097152)
  })

  it("parses RENDEZVOUS_RATE_LIMIT_MAX as integer", () => {
    process.env.RENDEZVOUS_RATE_LIMIT_MAX = "60"
    const config = loadEnvConfig()
    expect(config.rateLimitMax).toBe(60)
  })

  it("parses RENDEZVOUS_RATE_LIMIT_WINDOW_MS as integer", () => {
    process.env.RENDEZVOUS_RATE_LIMIT_WINDOW_MS = "30000"
    const config = loadEnvConfig()
    expect(config.rateLimitWindowMs).toBe(30000)
  })

  it("parses RENDEZVOUS_DEBUG as boolean (true)", () => {
    process.env.RENDEZVOUS_DEBUG = "true"
    const config = loadEnvConfig()
    expect(config.debug).toBe(true)
  })

  it("parses RENDEZVOUS_DEBUG as boolean (1)", () => {
    process.env.RENDEZVOUS_DEBUG = "1"
    const config = loadEnvConfig()
    expect(config.debug).toBe(true)
  })

  it("parses RENDEZVOUS_DEBUG as boolean (false)", () => {
    process.env.RENDEZVOUS_DEBUG = "false"
    const config = loadEnvConfig()
    expect(config.debug).toBe(false)
  })

  it("parses RENDEZVOUS_DEBUG as boolean (0)", () => {
    process.env.RENDEZVOUS_DEBUG = "0"
    const config = loadEnvConfig()
    expect(config.debug).toBe(false)
  })

  it("ignores invalid integer values and uses defaults", () => {
    process.env.RENDEZVOUS_PORT = "not-a-number"
    process.env.RENDEZVOUS_PARK_TIMEOUT_MS = "invalid"
    const config = loadEnvConfig()
    expect(config.port).toBe(8788)
    expect(config.parkTimeoutMs).toBe(120000)
  })

  it("ignores negative values and uses defaults", () => {
    process.env.RENDEZVOUS_PORT = "-1"
    process.env.RENDEZVOUS_PARK_TIMEOUT_MS = "-100"
    const config = loadEnvConfig()
    expect(config.port).toBe(8788)
    expect(config.parkTimeoutMs).toBe(120000)
  })

  it("parses multiple env vars together", () => {
    process.env.RENDEZVOUS_PORT = "9090"
    process.env.RENDEZVOUS_HOST = "127.0.0.1"
    process.env.RENDEZVOUS_IDLE_TIMEOUT_MS = "600000"
    process.env.RENDEZVOUS_DEBUG = "true"

    const config = loadEnvConfig()
    expect(config.port).toBe(9090)
    expect(config.host).toBe("127.0.0.1")
    expect(config.idleTimeoutMs).toBe(600000)
    expect(config.debug).toBe(true)
    // Defaults should still apply for unset vars
    expect(config.parkTimeoutMs).toBe(120000)
    expect(config.maxMessageBytes).toBe(1048576)
  })
})
