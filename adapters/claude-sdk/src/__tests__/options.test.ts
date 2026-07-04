import { describe, expect, it } from "vitest"
import { buildQueryOptions, DEFAULT_MODEL, type ClaudeSdkConfig } from "../options.js"

/** Build options with a controlled (empty) base env so assertions on injected
 *  vars don't inherit anything from the test process's `process.env`. */
function build(config: ClaudeSdkConfig): ReturnType<typeof buildQueryOptions> {
  return buildQueryOptions({
    config,
    abortController: new AbortController(),
    env: {},
  })
}

/** The five internal model tiers the harness may request; a single-model
 *  gateway can only serve one, so gateway mode pins them all. */
const TIER_VARS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
]

describe("buildQueryOptions — auth_token", () => {
  it("injects ANTHROPIC_AUTH_TOKEN from auth_token", () => {
    const opts = build({ authToken: "sk-moonshot-secret" })
    expect(opts.env?.ANTHROPIC_AUTH_TOKEN).toBe("sk-moonshot-secret")
  })

  it("leaves ANTHROPIC_AUTH_TOKEN unset when auth_token is absent", () => {
    expect(build({}).env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })
})

describe("buildQueryOptions — gateway model-tier pinning", () => {
  it("pins every tier to the resolved model when base_url is set", () => {
    const opts = build({
      model: "kimi-k2.7-code",
      baseUrl: "https://api.moonshot.ai/anthropic",
    })
    expect(opts.env?.ANTHROPIC_BASE_URL).toBe("https://api.moonshot.ai/anthropic")
    for (const v of TIER_VARS) expect(opts.env?.[v]).toBe("kimi-k2.7-code")
  })

  it("pins tiers to DEFAULT_MODEL when base_url is set but model is omitted", () => {
    const opts = build({ baseUrl: "https://openrouter.ai/api/v1" })
    for (const v of TIER_VARS) expect(opts.env?.[v]).toBe(DEFAULT_MODEL)
  })

  it("leaves tier routing untouched in native mode (no base_url)", () => {
    const opts = build({ model: "claude-opus-4-8" })
    expect(opts.env?.ANTHROPIC_BASE_URL).toBeUndefined()
    for (const v of TIER_VARS) expect(opts.env?.[v]).toBeUndefined()
    // Native mode still pins the primary SDK model, just not the env tiers.
    expect(opts.model).toBe("claude-opus-4-8")
  })
})

describe("buildQueryOptions — thinking", () => {
  it("enables extended thinking as { type: 'enabled' } when set", () => {
    expect(build({ thinking: true }).thinking).toEqual({ type: "enabled" })
  })

  it("leaves options.thinking unset by default", () => {
    expect(build({}).thinking).toBeUndefined()
  })
})
